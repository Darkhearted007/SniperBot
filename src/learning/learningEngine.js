const { RISK_CONFIG } = require('../config/risk');

class LearningEngine {
  constructor() {
    if (RISK_CONFIG.learning.liquidityBiasDivider <= 0) {
      throw new Error('learning.liquidityBiasDivider must be greater than zero');
    }
    this.stats = { wins: 0, losses: 0, avgPnlPct: 0 };
  }

  score(opportunity) {
    const cfg = RISK_CONFIG.learning;
    const perfBias = this.stats.wins + this.stats.losses === 0
      ? cfg.perfBiasBase
      : Math.max(cfg.perfBiasMin, Math.min(cfg.perfBiasMax, cfg.perfBiasBase + this.stats.avgPnlPct));
    const venueBias = opportunity.venue.includes('pump.fun') ? cfg.pumpFunVenueBias : cfg.defaultVenueBias;
    const liquidityBias = Math.min(cfg.liquidityBiasMax, opportunity.liquidityUsd / cfg.liquidityBiasDivider);
    return Math.max(
      cfg.finalScoreMin,
      Math.min(cfg.finalScoreMax, perfBias * cfg.perfWeight + venueBias * cfg.venueWeight + liquidityBias)
    );
  }

  learn(execution) {
    const total = this.stats.wins + this.stats.losses + 1;
    if (execution.pnlPct > 0) this.stats.wins += 1;
    else this.stats.losses += 1;
    this.stats.avgPnlPct = ((this.stats.avgPnlPct * (total - 1)) + execution.pnlPct) / total;
  }
}

module.exports = { LearningEngine };
