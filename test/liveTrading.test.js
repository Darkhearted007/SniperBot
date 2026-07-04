const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLiveTradingConfig } = require('../src/live/config');
const { parseWalletSecretBytes } = require('../src/live/solanaRpcClient');
const { SolanaWatchlistFeed } = require('../src/market/solanaWatchlistFeed');
const { SolanaLiveExecutor } = require('../src/execution/solanaLiveExecutor');

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
