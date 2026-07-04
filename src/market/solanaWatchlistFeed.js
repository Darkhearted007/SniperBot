const { fetchJupiterQuote } = require('../live/jupiterClient');
const { LAMPORTS_PER_SOL } = require('../live/constants');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stddev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

class SolanaWatchlistFeed {
  constructor({
    watchlist,
    fetchImpl = fetch,
    quoteApiBase,
    slippageBps = 100
  }) {
    this.watchlist = watchlist;
    this.fetchImpl = fetchImpl;
    this.quoteApiBase = quoteApiBase;
    this.slippageBps = slippageBps;
    this.history = new Map();
  }

  async fetchOpportunity(token) {
    const rawUnitAmount = (10n ** BigInt(token.decimals)).toString();
    const quote = await fetchJupiterQuote({
      fetchImpl: this.fetchImpl,
      quoteApiBase: this.quoteApiBase,
      inputMint: token.outputMint,
      outputMint: token.inputMint,
      amount: rawUnitAmount,
      slippageBps: this.slippageBps
    });

    const priceSol = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const prior = this.history.get(token.outputMint) || { prices: [] };
    const prevPrice = prior.prices[prior.prices.length - 1];
    const changePct = prevPrice ? (priceSol - prevPrice) / prevPrice : 0;

    const prices = [...prior.prices, priceSol].slice(-8);
    this.history.set(token.outputMint, { prices });

    const returns = prices.slice(1).map((value, index) => (value - prices[index]) / prices[index]);
    const momentumScore = clamp(token.baselineMomentumScore + changePct * 5, 0.05, 0.99);
    const volatilityRisk = token.fixedVolatilityRisk != null
      ? clamp(token.fixedVolatilityRisk, 0.01, 0.99)
      : clamp(Math.max(0.08, stddev(returns) * 8), 0.08, 0.95);

    return {
      pair: token.pair,
      tokenName: token.tokenName,
      symbol: token.symbol,
      venue: token.venue,
      liquidityUsd: token.liquidityUsd,
      rugScore: token.rugScore,
      momentumScore,
      volatilityRisk,
      price: priceSol,
      inputMint: token.inputMint,
      outputMint: token.outputMint,
      decimals: token.decimals,
      quote
    };
  }

  async list() {
    const settled = await Promise.allSettled(this.watchlist.map((token) => this.fetchOpportunity(token)));
    const opportunities = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);

    if (opportunities.length === 0) {
      const firstError = settled.find((result) => result.status === 'rejected');
      throw firstError ? firstError.reason : new Error('No live opportunities available');
    }

    return opportunities;
  }
}

module.exports = { SolanaWatchlistFeed };
