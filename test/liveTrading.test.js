const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLiveTradingConfig } = require('../src/live/config');
const { parseWalletSecretBytes } = require('../src/live/solanaRpcClient');
const { SolanaWatchlistFeed } = require('../src/market/solanaWatchlistFeed');
const { SolanaLiveExecutor } = require('../src/execution/solanaLiveExecutor');
const { LiveTradingBot } = require('../src/live/liveTradingBot');
const { TradeApprovalQueue } = require('../src/live/tradeApprovalQueue');

test('parseLiveTradingConfig parses live env and normalizes watchlist', () => {
  const config = parseLiveTradingConfig({
    TRADING_MODE: 'live',
    SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_WALLET_SECRET: Buffer.alloc(64, 7).toString('base64'),
    SOLANA_WATCHLIST_JSON: JSON.stringify([
      {
        // Placeholder mint for config-shape testing only.
        symbol: 'BONK',
        tokenName: 'Bonk',
        outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6YaB1pPB263yPB263',
        decimals: 5,
        liquidityUsd: 123456,
        rugScore: 0.2
      }
    ]),
    LIVE_SLIPPAGE_BPS: '75',
    LIVE_POLL_INTERVAL_MS: '12000',
    LIVE_MIN_SOL_RESERVE: '0.05',
    LIVE_MAX_BANKROLL_SOL: '1.25'
  });

  assert.equal(config.mode, 'live');
  assert.equal(config.rpcUrl, 'https://rpc.example');
  assert.equal(config.watchlist[0].pair, 'SOL/BONK');
  assert.equal(config.watchlist[0].venue, 'solana/jupiter');
  assert.equal(config.slippageBps, 75);
  assert.equal(config.pollIntervalMs, 12000);
  assert.equal(config.minSolReserve, 0.05);
  assert.equal(config.maxBankrollSol, 1.25);
});

test('parseLiveTradingConfig supports automated watchlists and supervised mode', () => {
  const config = parseLiveTradingConfig({
    TRADING_MODE: 'live',
    SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_WALLET_SECRET: Buffer.alloc(64, 7).toString('base64'),
    SOLANA_AUTO_WATCHLIST_JSON: JSON.stringify([
      {
        symbol: 'BONK',
        outputMint: 'mint-bonk',
        decimals: 5,
        liquidityUsd: 123456,
        rugScore: 0.2
      },
      {
        symbol: 'WIF',
        outputMint: 'mint-wif',
        decimals: 6,
        liquidityUsd: 654321,
        rugScore: 0.1
      }
    ]),
    LIVE_AUTO_WATCHLIST_SIZE: '1',
    LIVE_REQUIRE_SUPERVISION: 'true'
  });

  assert.equal(config.watchlist.length, 0);
  assert.equal(config.watchlistCandidates.length, 2);
  assert.equal(config.autoWatchlistSize, 1);
  assert.equal(config.supervisionMode, true);
});

test('parseLiveTradingConfig supports pool discovery without a static watchlist', () => {
  const config = parseLiveTradingConfig({
    TRADING_MODE: 'live',
    SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_WALLET_SECRET: Buffer.alloc(64, 7).toString('base64'),
    LIVE_POOL_DISCOVERY: 'true',
    SOLANA_WS_URL: 'wss://rpc.example',
    POOL_DISCOVERY_MAX_CANDIDATES: '10',
    LIVE_REQUIRE_ONCHAIN_SAFETY: 'true',
    SAFETY_CACHE_TTL_MS: '5000'
  });

  assert.equal(config.poolDiscoveryEnabled, true);
  assert.equal(config.wsUrl, 'wss://rpc.example');
  assert.equal(config.poolDiscoveryMaxCandidates, 10);
  assert.equal(config.requireOnChainSafety, true);
  assert.equal(config.safetyCacheTtlMs, 5000);
  assert.equal(config.watchlist.length, 0);
  assert.equal(config.watchlistCandidates.length, 0);
});

