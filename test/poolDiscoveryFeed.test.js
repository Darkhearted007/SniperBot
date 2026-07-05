const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PoolDiscoveryFeed,
  findNewMintsFromBalances,
  matchesCreationLog
} = require('../src/market/poolDiscoveryFeed');
const { RAYDIUM_AMM_V4_PROGRAM_ID, PUMP_FUN_PROGRAM_ID, NATIVE_SOL_MINT } = require('../src/live/constants');
const { SolanaWatchlistFeed } = require('../src/market/solanaWatchlistFeed');

test('matchesCreationLog detects Raydium initialize2 and Pump.fun Create instructions', () => {
  assert.equal(matchesCreationLog(RAYDIUM_AMM_V4_PROGRAM_ID, ['Program log: ray_log', 'Program log: initialize2: something']), true);
  assert.equal(matchesCreationLog(PUMP_FUN_PROGRAM_ID, ['Program log: Instruction: Create']), true);
  assert.equal(matchesCreationLog(RAYDIUM_AMM_V4_PROGRAM_ID, ['Program log: Swap']), false);
});

test('findNewMintsFromBalances returns only mints absent from preTokenBalances', () => {
  const meta = {
    preTokenBalances: [
      { mint: 'existing-mint', uiTokenAmount: { decimals: 6 } }
    ],
    postTokenBalances: [
      { mint: 'existing-mint', uiTokenAmount: { decimals: 6 } },
      { mint: 'brand-new-mint', uiTokenAmount: { decimals: 9 } },
      { mint: NATIVE_SOL_MINT, uiTokenAmount: { decimals: 9 } }
    ]
  };
  const newMints = findNewMintsFromBalances(meta);
  assert.equal(newMints.length, 1);
  assert.equal(newMints[0].mint, 'brand-new-mint');
  assert.equal(newMints[0].decimals, 9);
});

test('PoolDiscoveryFeed surfaces a new candidate when a creation log resolves to a fresh mint', async () => {
  const rpcCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    rpcCalls.push(body.method);
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            meta: {
              preTokenBalances: [],
              postTokenBalances: [
                { mint: 'new-token-mint', uiTokenAmount: { decimals: 6 } }
              ]
            }
          }
        };
      }
    };
  };

  const discovered = [];
  const feed = new PoolDiscoveryFeed({
    wsUrl: 'wss://example.invalid',
    rpcUrl: 'https://rpc.example',
    fetchImpl,
    programIds: [PUMP_FUN_PROGRAM_ID],
    logsSubscriberFactory: (options) => ({
      start() {
        options.onLogs({
          programId: PUMP_FUN_PROGRAM_ID,
          signature: 'sig-1',
          logs: ['Program log: Instruction: Create'],
          err: null
        });
      },
      stop() {}
    }),
    onCandidate: (candidate) => discovered.push(candidate)
  });

  feed.start();
  // handleLogs is async; let its microtasks flush.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].outputMint, 'new-token-mint');
  assert.equal(discovered[0].decimals, 6);
  assert.equal(discovered[0].venue, 'solana/pump.fun');
  assert.equal(discovered[0].rugScore, 1);

  const candidates = feed.getCandidates();
  assert.equal(candidates.length, 1);
  assert.ok(rpcCalls.includes('getTransaction'));
});

test('PoolDiscoveryFeed evicts candidates older than maxCandidateAgeMs', () => {
  const feed = new PoolDiscoveryFeed({
    wsUrl: 'wss://example.invalid',
    rpcUrl: 'https://rpc.example',
    maxCandidateAgeMs: 10
  });
  feed.addCandidate({ mint: 'stale-mint', decimals: 6, venue: 'solana/pump.fun', signature: 'sig' });
  const first = feed.candidates.get('stale-mint');
  first.discoveredAt = Date.now() - 1000;
  const candidates = feed.getCandidates();
  assert.equal(candidates.length, 0);
});

test('PoolDiscoveryFeed caps candidate count via maxCandidates eviction', () => {
  const feed = new PoolDiscoveryFeed({
    wsUrl: 'wss://example.invalid',
    rpcUrl: 'https://rpc.example',
    maxCandidates: 2
  });
  feed.addCandidate({ mint: 'mint-a', decimals: 6, venue: 'solana/pump.fun', signature: 'sig-a' });
  feed.addCandidate({ mint: 'mint-b', decimals: 6, venue: 'solana/pump.fun', signature: 'sig-b' });
  feed.addCandidate({ mint: 'mint-c', decimals: 6, venue: 'solana/pump.fun', signature: 'sig-c' });
  const candidates = feed.getCandidates();
  assert.equal(candidates.length, 2);
  assert.equal(candidates.some((c) => c.outputMint === 'mint-a'), false);
});

test('SolanaWatchlistFeed merges dynamic pool-discovery candidates with static ones', async () => {
  const quotesByMint = {
    'mint-static': '10000000',
    'mint-dynamic': '20000000'
  };
  const fetchImpl = async (url) => {
    const inputMint = new URL(String(url)).searchParams.get('inputMint');
    return {
      ok: true,
      async text() {
        return JSON.stringify({ inAmount: '1000000', outAmount: quotesByMint[inputMint] });
      }
    };
  };

  const dynamicCandidateSource = {
    getCandidates() {
      return [{
        symbol: 'DYN',
        tokenName: 'Dynamic Token',
        tokenCategory: 'newly-discovered',
        pair: 'SOL/DYN',
        venue: 'solana/pump.fun',
        inputMint: NATIVE_SOL_MINT,
        outputMint: 'mint-dynamic',
        decimals: 6,
        liquidityUsd: 0,
        rugScore: 1,
        baselineMomentumScore: 0.5,
        volatilityRisk: null
      }];
    }
  };

  const feed = new SolanaWatchlistFeed({
    watchlist: [],
    watchlistCandidates: [{
      symbol: 'STATIC',
      tokenName: 'Static Token',
      tokenCategory: 'uncategorized',
      pair: 'SOL/STATIC',
      venue: 'solana/jupiter',
      inputMint: NATIVE_SOL_MINT,
      outputMint: 'mint-static',
      decimals: 6,
      liquidityUsd: 500000,
      rugScore: 0.1,
      baselineMomentumScore: 0.7,
      volatilityRisk: 0.1
    }],
    autoWatchlistSize: 5,
    fetchImpl,
    dynamicCandidateSource
  });

  const opportunities = await feed.list();
  const symbols = opportunities.map((o) => o.symbol).sort();
  assert.deepEqual(symbols, ['DYN', 'STATIC']);
});
