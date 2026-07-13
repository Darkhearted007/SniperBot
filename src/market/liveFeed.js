/**
 * LiveFeed — Real market data feed for the SniperBot.
 *
 * Fetches live token prices from:
 *   - DexScreener (primary, free, no API key required, 300 req/min)
 *   - CoinGecko (fallback, requires COINGECKO_API_KEY env var, 100 req/min)
 *
 * Outputs opportunities in the same format as the synthetic opportunityFeed.js
 * so it's a drop-in replacement. The only change needed is passing
 * `USE_LIVE_FEED=true` as an environment variable.
 *
 * Rate limiting:
 *   - DexScreener: 300 req/min → 1 req/200ms minimum spacing
 *   - CoinGecko: 100 req/min → 1 req/600ms minimum spacing
 *   - Results are cached for 15 seconds to stay within limits
 */

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS = 15_000;
const MIN_REQUEST_INTERVAL_MS = 210; // Slightly above 200ms for safety

let lastRequestTime = 0;

async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
  }
  return response.json();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Build a comprehensive opportunity from raw market data.
 */
function buildOpportunity(token, priceUsd, volume24hUsd, liquidityUsd, fdv, priceChange24h) {
  const priceSol = priceUsd != null ? priceUsd / 180 : 0.001; // Approximate SOL/USD
  const momentumScore = clamp(
    token.baselineMomentum != null
      ? token.baselineMomentum + (priceChange24h != null ? priceChange24h * 2 : 0)
      : 0.65 + (priceChange24h != null ? priceChange24h * 2 : 0),
    0.05,
    0.99
  );
  const volatilityRisk = clamp(
    Math.abs(priceChange24h || 0.05) * 3 + 0.05,
    0.05,
    0.95
  );
  const expectedSlippageBps = Math.round(clamp(
    (liquidityUsd < 50000 ? 200 : liquidityUsd < 500000 ? 100 : 50) * (1 + volatilityRisk * 0.5),
    10,
    400
  ));
  const depthScore = clamp(Math.log10(Math.max(liquidityUsd || 1, 1)) / 6, 0.1, 1);
  const executionFailureRate = clamp(
    (volatilityRisk * 0.08) + (expectedSlippageBps / 1000),
    0.005,
    0.5
  );

  return {
    pair: token.pair,
    tokenName: token.tokenName,
    symbol: token.symbol,
    venue: token.venue || 'solana/raydium',
    tokenCategory: token.tokenCategory || 'uncategorized',
    liquidityUsd: liquidityUsd || token.minLiquidityUsd || 10000,
    rugScore: token.rugScore ?? 0.15,
    momentumScore,
    volatilityRisk,
    price: priceSol,
    expectedSlippageBps,
    depthScore,
    executionFailureRate,
    inputMint: token.inputMint,
    outputMint: token.outputMint,
    decimals: token.decimals,
    priceUsd,
    volume24hUsd,
    fdv,
    priceChange24h,
    marketContext: {
      trendState: momentumScore > 0.72 ? 'bull' : momentumScore < 0.45 ? 'bear' : 'chop',
      volatilityRegime: volatilityRisk > 0.55 ? 'high' : volatilityRisk > 0.3 ? 'mid' : 'low',
      regimeStrength: clamp(Math.abs(momentumScore - 0.5) * 2, 0.1, 1)
    }
  };
}

/**
 * Fetch all token data from DexScreener in batch.
 * DexScreener requires no API key and supports up to 30 tokens per request.
 */
