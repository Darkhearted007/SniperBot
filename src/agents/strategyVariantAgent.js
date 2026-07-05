const { STRATEGY_VARIANTS, RISK_CONFIG } = require('../config/risk');
const { createIsolatedSimulator, equityOf } = require('../simulator/multiStrategySimulator');

/**
 * StrategyVariantAgent manages N isolated simulators — one per strategy variant
 * (conservative / balanced / aggressive).  Every call to `runCycle` advances all
 * variants by one tick so the learning engines accumulate diverging histories.
 * After enough cycles the best-performing variant is surfaced to the OrchestratorAgent.
 */
class StrategyVariantAgent {
  constructor({ feed, variants = STRATEGY_VARIANTS }) {
    this.feed = feed;
    this.walkForwardWindow = Math.max(5, Number(variants[0]?.walkForwardWindow || RISK_CONFIG.walkForwardWindow || 20));
    this.instances = variants.map((variantConfig) => ({
      name: variantConfig.name || 'unnamed',
      config: variantConfig,
      equityHistory: [],
      recentReturns: [],
      ...createIsolatedSimulator(feed, variantConfig)
    }));
  }

  /**
   * Run one discovery cycle across all variants.
   * @param {object} priceMap  - { [pair]: number } current prices for exit checks
   */
  runCycle(priceMap = {}) {
    for (const inst of this.instances) {
      if (inst.simulator.state.circuitBreaker) continue;
      inst.simulator.runCycle();
      if (Object.keys(priceMap).length > 0) {
        inst.simulator.processMarketTick(priceMap);
      }
      this._capturePerformance(inst);
    }
    return this.getSummary();
  }

  /**
   * Return a performance summary for every variant, sorted by equity (best first).
   */
  getSummary() {
    return this.instances
      .map((inst) => {
        const s = inst.simulator.state;
        const equity = equityOf(s);
        const total = inst.learning.stats.wins + inst.learning.stats.losses;
        const growthScore = this._growthScore(inst, equity);
        const stabilityScore = this._stabilityScore(inst.recentReturns);
        const drawdownScore = 1 - Math.min(1, s.drawdownPct || 0);
        const winRate = total === 0 ? null : inst.learning.stats.wins / total;
        const riskAdjustedScore =
          growthScore * (inst.config.variantGrowthWeight ?? RISK_CONFIG.variantGrowthWeight) +
          stabilityScore * (inst.config.variantStabilityWeight ?? RISK_CONFIG.variantStabilityWeight) +
          drawdownScore * (inst.config.variantRiskWeight ?? RISK_CONFIG.variantRiskWeight);
        return {
          name: inst.name,
          equity,
          riskAdjustedScore,
          growthScore,
          stabilityScore,
          drawdownScore,
          bankrollSol: s.bankrollSol,
          realizedPnlSol: s.realizedPnlSol,
          wins: inst.learning.stats.wins,
          losses: inst.learning.stats.losses,
          winRate,
          avgPnlPct: inst.learning.stats.avgPnlPct,
          circuitBreaker: s.circuitBreaker,
          venueStats: inst.learning.venueStats
        };
      })
      .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore || b.equity - a.equity);
  }

  /**
   * Return the config of whichever variant currently has the highest equity
   * and has executed at least one trade (to avoid selecting an untested variant).
   * Falls back to the balanced config if no variant has traded yet.
   */
  getBestVariantConfig() {
    const ranked = this.getSummary().filter((v) => (v.wins + v.losses) > 0);
    if (ranked.length === 0) {
      return STRATEGY_VARIANTS.find((v) => v.name === 'balanced') || RISK_CONFIG;
    }
    const bestName = ranked[0].name;
    const match = this.instances.find((i) => i.name === bestName);
    return match ? match.config : RISK_CONFIG;
  }

  snapshot() {
    return {
      walkForwardWindow: this.walkForwardWindow,
      instances: this.instances.map((instance) => ({
        name: instance.name,
        equityHistory: instance.equityHistory,
        recentReturns: instance.recentReturns,
        learning: typeof instance.learning.snapshot === 'function' ? instance.learning.snapshot() : null
      }))
    };
  }

  restore(snapshot = {}) {
    if (!snapshot || !Array.isArray(snapshot.instances)) return;
    for (const persisted of snapshot.instances) {
      const target = this.instances.find((instance) => instance.name === persisted.name);
      if (!target) continue;
      if (Array.isArray(persisted.equityHistory)) {
        target.equityHistory = persisted.equityHistory.slice(-this.walkForwardWindow);
      }
      if (Array.isArray(persisted.recentReturns)) {
        target.recentReturns = persisted.recentReturns.slice(-this.walkForwardWindow);
      }
      if (persisted.learning && typeof target.learning.restore === 'function') {
        target.learning.restore(persisted.learning);
      }
    }
  }

  _startingEquityFor(inst) {
    return Math.max(inst.config.startingBankrollSol || RISK_CONFIG.startingBankrollSol, Number.EPSILON);
  }

  _growthScore(inst, equity) {
    const base = this._startingEquityFor(inst);
    return Math.max(0, Math.min(2, equity / base));
  }

  _stabilityScore(returns) {
    if (!returns.length) return 0.5;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
    const stdev = Math.sqrt(variance);
    const sharpeLike = mean / Math.max(stdev, 1e-4);
    return Math.max(0, Math.min(1.5, 0.5 + sharpeLike * 0.2));
  }

  _capturePerformance(inst) {
    const equity = equityOf(inst.simulator.state);
    const priorEquity = inst.equityHistory[inst.equityHistory.length - 1] || this._startingEquityFor(inst);
    if (priorEquity > 0) {
      inst.recentReturns.push((equity - priorEquity) / priorEquity);
      inst.recentReturns = inst.recentReturns.slice(-this.walkForwardWindow);
    }
    inst.equityHistory.push(equity);
    inst.equityHistory = inst.equityHistory.slice(-this.walkForwardWindow);
  }
}

module.exports = { StrategyVariantAgent };
