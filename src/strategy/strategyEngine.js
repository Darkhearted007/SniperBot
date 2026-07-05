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

    if (this._violatesExecutionQuality(opportunity, cfg)) {
      failSafes.push('execution-quality-poor');
    }
    if (this._violatesPortfolioExposure(state, opportunity, cfg)) {
      failSafes.push('portfolio-exposure-limit');
    }

    const baseConfidence = this.learningEngine.score(opportunity);
    const qualityMultiplier = this._executionQualityMultiplier(opportunity, cfg);
    const regimeMultiplier = this._regimeMultiplier(opportunity, cfg);
    const drawdownPenalty = 1 - Math.min(0.5, (state.drawdownPct || 0) * 1.5);
    const confidence = Math.max(0.01, Math.min(0.99, baseConfidence * qualityMultiplier * regimeMultiplier * drawdownPenalty));
    const expectedEdge = opportunity.momentumScore * confidence - opportunity.volatilityRisk;
    const hitRateProxy = Math.max(0.05, Math.min(0.95, baseConfidence * qualityMultiplier));
    const riskAdjustedScore = expectedEdge * (1 - Math.min(opportunity.volatilityRisk, 0.9)) * hitRateProxy;
    const shouldEnter = failSafes.length === 0 &&
      expectedEdge > cfg.minExpectedEdge &&
      riskAdjustedScore > (cfg.minRiskAdjustedScore ?? 0);

    // Confidence-scaled position sizing: concentrate capital on high-conviction trades
    const bankroll = state.bankrollSol;
    const rawSize = bankroll * cfg.maxPositionPct * confidence;
    const sizeSol = Math.min(Math.max(rawSize, 0), bankroll);

    return {
      action: shouldEnter ? 'ENTER' : 'SKIP',
      confidence,
      riskAdjustedScore,
      expectedEdge,
      sizeSol,
      reason: shouldEnter ? 'edge-positive-within-risk' : `guarded:${failSafes.join('|') || 'edge-too-low'}`,
      tpPct: cfg.takeProfitBasePct + confidence * cfg.takeProfitConfidenceScale,
      slPct: cfg.stopLossBasePct + (1 - confidence) * cfg.stopLossConfidenceScale
    };
  }

  _executionQualityMultiplier(opportunity, cfg) {
    const slippagePenalty = opportunity.expectedSlippageBps != null
      ? Math.max(0.45, 1 - (opportunity.expectedSlippageBps / (cfg.maxExpectedSlippageBps * 2)))
      : 1;
    const depthPenalty = opportunity.depthScore != null
      ? Math.max(0.45, Math.min(1.2, opportunity.depthScore + 0.2))
      : 1;
    const failRatePenalty = opportunity.executionFailureRate != null
      ? Math.max(0.35, 1 - opportunity.executionFailureRate * 2.2)
      : 1;
    return slippagePenalty * depthPenalty * failRatePenalty;
  }

  _regimeMultiplier(opportunity, cfg) {
    const trendState = opportunity.marketContext?.trendState;
    const volatilityRegime = opportunity.marketContext?.volatilityRegime;
    const trendMult = trendState ? (cfg.regimeMultipliers?.[trendState] ?? 1) : 1;
    const volMult = volatilityRegime ? (cfg.volatilityRegimeMultipliers?.[volatilityRegime] ?? 1) : 1;
    return trendMult * volMult;
  }

  _violatesExecutionQuality(opportunity, cfg) {
    if (opportunity.expectedSlippageBps != null && opportunity.expectedSlippageBps > cfg.maxExpectedSlippageBps) {
      return true;
    }
    if (opportunity.depthScore != null && opportunity.depthScore < cfg.minDepthScore) {
      return true;
    }
    if (opportunity.executionFailureRate != null && opportunity.executionFailureRate > cfg.maxExecutionFailureRate) {
      return true;
    }
    return false;
  }

  _violatesPortfolioExposure(state, opportunity, cfg) {
    const equity = state.bankrollSol + state.openPositions.reduce((sum, position) => sum + position.capitalSol, 0);
    const baseline = Math.max(equity, Number.EPSILON);
    const venueExposure = state.openPositions
      .filter((position) => position.venue === opportunity.venue)
      .reduce((sum, position) => sum + position.capitalSol, 0) / baseline;
    if (venueExposure >= cfg.maxVenueExposurePct) {
      return true;
    }
    const tokenCategory = opportunity.tokenCategory || 'uncategorized';
    const categoryExposure = state.openPositions
      .filter((position) => (position.tokenCategory || 'uncategorized') === tokenCategory)
      .reduce((sum, position) => sum + position.capitalSol, 0) / baseline;
    if (categoryExposure >= cfg.maxTokenCategoryExposurePct) {
      return true;
    }
    const correlatedPrefix = String(opportunity.pair || '').split('/')[0];
    const correlatedExposure = state.openPositions
      .filter((position) => String(position.pair || '').startsWith(`${correlatedPrefix}/`))
      .reduce((sum, position) => sum + position.capitalSol, 0) / baseline;
    return correlatedExposure >= cfg.maxCorrelatedPairExposurePct;
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
