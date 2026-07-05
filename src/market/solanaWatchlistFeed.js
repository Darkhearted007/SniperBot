const { fetchJupiterQuote } = require('../live/jupiterClient');
const { LAMPORTS_PER_SOL } = require('../live/constants');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreOpportunity(opportunity) {
  const liquidityBonus = clamp(Math.log10(Math.max(opportunity.liquidityUsd || 1, 1)) / 10, 0, 1) * 0.15;
  const executionPenalty = (opportunity.expectedSlippageBps || 0) / 1000 + (opportunity.executionFailureRate || 0);
  return opportunity.momentumScore - opportunity.volatilityRisk - opportunity.rugScore - executionPenalty + liquidityBonus;
}

function stddev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

const DEFAULT_MAX_HISTORY_SIZE = 50;

class SolanaWatchlistFeed {
  constructor({
    watchlist,
    watchlistCandidates = [],
    autoWatchlistSize = null,
    fetchImpl = fetch,
    quoteApiBase,
    slippageBps = 100,
    maxHistorySize = DEFAULT_MAX_HISTORY_SIZE,
    dynamicCandidateSource = null
  }) {
    this.watchlist = watchlist;
    this.watchlistCandidates = watchlistCandidates;
    this.autoWatchlistSize = autoWatchlistSize;
    this.fetchImpl = fetchImpl;
    this.quoteApiBase = quoteApiBase;
    this.slippageBps = slippageBps;
    this.maxHistorySize = Number.isFinite(maxHistorySize) && maxHistorySize > 0
      ? Math.floor(maxHistorySize)
      : DEFAULT_MAX_HISTORY_SIZE;
    this.dynamicCandidateSource = dynamicCandidateSource;
    this.history = new Map();
    this.activeWatchlist = watchlist;
  }

  /**
   * Merges the static watchlistCandidates (from SOLANA_AUTO_WATCHLIST_JSON)
   * with anything a live PoolDiscoveryFeed has surfaced since the last
   * cycle, de-duplicating by outputMint so a token isn't scored twice.
   */
  getCandidateSourceList() {
    const dynamic = typeof this.dynamicCandidateSource?.getCandidates === 'function'
      ? this.dynamicCandidateSource.getCandidates()
      : [];
    if (dynamic.length === 0) return this.watchlistCandidates;
    const byMint = new Map(this.watchlistCandidates.map((token) => [token.outputMint, token]));
    for (const token of dynamic) {
      if (!byMint.has(token.outputMint)) {
        byMint.set(token.outputMint, token);
      }
    }
    return [...byMint.values()];
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
    if (!this.history.has(token.outputMint) && this.history.size >= this.maxHistorySize) {
      // Evict the oldest entry (Maps preserve insertion order)
      this.history.delete(this.history.keys().next().value);
    }
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

    const expectedSlippageBps = Math.round(clamp(
      this.slippageBps * (1 + volatilityRisk * 0.8 + (token.liquidityUsd < 100000 ? 0.5 : 0)),
      10,
      350
    ));
    const depthScore = clamp(Math.log10(Math.max(token.liquidityUsd || 1, 1)) / 6, 0.1, 1);
    const executionFailureRate = clamp(
      (volatilityRisk * 0.08) + (expectedSlippageBps / 1000),
      0.005,
      0.5
    );

    return {
      pair: token.pair,
      tokenName: token.tokenName,
      symbol: token.symbol,
      venue: token.venue,
      liquidityUsd: token.liquidityUsd,
      rugScore: token.rugScore,
      lpMint: token.lpMint || null,
      tokenCategory: token.tokenCategory || 'uncategorized',
      momentumScore,
      volatilityRisk,
      expectedSlippageBps,
      depthScore,
      executionFailureRate,
      price: priceSol,
      inputMint: token.inputMint,
      outputMint: token.outputMint,
      decimals: token.decimals,
      marketContext: {
        trendState: momentumScore > 0.72 ? 'bull' : momentumScore < 0.45 ? 'bear' : 'chop',
        volatilityRegime: volatilityRisk > 0.55 ? 'high' : volatilityRisk > 0.3 ? 'mid' : 'low',
        regimeStrength: clamp(Math.abs(momentumScore - 0.5) * 2, 0.1, 1)
      },
      quote
    };
  }

  async list() {
    const candidateSourceList = this.getCandidateSourceList();
    const sourceWatchlist = candidateSourceList.length > 0 ? candidateSourceList : this.watchlist;
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

    const ranked = candidateSourceList.length > 0
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