async function fetchFromDexScreener(tokens) {
  try {
    // Collect all unique token addresses
    const addresses = tokens
      .map((t) => t.outputMint)
      .filter(Boolean)
      .join(',');

    if (!addresses) return {};

    // DexScreener /tokens/v1/{chain}/{addresses} — batch endpoint
    const data = await rateLimitedFetch(
      `${DEXSCREENER_BASE}/tokens/v1/solana/${addresses}`
    );

    // data is an array of pair objects. We need to group by token address.
    const result = {};
    if (Array.isArray(data)) {
      for (const pair of data) {
        const baseToken = pair?.baseToken;
        if (!baseToken?.address) continue;
        const addr = baseToken.address;
        // Take the pool with highest liquidity for each token
        if (
          !result[addr] ||
          (pair.liquidity?.usd || 0) > (result[addr].liquidity?.usd || 0)
        ) {
          result[addr] = pair;
        }
      }
    }

    // Map back to our token format
    const mapped = {};
    for (const token of tokens) {
      const addr = token.outputMint;
      const pair = result[addr];
      if (pair) {
        const priceUsd = parseFloat(pair.priceUsd) || null;
        const liquidityUsd = pair.liquidity?.usd || token.minLiquidityUsd || 10000;
        const volume24h = pair.volume?.h24 || 0;
        const fdv = pair.fdv || null;
        const priceChange24h = pair.priceChange?.h24 != null
          ? pair.priceChange.h24 / 100
          : null;
        mapped[addr] = { priceUsd, liquidityUsd, volume24h, fdv, priceChange24h };
      }
    }
    return mapped;
  } catch (error) {
    console.warn('[LiveFeed] DexScreener fetch failed:', error.message);
    return {};
  }
}

/**
 * Fetch CoinGecko prices as fallback for tokens DexScreener missed.
 */
async function fetchFromCoinGecko(tokens, apiKey) {
  if (!apiKey) return {};

  try {
    // CoinGecko /simple/token_price/solana — batch by contract address
    const addresses = tokens
      .map((t) => t.outputMint)
      .filter(Boolean)
      .join(',');

    if (!addresses) return {};

    const url = `${COINGECKO_BASE}/simple/token_price/solana?contract_addresses=${addresses}&vs_currencies=usd&include_24hr_vol=true&include_market_cap=true&include_24hr_change=true`;
    const data = await rateLimitedFetch(url, {
      headers: { 'x_cg_demo_api_key': apiKey }
    });

    const mapped = {};
    for (const token of tokens) {
      const addr = token.outputMint.toLowerCase();
      const entry = data[addr];
      if (entry) {
        mapped[token.outputMint] = {
          priceUsd: entry.usd || null,
          liquidityUsd: token.minLiquidityUsd || 50000,
          volume24h: entry.usd_24h_vol || 0,
          fdv: entry.usd_market_cap || null,
          priceChange24h: entry.usd_24h_change != null
            ? entry.usd_24h_change / 100
            : null
        };
      }
    }
    return mapped;
  } catch (error) {
    console.warn('[LiveFeed] CoinGecko fetch failed:', error.message);
    return {};
  }
}

/**
 * Create a live market data feed.
 *
 * @param {Array<object>} watchlist  - Array of token descriptors
 * @param {object}        [opts]
 * @param {string}        [opts.coinGeckoApiKey] - CoinGecko API key (optional)
 * @param {number}        [opts.cacheTtlMs]      - Cache lifetime (default 15s)
 */