test('parseLiveTradingConfig requires SOLANA_WS_URL when pool discovery is enabled', () => {
  assert.throws(() => parseLiveTradingConfig({
    TRADING_MODE: 'live',
    SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_WALLET_SECRET: Buffer.alloc(64, 7).toString('base64'),
    LIVE_POOL_DISCOVERY: 'true'
  }), /SOLANA_WS_URL is required/);
});

test('parseLiveTradingConfig still requires a watchlist source without pool discovery', () => {
  assert.throws(() => parseLiveTradingConfig({
    TRADING_MODE: 'live',
    SOLANA_RPC_URL: 'https://rpc.example',
    SOLANA_WALLET_SECRET: Buffer.alloc(64, 7).toString('base64')
  }), /SOLANA_WATCHLIST_JSON or SOLANA_AUTO_WATCHLIST_JSON is required/);
});

test('parseWalletSecretBytes accepts 64-byte base64 and JSON array formats', () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
  const base64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(parseWalletSecretBytes(base64), bytes);
  assert.deepEqual(parseWalletSecretBytes(JSON.stringify(Array.from(bytes))), bytes);
});

test('SolanaWatchlistFeed converts Jupiter quotes into opportunities', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/quote\?/);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          inAmount: '1000000',
          outAmount: '15000000'
        });
      }
    };
  };

  const feed = new SolanaWatchlistFeed({
    watchlist: [{
      symbol: 'BONK',
      tokenName: 'Bonk',
      pair: 'SOL/BONK',
      venue: 'solana/jupiter',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'mint',
      decimals: 6,
      liquidityUsd: 500000,
      rugScore: 0.1,
      baselineMomentumScore: 0.7,
      volatilityRisk: 0.12
    }],
    fetchImpl
  });

  const [opportunity] = await feed.list();
  assert.equal(opportunity.pair, 'SOL/BONK');
  assert.equal(opportunity.price, 0.015);
  assert.equal(opportunity.momentumScore, 0.7);
  assert.equal(opportunity.volatilityRisk, 0.12);
});

test('SolanaWatchlistFeed auto-selects the highest-ranked candidates', async () => {
  const quotesByMint = {
    'mint-bonk': '15000000',
    'mint-wif': '9000000',
    'mint-pepe': '7000000'
  };
  const fetchImpl = async (url) => {
    const inputMint = new URL(String(url)).searchParams.get('inputMint');
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          inAmount: '1000000',
          outAmount: quotesByMint[inputMint]
        });
      }
    };
  };

  const feed = new SolanaWatchlistFeed({
    watchlist: [],
    watchlistCandidates: [
      {
        symbol: 'BONK',
        tokenName: 'Bonk',
        pair: 'SOL/BONK',
        venue: 'solana/jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-bonk',
        decimals: 6,
        liquidityUsd: 900000,
        rugScore: 0.05,
        baselineMomentumScore: 0.9,
        volatilityRisk: 0.1
      },
      {
        symbol: 'WIF',
        tokenName: 'Wif',
        pair: 'SOL/WIF',
        venue: 'solana/jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-wif',
        decimals: 6,
        liquidityUsd: 600000,
        rugScore: 0.15,
        baselineMomentumScore: 0.75,
        volatilityRisk: 0.12
      },
      {
        symbol: 'PEPE',
        tokenName: 'Pepe',
        pair: 'SOL/PEPE',
        venue: 'solana/jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'mint-pepe',
        decimals: 6,
        liquidityUsd: 250000,
        rugScore: 0.35,
        baselineMomentumScore: 0.55,
        volatilityRisk: 0.25
      }
    ],
    autoWatchlistSize: 2,
    fetchImpl
  });

  const opportunities = await feed.list();
  assert.equal(opportunities.length, 2);
  assert.deepEqual(feed.getActiveWatchlist().map((token) => token.symbol), ['BONK', 'WIF']);
});

