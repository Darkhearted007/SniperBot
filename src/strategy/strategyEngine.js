const { RISK_CONFIG } = require('../config/risk');

class StrategyEngine {
  constructor({ learningEngine }) {
    this.learningEngine = learningEngine;
  }

  decide({ state, opportunity, safety }) {
    const failSafes = [];
    if (!safety.safe) failSafes.push(...safety.reasons);
    if (state.circuitBreaker) failSafes.push('circuit-breaker-active');
    if (state.dailyLossPct >= RISK_CONFIG.maxDailyLossPct) failSafes.push('daily-loss-cap-reached');
    if (state.drawdownPct >= RISK_CONFIG.maxDrawdownPct) failSafes.push('drawdown-cap-reached');
    if (state.openPositions.find((p) => p.pair === opportunity.pair)) failSafes.push('duplicate-position');

    const confidence = this.learningEngine.score(opportunity);
    const expectedEdge = opportunity.momentumScore * confidence - opportunity.volatilityRisk;
    const shouldEnter = failSafes.length === 0 && expectedEdge > RISK_CONFIG.minExpectedEdge;
    const bankroll = state.bankrollSol;
    const rawSize = bankroll * RISK_CONFIG.maxPositionPct;
    const sizeSol = Math.min(Math.max(rawSize, 0), bankroll);

    return {
      action: shouldEnter ? 'ENTER' : 'SKIP',
      confidence,
      expectedEdge,
      sizeSol,
      reason: shouldEnter ? 'edge-positive-within-risk' : `guarded:${failSafes.join('|') || 'edge-too-low'}`,
      tpPct: RISK_CONFIG.takeProfitBasePct + confidence * RISK_CONFIG.takeProfitConfidenceScale,
      slPct: RISK_CONFIG.stopLossBasePct + (1 - confidence) * RISK_CONFIG.stopLossConfidenceScale
    };
  }

  exitDecision(position, priceNow) {
    const pnlPct = (priceNow - position.entryPrice) / position.entryPrice;
    if (pnlPct >= position.tpPct) return { action: 'EXIT', reason: 'take-profit', pnlPct };
    if (pnlPct <= -position.slPct) return { action: 'EXIT', reason: 'stop-loss', pnlPct };
    return { action: 'HOLD', reason: 'within-threshold', pnlPct };
  }
}

module.exports = { StrategyEngine };
