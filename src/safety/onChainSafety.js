const { rpcRequest } = require('../live/solanaRpcClient');
const { fetchJupiterQuote } = require('../live/jupiterClient');
const {
  KNOWN_BURN_ADDRESSES,
  KNOWN_LOCKER_PROGRAM_IDS,
  NATIVE_SOL_MINT
} = require('../live/constants');

const DEFAULT_CACHE_TTL_MS = 60_000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Decodes a base64 SPL mint account (standard 82-byte Token program layout)
 * far enough to read the mint/freeze authority option flags and supply.
 * Token-2022 mints include the same fields in the same leading offsets, so
 * this also works for accounts owned by the Token-2022 program.
 */
function parseMintAccount(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length < 82) {
    throw new Error('Mint account data is smaller than the expected SPL mint layout');
  }
  const mintAuthorityOption = buffer.readUInt32LE(0);
  const supply = buffer.readBigUInt64LE(36);
  const decimals = buffer.readUInt8(44);
  // Freeze authority option flag sits after mintAuthorityOption(4) + mintAuthority(32)
  // + supply(8) + decimals(1) + isInitialized(1) = offset 46.
  const freezeAuthorityOption = buffer.readUInt32LE(46);
  return {
    mintAuthorityActive: mintAuthorityOption === 1,
    freezeAuthorityActive: freezeAuthorityOption === 1,
    supply,
    decimals
  };
}

class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.entries.set(key, { value, storedAt: Date.now() });
  }
}

/**
 * Computes on-chain risk signals for a token: mint/freeze authority status,
 * holder concentration, LP lock/burn state, and a lightweight honeypot
 * (sell-side) simulation via Jupiter. Results are cached per-mint so a
 * live-trading cycle doesn't re-hit the RPC/quote API for tokens it already
 * evaluated recently.
 */
class SolanaSafetyProvider {
  constructor({
    rpcUrl,
    fetchImpl = fetch,
    quoteApiBase,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    burnAddresses = KNOWN_BURN_ADDRESSES,
    lockerProgramIds = KNOWN_LOCKER_PROGRAM_IDS,
    jupiterApiKey
  }) {
    this.rpcUrl = rpcUrl;
    this.fetchImpl = fetchImpl;
    this.quoteApiBase = quoteApiBase;
    this.burnAddresses = new Set(burnAddresses);
    this.lockerProgramIds = new Set(lockerProgramIds);
    this.cache = new TtlCache(cacheTtlMs);
    this.jupiterApiKey = jupiterApiKey;
  }

  async rpc(method, params) {
    return rpcRequest(this.fetchImpl, this.rpcUrl, method, params);
  }

  async checkMintAuthority(mint) {
    const result = await this.rpc('getAccountInfo', [mint, { encoding: 'base64' }]);
    if (!result?.value?.data?.[0]) {
      return { mintAuthorityActive: null, freezeAuthorityActive: null, error: 'mint-account-not-found' };
    }
    try {
      const parsed = parseMintAccount(result.value.data[0]);
      return {
        mintAuthorityActive: parsed.mintAuthorityActive,
        freezeAuthorityActive: parsed.freezeAuthorityActive
      };
    } catch (error) {
      return { mintAuthorityActive: null, freezeAuthorityActive: null, error: error.message };
    }
  }

  async checkHolderConcentration(mint, { topN = 10 } = {}) {
    const result = await this.rpc('getTokenLargestAccounts', [mint]);
    const accounts = result?.value || [];
    if (accounts.length === 0) {
      return { topHolderPct: null, holderSampleSize: 0, error: 'no-holder-data' };
    }
    const totalSampled = accounts.reduce((sum, acc) => sum + Number(acc.amount || 0), 0);
    const topSum = accounts
      .slice(0, topN)
      .reduce((sum, acc) => sum + Number(acc.amount || 0), 0);
    // getTokenLargestAccounts only returns up to 20 largest holders, not full
    // supply distribution, so this is a concentration signal among big
    // holders rather than a precise "% of total supply" figure.
    const topHolderPct = totalSampled > 0 ? clamp(topSum / totalSampled, 0, 1) : null;
    return { topHolderPct, holderSampleSize: accounts.length };
  }

