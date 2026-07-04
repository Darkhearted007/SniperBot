const { RISK_CONFIG } = require('../config/risk');

function runSafetyChecks(opportunity) {
  const reasons = [];
  if (opportunity.liquidityUsd < RISK_CONFIG.minLiquidityUsd) {
    reasons.push('liquidity-below-threshold');
  }
  if (opportunity.rugScore > 0.5) {
    reasons.push('rug-risk-too-high');
  }
  const lowerName = `${opportunity.tokenName} ${opportunity.symbol}`.toLowerCase();
  if (RISK_CONFIG.blockedTokenKeywords.some((k) => lowerName.includes(k))) {
    reasons.push('blocked-token-keyword');
  }
  return { safe: reasons.length === 0, reasons };
}

module.exports = { runSafetyChecks };