test('SolanaLiveExecutor enter and exit update state from mocked Jupiter swaps', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/quote') && !options.method) {
      if (String(url).includes('inputMint=So11111111111111111111111111111111111111112')) {
        return {
          ok: true,
          async text() {
            return JSON.stringify({ inAmount: '100000000', outAmount: '5000000' });
          }
        };
      }
      return {
        ok: true,
        async text() {
          return JSON.stringify({ inAmount: '5000000', outAmount: '120000000' });
        }
      };
    }
    return {
      ok: true,
      async text() {
        return JSON.stringify({ swapTransaction: 'ZmFrZS10eA==' });
      }
    };
  };

  const client = {
    walletAddress: 'wallet-address',
    async getBalanceSol() {
      return 1.5;
    },
    async signAndSendTransaction() {
      return { signature: `sig-${requests.length}` };
    }
  };

  const executor = new SolanaLiveExecutor({
    client,
    fetchImpl,
    slippageBps: 100,
    minSolReserve: 0.1,
    maxBankrollSol: 1.0
  });

  const state = {
    bankrollSol: 1.0,
    openPositions: [],
    realizedPnlSol: 0
  };
  const decision = { sizeSol: 0.1, tpPct: 0.2, slPct: 0.05 };
  const opportunity = {
    pair: 'SOL/BONK',
    venue: 'solana/jupiter',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'mint',
    decimals: 6,
    liquidityUsd: 500000,
    momentumScore: 0.8
  };

  const entry = await executor.enter(state, opportunity, decision);
  assert.equal(state.openPositions.length, 1);
  assert.equal(entry.position.capitalSol, 0.1);
  assert.equal(state.bankrollSol, 0.9);

  const exit = await executor.exit(state, state.openPositions[0]);
  assert.equal(state.openPositions.length, 0);
  assert.ok(Math.abs(state.realizedPnlSol - 0.02) < 1e-9);
  assert.equal(exit.proceeds, 0.12);
  assert.equal(state.bankrollSol, 1.02);
});

test('LiveTradingBot queues and approves supervised entry and exit decisions', async () => {
  const approvalQueue = new TradeApprovalQueue();
  let learned = 0;
  const executor = {
    async getInitialBankrollSol() {
      return 1;
    },
    async syncBankroll() {},
    async enter(state, opportunity, decision) {
      const position = {
        id: 'position-1',
        pair: opportunity.pair,
        entryPrice: 1,
        quantity: 1,
        capitalSol: decision.sizeSol,
        tpPct: decision.tpPct,
        slPct: decision.slPct,
        highPriceSeen: 1,
        venue: opportunity.venue
      };
      state.bankrollSol -= decision.sizeSol;
      state.openPositions.push(position);
      return { position, signature: 'sig-enter' };
    },
    async exit(state, position) {
      state.openPositions = state.openPositions.filter((candidate) => candidate.id !== position.id);
      state.bankrollSol += 0.25;
      state.realizedPnlSol += 0.05;
      return { positionId: position.id, pnlSol: 0.05, pnlPct: 0.25, proceeds: 0.25, signature: 'sig-exit' };
    }
  };
  const bot = new LiveTradingBot({
    strategy: {
      config: {},
      decide() {
        return { action: 'ENTER', sizeSol: 0.2, tpPct: 0.3, slPct: 0.1 };
      },
      exitDecision() {
        return { action: 'EXIT', reason: 'take-profit', pnlPct: 0.25 };
      }
    },
    executor,
    logger: {
      logDecision() {},
      logExecution() {}
    },
    learning: {
      learn() {
        learned += 1;
      }
    },
    feed: { getActiveWatchlist() { return []; } },
    goalAgent: null,
    supervisionMode: true,
    approvalQueue
  });

  await bot.initialize();
  await bot.processOpportunity({
    pair: 'SOL/BONK',
    venue: 'solana/jupiter',
    liquidityUsd: 100000,
    rugScore: 0.1,
    momentumScore: 0.9,
    volatilityRisk: 0.1
  });
  assert.equal(bot.getPendingDecisions().length, 1);
  assert.equal(bot.state.openPositions.length, 0);

  await bot.approvePendingDecision(bot.getPendingDecisions()[0].id);
  assert.equal(bot.state.openPositions.length, 1);

  await bot.processMarketTick({ 'SOL/BONK': 1.25 });
  assert.equal(bot.getPendingDecisions().length, 1);

  await bot.approvePendingDecision(bot.getPendingDecisions()[0].id);
  assert.equal(bot.state.openPositions.length, 0);
  assert.equal(learned, 1);
});