function createLiveFeed(watchlist, opts = {}) {
  const coinGeckoApiKey = opts.coinGeckoApiKey || process.env.COINGECKO_API_KEY || null;
  const cacheTtlMs = opts.cacheTtlMs || CACHE_TTL_MS;

  let cachedOpportunities = null;
  let lastFetchTime = 0;
  let previousPrices = {}; // Track price history for momentum calc

  return {
    /**
     * Fetch live opportunities. Returns cached data if within TTL.
     * Implements DexScreener → CoinGecko fallback strategy.
     */
    async list() {
      const now = Date.now();
      if (cachedOpportunities && (now - lastFetchTime) < cacheTtlMs) {
        return cachedOpportunities;
      }

      // 1. Fetch from DexScreener (primary, no auth needed)
      let dexData = await fetchFromDexScreener(watchlist);

      // 2. Identify tokens DexScreener missed
      const missedTokens = watchlist.filter(
        (t) => !dexData[t.outputMint] || !dexData[t.outputMint].priceUsd
      );

      // 3. Fall back to CoinGecko for missed tokens
      let geckoData = {};
      if (missedTokens.length > 0) {
        geckoData = await fetchFromCoinGecko(missedTokens, coinGeckoApiKey);
      }

      // 4. Build opportunities
      const opportunities = watchlist.map((token) => {
        const addr = token.outputMint;
        const dex = dexData[addr] || {};
        const gecko = geckoData[addr] || {};
        const source = dex.priceUsd ? dex : gecko;

        const priceUsd = source.priceUsd || null;
        const liquidityUsd = source.liquidityUsd || token.minLiquidityUsd || 50000;
        const volume24h = source.volume24h || 0;
        const fdv = source.fdv || null;
        const priceChange24h = source.priceChange24h || null;

        // Track price changes for momentum
        const prevPrice = previousPrices[addr];
        const changePct = prevPrice && priceUsd
          ? (priceUsd - prevPrice) / prevPrice
          : priceChange24h || 0;
        previousPrices[addr] = priceUsd;

        return buildOpportunity(
          token, priceUsd, volume24h, liquidityUsd, fdv, changePct
        );
      });

      cachedOpportunities = opportunities;
      lastFetchTime = now;
      return opportunities;
    },

    /**
     * Clear the cache so next list() call fetches fresh data.
     */
    invalidateCache() {
      cachedOpportunities = null;
      lastFetchTime = 0;
    }
  };
}

