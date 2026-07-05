const { RISK_CONFIG } = require('../config/risk');

function runBasicSafetyChecks(opportunity, config = RISK_CONFIG) {
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

// Backwards-compatible alias: existing callers (paper mode, older tests)
// keep using the fast synchronous heuristic checks.
const runSafetyChecks = runBasicSafetyChecks;

/**
 * Runs the on-chain safety provider (mint/freeze authority, holder
 * concentration, LP lock/burn, honeypot sell simulation) and folds the
 * results into the basic heuristic checks. Only used in live mode, where a
 * safetyProvider is available; paper mode has no on-chain data to check.
 *
 * The computed on-chain rugScore takes precedence over any static rugScore
 * supplied via watchlist JSON, since a hand-entered number can't be trusted
 * on its own.
 */
async function runDeepSafetyChecks(opportunity, config = RISK_CONFIG, safetyProvider, { sellAmountRaw = null } = {}) {
  const basic = runBasicSafetyChecks(opportunity, config);
  if (!safetyProvider) {
    return { ...basic, onChain: null };
  }

  const onChain = await safetyProvider.evaluate(opportunity, { sellAmountRaw });
  const reasons = [...basic.reasons];

  if (config.requireMintAuthorityRevoked && onChain.authority?.mintAuthorityActive !== false) {
    reasons.push('mint-authority-not-revoked');
  }
  if (config.requireFreezeAuthorityRevoked && onChain.authority?.freezeAuthorityActive !== false) {
    reasons.push('freeze-authority-not-revoked');
  }
  if (
    config.maxTopHolderPct != null &&
    typeof onChain.holders?.topHolderPct === 'number' &&
    onChain.holders.topHolderPct > config.maxTopHolderPct
  ) {
    reasons.push('holder-concentration-too-high');
  }
  if (config.requireLpLockedOrBurned && !['locked', 'burned'].includes(onChain.lpStatus?.lpStatus)) {
    reasons.push('lp-not-locked-or-burned');
  }
  if (config.honeypotSellCheck && onChain.honeypot?.sellable === false) {
    reasons.push('honeypot-sell-check-failed');
  }

  return {
    safe: reasons.length === 0,
    reasons,
    onChain
  };
}

module.exports = { runSafetyChecks, runBasicSafetyChecks, runDeepSafetyChecks };
