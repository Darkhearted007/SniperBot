const { RISK_CONFIG } = require('../config/risk');

class StrategyEngine {
  constructor({ learningEngine, config = RISK_CONFIG } = {}) {
    this.learningEngine = learningEngine;
    this.config = config;
  }

  decide({ state, opportunity, safety }) {
    const cfg = this.config;
    const failSafes = [];
    if (!safety.safe) failSafes.push(...safety.reasons);
    if (state.circuitBreaker) failSafes.push('circuit-breaker-active');
    if (state.dailyLossPct >= cfg.maxDailyLossPct) failSafes.push('daily-loss-cap-reached');
    if (state.drawdownPct >= cfg.maxDrawdownPct) failSafes.push('drawdown-cap-reached');
    if (state.openPositions.find((p) => p.pair === opportunity.pair)) failSafes.push('duplicate-position');

    const confidence = this.learningEngine.score(opportunity);
    const expectedEdge = opportunity.momentumScore * confidence - opportunity.volatilityRisk;
    const shouldEnter = failSafes.length === 0 && expectedEdge > cfg.minExpectedEdge;

    // Confidence-scaled position sizing: concentrate capital on high-conviction trades
    const bankroll = state.bankrollSol;
    const rawSize = bankroll * cfg.maxPositionPct * confidence;
    const sizeSol = Math.min(Math.max(rawSize, 0), bankroll);

    return {
      action: shouldEnter ? 'ENTER' : 'SKIP',
      confidence,
      expectedEdge,
      sizeSol,
      reason: shouldEnter ? 'edge-positive-within-risk' : `guarded:${failSafes.join('|') || 'edge-too-low'}`,
      tpPct: cfg.takeProfitBasePct + confidence * cfg.takeProfitConfidenceScale,
      slPct: cfg.stopLossBasePct + (1 - confidence) * cfg.stopLossConfidenceScale
    };
  }

  exitDecision(position, priceNow) {
    const cfg = this.config;
    const pnlPct = (priceNow - position.entryPrice) / position.entryPrice;

    // Update trailing high-water mark (mutates position by reference)
    position.highPriceSeen = Math.max(position.highPriceSeen ?? position.entryPrice, priceNow);

    // Take-profit check
    if (pnlPct >= position.tpPct) return { action: 'EXIT', reason: 'take-profit', pnlPct };

    // Trailing stop: once gain from entry >= trailActivatePct, trail cfg.trailPct from the high
    if (cfg.trailActivatePct) {
      const gainFromEntry = (position.highPriceSeen - position.entryPrice) / position.entryPrice;
      if (gainFromEntry >= cfg.trailActivatePct) {
        const drawdownFromHigh = (position.highPriceSeen - priceNow) / position.highPriceSeen;
        if (drawdownFromHigh >= cfg.trailPct) {
          return { action: 'EXIT', reason: 'trailing-stop', pnlPct };
        }
        return { action: 'HOLD', reason: 'trailing-active-within-threshold', pnlPct };
      }
    }

    // Regular stop-loss
    if (pnlPct <= -position.slPct) return { action: 'EXIT', reason: 'stop-loss', pnlPct };

    return { action: 'HOLD', reason: 'within-threshold', pnlPct };
  }
}

module.exports = { StrategyEngine };
