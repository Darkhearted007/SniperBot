const { RISK_CONFIG } = require('../config/risk');

function runSafetyChecks(opportunity, config = RISK_CONFIG) {
  const reasons = [];
  if (opportunity.liquidityUsd < config.minLiquidityUsd) {
    reasons.push('liquidity-below-threshold');
  }
  if (opportunity.rugScore > config.maxRugScore) {
    reasons.push('rug-risk-too-high');
  }
  if (config.minMomentumScore && opportunity.momentumScore < config.minMomentumScore) {
    reasons.push('momentum-below-threshold');
  }
  const lowerName = `${opportunity.tokenName} ${opportunity.symbol}`.toLowerCase();
  if (config.blockedTokenKeywords.some((k) => lowerName.includes(k))) {
    reasons.push('blocked-token-keyword');
  }
  return { safe: reasons.length === 0, reasons };
}

module.exports = { runSafetyChecks };
