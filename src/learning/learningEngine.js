const { RISK_CONFIG } = require('../config/risk');

class LearningEngine {
  constructor(config = RISK_CONFIG) {
    this.config = config;
    if (config.learning.liquidityBiasDivider <= 0) {
      throw new Error('learning.liquidityBiasDivider must be greater than zero');
    }
    // Global stats
    this.stats = { wins: 0, losses: 0, avgPnlPct: 0 };
    // Per-venue stats for pattern detection
    this.venueStats = {};
  }

  score(opportunity) {
    const cfg = this.config.learning;
    const total = this.stats.wins + this.stats.losses;

    // EMA-smoothed performance bias: recent trades weighted by perfEmaAlpha
    const perfBias = total === 0
      ? cfg.perfBiasBase
      : Math.max(cfg.perfBiasMin, Math.min(cfg.perfBiasMax, cfg.perfBiasBase + this.stats.avgPnlPct));

    // Use per-venue win rate to bias venue score when enough data exists
    const venueStat = this.venueStats[opportunity.venue];
    const venueTotal = venueStat ? venueStat.wins + venueStat.losses : 0;
    let venueBias;
    if (venueTotal >= 5) {
      venueBias = Math.max(cfg.perfBiasMin, Math.min(cfg.perfBiasMax, venueStat.wins / venueTotal));
    } else {
      venueBias = opportunity.venue.includes('pump.fun') ? cfg.pumpFunVenueBias : cfg.defaultVenueBias;
    }

    const liquidityBias = Math.min(cfg.liquidityBiasMax, opportunity.liquidityUsd / cfg.liquidityBiasDivider);
    return Math.max(
      cfg.finalScoreMin,
      Math.min(cfg.finalScoreMax, perfBias * cfg.perfWeight + venueBias * cfg.venueWeight + liquidityBias)
    );
  }

  learn(execution) {
    const alpha = this.config.learning.perfEmaAlpha;
    const isWin = execution.pnlPct > 0;
    if (isWin) this.stats.wins += 1;
    else this.stats.losses += 1;

    // Exponential moving average on pnlPct so recent trades matter more
    this.stats.avgPnlPct = this.stats.wins + this.stats.losses === 1
      ? execution.pnlPct
      : (1 - alpha) * this.stats.avgPnlPct + alpha * execution.pnlPct;

    // Per-venue tracking
    const venue = execution.venue || 'unknown';
    if (!this.venueStats[venue]) this.venueStats[venue] = { wins: 0, losses: 0, avgPnlPct: 0 };
    const vs = this.venueStats[venue];
    if (isWin) vs.wins += 1;
    else vs.losses += 1;
    const vTotal = vs.wins + vs.losses;
    vs.avgPnlPct = vTotal === 1
      ? execution.pnlPct
      : (1 - alpha) * vs.avgPnlPct + alpha * execution.pnlPct;
  }
}

module.exports = { LearningEngine };
