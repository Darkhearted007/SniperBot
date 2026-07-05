const { SolanaLogsSubscriber } = require('../live/solanaLogsSubscriber');
const { rpcRequest } = require('../live/solanaRpcClient');
const {
  NATIVE_SOL_MINT,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID
} = require('../live/constants');

const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_MAX_CANDIDATE_AGE_MS = 30 * 60 * 1000;

// Log substrings that indicate a new-pool / new-token-launch instruction on
// each venue's program. These are heuristics on human-readable program logs
// rather than a binary instruction-discriminator decode, so they're the
// first thing to check if a venue upgrades its program and discovery stops
// firing.
const POOL_CREATION_LOG_MARKERS = {
  [RAYDIUM_AMM_V4_PROGRAM_ID]: ['initialize2', 'Initialize2'],
  [RAYDIUM_CPMM_PROGRAM_ID]: ['Instruction: Initialize'],
  [PUMP_FUN_PROGRAM_ID]: ['Instruction: Create']
};

const KNOWN_QUOTE_MINTS = new Set([
  NATIVE_SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' // USDT
]);

function venueForProgram(programId) {
  if (programId === RAYDIUM_AMM_V4_PROGRAM_ID || programId === RAYDIUM_CPMM_PROGRAM_ID) {
    return 'solana/raydium';
  }
  if (programId === PUMP_FUN_PROGRAM_ID) {
    return 'solana/pump.fun';
  }
  return 'solana/unknown';
}

function matchesCreationLog(programId, logs) {
  const markers = POOL_CREATION_LOG_MARKERS[programId];
  if (!markers) return false;
  return logs.some((line) => markers.some((marker) => line.includes(marker)));
}

/**
 * Diffs pre/post token balances on a confirmed transaction to find mints
 * that appear only in postTokenBalances (i.e. a token account for that mint
 * was created or funded during this transaction). This is more robust than
 * decoding instruction accounts by position, since account ordering varies
 * across program versions.
 */
function findNewMintsFromBalances(meta) {
  const preMints = new Set((meta?.preTokenBalances || []).map((b) => b.mint));
  const postBalances = meta?.postTokenBalances || [];
  const seen = new Map();
  for (const balance of postBalances) {
    if (!balance.mint || KNOWN_QUOTE_MINTS.has(balance.mint) || seen.has(balance.mint)) continue;
    if (preMints.has(balance.mint)) continue;
    seen.set(balance.mint, {
      mint: balance.mint,
      decimals: balance.uiTokenAmount?.decimals ?? null
    });
  }
  return [...seen.values()];
}

/**
 * Watches Raydium (AMM v4 + CPMM) and Pump.fun program logs in real time for
 * new pool/token creation, then surfaces newly seen mints as watchlist-shaped
 * candidates that SolanaWatchlistFeed can rank alongside (or instead of) a
 * hand-maintained SOLANA_AUTO_WATCHLIST_JSON.
 *
 * Discovered candidates start with a conservative rugScore of 1 (maximum
 * risk) — the real risk determination happens later via
 * SolanaSafetyProvider/runDeepSafetyChecks before any entry is placed. This
 * feed's job is purely "what's new", not "what's safe".
 */
class PoolDiscoveryFeed {
  constructor({
    wsUrl,
    rpcUrl,
    fetchImpl = fetch,
    programIds = [RAYDIUM_AMM_V4_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, PUMP_FUN_PROGRAM_ID],
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxCandidateAgeMs = DEFAULT_MAX_CANDIDATE_AGE_MS,
    logsSubscriberFactory = (options) => new SolanaLogsSubscriber(options),
    onCandidate = () => {},
    onError = () => {},
    onStatus = () => {}
  }) {
    this.wsUrl = wsUrl;
    this.rpcUrl = rpcUrl;
    this.fetchImpl = fetchImpl;
    this.programIds = programIds;
    this.maxCandidates = maxCandidates;
    this.maxCandidateAgeMs = maxCandidateAgeMs;
    this.logsSubscriberFactory = logsSubscriberFactory;
    this.onCandidate = onCandidate;
    this.onError = onError;
    this.onStatus = onStatus;
    this.candidates = new Map(); // mint -> watchlist-shaped candidate
    this.subscriber = null;
  }

  start() {
    this.subscriber = this.logsSubscriberFactory({
      wsUrl: this.wsUrl,
      programIds: this.programIds,
      onLogs: (event) => this.handleLogs(event).catch((error) => this.onError(error)),
      onError: this.onError,
      onStatus: this.onStatus
    });
    this.subscriber.start();
    return this;
  }

  stop() {
    if (this.subscriber) {
      this.subscriber.stop();
      this.subscriber = null;
    }
  }

  async handleLogs({ programId, signature, logs, err }) {
    if (err) return;
    if (!matchesCreationLog(programId, logs)) return;

    const txResult = await rpcRequest(this.fetchImpl, this.rpcUrl, 'getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
    ]);
    if (!txResult) return;

    const newMints = findNewMintsFromBalances(txResult.meta);
    const venue = venueForProgram(programId);
    for (const { mint, decimals } of newMints) {
      if (decimals == null || decimals > 18) continue;
      this.addCandidate({ mint, decimals, venue, signature });
    }
  }

  addCandidate({ mint, decimals, venue, signature }) {
    if (this.candidates.has(mint)) return;
    this.evictStaleCandidates();
    if (this.candidates.size >= this.maxCandidates) {
      // Evict the oldest candidate to make room (Maps preserve insertion order).
      const oldestKey = this.candidates.keys().next().value;
      this.candidates.delete(oldestKey);
    }

    const shortMint = `${mint.slice(0, 4)}..${mint.slice(-4)}`;
    const candidate = {
      symbol: shortMint,
      tokenName: `New listing ${shortMint}`,
      tokenCategory: 'newly-discovered',
      pair: `SOL/${shortMint}`,
      venue,
      inputMint: NATIVE_SOL_MINT,
      outputMint: mint,
      decimals,
      // Unknown at discovery time; conservative defaults keep the token out
      // of entries until the safety pipeline and live quote data confirm it.
      liquidityUsd: 0,
      rugScore: 1,
      baselineMomentumScore: 0.5,
      volatilityRisk: null,
      discoveredAt: Date.now(),
      discoverySignature: signature
    };
    this.candidates.set(mint, candidate);
    this.onCandidate(candidate);
  }

  evictStaleCandidates() {
    const cutoff = Date.now() - this.maxCandidateAgeMs;
    for (const [mint, candidate] of this.candidates) {
      if (candidate.discoveredAt < cutoff) {
        this.candidates.delete(mint);
      }
    }
  }

  getCandidates() {
    this.evictStaleCandidates();
    return [...this.candidates.values()];
  }
}

module.exports = { PoolDiscoveryFeed, findNewMintsFromBalances, matchesCreationLog };