  async checkLpLockOrBurn(lpMint) {
    if (!lpMint) {
      return { lpStatus: 'unknown', reason: 'no-lp-mint-configured' };
    }
    const result = await this.rpc('getTokenLargestAccounts', [lpMint]);
    const accounts = result?.value || [];
    if (accounts.length === 0) {
      return { lpStatus: 'unknown', reason: 'no-lp-holder-data' };
    }
    const totalSupply = accounts.reduce((sum, acc) => sum + Number(acc.amount || 0), 0);
    const largest = accounts[0];
    if (totalSupply <= 0) {
      return { lpStatus: 'burned', reason: 'lp-supply-zero' };
    }
    const largestOwnerAddress = largest.address;
    if (this.burnAddresses.has(largestOwnerAddress)) {
      return { lpStatus: 'burned', largestHolderPct: Number(largest.amount) / totalSupply };
    }

    const ownerInfo = await this.rpc('getAccountInfo', [largestOwnerAddress, { encoding: 'base64' }]);
    const owner = ownerInfo?.value?.owner;
    if (owner && this.lockerProgramIds.has(owner)) {
      return { lpStatus: 'locked', lockerProgram: owner, largestHolderPct: Number(largest.amount) / totalSupply };
    }

    return {
      lpStatus: 'unlocked',
      largestHolderPct: Number(largest.amount) / totalSupply,
      reason: 'largest-lp-holder-is-a-wallet-not-burn-or-locker'
    };
  }

  async checkHoneypot({ outputMint, inputMint = NATIVE_SOL_MINT, sellAmountRaw, slippageBps = 100 }) {
    if (!sellAmountRaw || sellAmountRaw === '0') {
      return { sellable: null, reason: 'no-sell-amount-available-yet' };
    }
    try {
      const reverseQuote = await fetchJupiterQuote({
        fetchImpl: this.fetchImpl,
        quoteApiBase: this.quoteApiBase,
        inputMint: outputMint,
        outputMint: inputMint,
        amount: String(sellAmountRaw),
        slippageBps,
        apiKey: this.jupiterApiKey
      });
      const outAmount = Number(reverseQuote?.outAmount || 0);
      if (!(outAmount > 0)) {
        return { sellable: false, reason: 'reverse-quote-returned-zero' };
      }
      const priceImpactPct = reverseQuote.priceImpactPct != null ? Number(reverseQuote.priceImpactPct) : null;
      return { sellable: true, priceImpactPct };
    } catch (error) {
      return { sellable: false, reason: `reverse-quote-failed: ${error.message}` };
    }
  }

  /**
   * Runs the full on-chain check set for a token, caching the combined
   * result for cacheTtlMs so repeated cycles don't re-fetch unless the
   * cache has expired.
   */
  async evaluate(opportunity, { sellAmountRaw = null } = {}) {
    const mint = opportunity.outputMint;
    const cacheKey = `${mint}:${opportunity.lpMint || 'no-lp'}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const [authority, holders, lpStatus, honeypot] = await Promise.all([
      this.checkMintAuthority(mint).catch((error) => ({ error: error.message })),
      this.checkHolderConcentration(mint).catch((error) => ({ error: error.message })),
      this.checkLpLockOrBurn(opportunity.lpMint).catch((error) => ({ error: error.message })),
      this.checkHoneypot({ outputMint: mint, sellAmountRaw }).catch((error) => ({ error: error.message }))
    ]);

    const result = { mint, authority, holders, lpStatus, honeypot, evaluatedAt: new Date().toISOString() };
    this.cache.set(cacheKey, result);
    return result;
  }
}

module.exports = { SolanaSafetyProvider, parseMintAccount };