// Comprehensive Solana token watchlist covering all major categories
function createComprehensiveWatchlist() {
  return [
    // ── Blue Chips ──────────────────────────────────────────────
    {
      pair: 'SOL/USDC',
      tokenName: 'Solana',
      symbol: 'SOL',
      outputMint: 'So11111111111111111111111111111111111111112',
      venue: 'solana/raydium',
      tokenCategory: 'bluechip',
      decimals: 9,
      minLiquidityUsd: 100_000_000,
      rugScore: 0.01,
      baselineMomentum: 0.75
    },
    {
      pair: 'SOL/JUP',
      tokenName: 'Jupiter',
      symbol: 'JUP',
      outputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
      venue: 'solana/raydium',
      tokenCategory: 'defi',
      decimals: 6,
      minLiquidityUsd: 50_000_000,
      rugScore: 0.03,
      baselineMomentum: 0.70
    },
    {
      pair: 'SOL/BONK',
      tokenName: 'Bonk',
      symbol: 'BONK',
      outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6Yo81Bp1PB263yPB263',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 5,
      minLiquidityUsd: 30_000_000,
      rugScore: 0.10,
      baselineMomentum: 0.65
    },
    {
      pair: 'SOL/WIF',
      tokenName: 'dogwifhat',
      symbol: 'WIF',
      outputMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 6,
      minLiquidityUsd: 20_000_000,
      rugScore: 0.12,
      baselineMomentum: 0.60
    },
    {
      pair: 'SOL/PYTH',
      tokenName: 'Pyth Network',
      symbol: 'PYTH',
      outputMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
      venue: 'solana/raydium',
      tokenCategory: 'infra',
      decimals: 6,
      minLiquidityUsd: 15_000_000,
      rugScore: 0.03,
      baselineMomentum: 0.65
    },
    {
      pair: 'SOL/RENDER',
      tokenName: 'Render',
      symbol: 'RENDER',
      outputMint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4DaaqT4F2bL',
      venue: 'solana/raydium',
      tokenCategory: 'infra',
      decimals: 6,
      minLiquidityUsd: 10_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.60
    },

    // ── DeFi ────────────────────────────────────────────────────
    {
      pair: 'SOL/JTO',
      tokenName: 'Jito',
      symbol: 'JTO',
      outputMint: 'jtojtQpaU7L3S8LEqFpJpB2qd6Zb3iJqBHFw9s7aECt',
      venue: 'solana/raydium',
      tokenCategory: 'defi',
      decimals: 9,
      minLiquidityUsd: 8_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.65
    },
    {
      pair: 'SOL/KAMINO',
      tokenName: 'Kamino',
      symbol: 'KMNO',
      outputMint: 'KMNo3nJsBXfcpJYh8KfgXwMUukLJQ2Kj7c2DZ1hiGx9',
      venue: 'solana/raydium',
      tokenCategory: 'defi',
      decimals: 6,
      minLiquidityUsd: 5_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.60
    },
    {
      pair: 'SOL/DRIFT',
      tokenName: 'Drift',
      symbol: 'DRIFT',
      outputMint: 'DriFtupJ1QYjJSa3dFYcGZ8cCg8R3dRJoE1RjFGbvCM',
      venue: 'solana/raydium',
      tokenCategory: 'defi',
      decimals: 6,
      minLiquidityUsd: 5_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.60
    },

    // ── Infrastructure ──────────────────────────────────────────
    {
      pair: 'SOL/HNT',
      tokenName: 'Helium',
      symbol: 'HNT',
      outputMint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
      venue: 'solana/raydium',
      tokenCategory: 'infra',
      decimals: 8,
      minLiquidityUsd: 5_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.55
    },
    {
      pair: 'SOL/IO',
      tokenName: 'io.net',
      symbol: 'IO',
      outputMint: 'Bz4pzvE1oMXGM5KGmPS3TVgMcKjVjPzJMkNova4qtyNh',
      venue: 'solana/raydium',
      tokenCategory: 'infra',
      decimals: 6,
      minLiquidityUsd: 5_000_000,
      rugScore: 0.05,
      baselineMomentum: 0.55
    },

    // ── Memes (high momentum, higher risk) ──────────────────────
    {
      pair: 'SOL/SAMO',
      tokenName: 'Samoyed Coin',
      symbol: 'SAMO',
      outputMint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 9,
      minLiquidityUsd: 2_000_000,
      rugScore: 0.20,
      baselineMomentum: 0.65
    },
    {
      pair: 'SOL/MYRO',
      tokenName: 'Myro',
      symbol: 'MYRO',
      outputMint: 'HhJpBhRR2oFdx2J8Q6iV8tDCJZn5K3fHCvVoXJ2WhvMD',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 6,
      minLiquidityUsd: 1_000_000,
      rugScore: 0.25,
      baselineMomentum: 0.60
    },
    {
      pair: 'SOL/POPCAT',
      tokenName: 'Popcat',
      symbol: 'POPCAT',
      outputMint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 6,
      minLiquidityUsd: 1_000_000,
      rugScore: 0.25,
      baselineMomentum: 0.60
    },
    {
      pair: 'SOL/MEW',
      tokenName: 'Cat in a dogs world',
      symbol: 'MEW',
      outputMint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
      venue: 'solana/raydium',
      tokenCategory: 'meme',
      decimals: 5,
      minLiquidityUsd: 1_000_000,
      rugScore: 0.20,
      baselineMomentum: 0.55
    },

    // ── Gaming / Consumer ────────────────────────────────────────
    {
      pair: 'SOL/PRCL',
      tokenName: 'Parcl',
      symbol: 'PRCL',
      outputMint: '4cMmFMC3QFfH2fE2HqbJbLkMgE4jEMJcTs5BY3qD73Sg',
      venue: 'solana/raydium',
      tokenCategory: 'gaming',
      decimals: 6,
      minLiquidityUsd: 2_000_000,
      rugScore: 0.10,
      baselineMomentum: 0.50
    }
  ];
}

module.exports = { createLiveFeed, createComprehensiveWatchlist, buildOpportunity };
