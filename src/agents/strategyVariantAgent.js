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
    this.instances = variants.map((variantConfig) => ({
      name: variantConfig.name || 'unnamed',
      config: variantConfig,
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
        return {
          name: inst.name,
          equity,
          bankrollSol: s.bankrollSol,
          realizedPnlSol: s.realizedPnlSol,
          wins: inst.learning.stats.wins,
          losses: inst.learning.stats.losses,
          winRate: total === 0 ? null : inst.learning.stats.wins / total,
          avgPnlPct: inst.learning.stats.avgPnlPct,
          circuitBreaker: s.circuitBreaker,
          venueStats: inst.learning.venueStats
        };
      })
      .sort((a, b) => b.equity - a.equity);
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
}

module.exports = { StrategyVariantAgent };
