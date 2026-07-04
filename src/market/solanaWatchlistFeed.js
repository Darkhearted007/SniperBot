const { fetchJupiterQuote } = require('../live/jupiterClient');
const { LAMPORTS_PER_SOL } = require('../live/constants');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreOpportunity(opportunity) {
  const liquidityBonus = clamp(Math.log10(Math.max(opportunity.liquidityUsd || 1, 1)) / 10, 0, 1) * 0.15;
  return opportunity.momentumScore - opportunity.volatilityRisk - opportunity.rugScore + liquidityBonus;
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
    watchlistCandidates = [],
    autoWatchlistSize = null,
    fetchImpl = fetch,
    quoteApiBase,
    slippageBps = 100
  }) {
    this.watchlist = watchlist;
    this.watchlistCandidates = watchlistCandidates;
    this.autoWatchlistSize = autoWatchlistSize;
    this.fetchImpl = fetchImpl;
    this.quoteApiBase = quoteApiBase;
    this.slippageBps = slippageBps;
    this.history = new Map();
    this.activeWatchlist = watchlist;
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
    // Scale small quote-to-quote moves into the 0-1 strategy scoring range so
    // a ~10% move roughly contributes ±0.5 to the baseline momentum score.
    const momentumScore = clamp(token.baselineMomentumScore + changePct * 5, 0.05, 0.99);
    const volatilityRisk = token.volatilityRisk != null
      ? clamp(token.volatilityRisk, 0.01, 0.99)
      // Expand recent return volatility into the same 0-1 risk range while
      // keeping a floor for thin data and a cap below 1.0 for strategy math.
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
    const sourceWatchlist = this.watchlistCandidates.length > 0 ? this.watchlistCandidates : this.watchlist;
    const settled = await Promise.allSettled(sourceWatchlist.map((token) => this.fetchOpportunity(token)));
    const opportunities = settled.flatMap((result, index) => {
      if (result.status !== 'fulfilled') return [];
      return [{
        opportunity: result.value,
        token: sourceWatchlist[index],
        score: scoreOpportunity(result.value)
      }];
    });

    if (opportunities.length === 0) {
      const firstError = settled.find((result) => result.status === 'rejected');
      throw firstError ? firstError.reason : new Error('No live opportunities available');
    }

    const ranked = this.watchlistCandidates.length > 0
      ? [...opportunities]
        .sort((left, right) => right.score - left.score)
        .slice(0, this.autoWatchlistSize ?? opportunities.length)
      : opportunities;

    this.activeWatchlist = ranked.map((entry) => entry.token);
    return ranked.map((entry) => entry.opportunity);
  }

  getActiveWatchlist() {
    return this.activeWatchlist;
  }
}

module.exports = { SolanaWatchlistFeed };
