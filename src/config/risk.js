const RISK_CONFIG = {
  // Bankroll & goal
  startingBankrollSol: 0.1,
  goalSol: 2.0,
  goalDurationMs: 24 * 60 * 60 * 1000,

  // Position sizing (council: increase to 0.195 — 100% win rate justifies larger allocation)
  maxPositionPct: 0.195,
  maxSlippagePct: 0.08,

  // Daily / drawdown guards (relaxed for paper-mode exploration)
  maxDailyLossPct: 0.50,
  maxDrawdownPct: 0.50,

  // Safety filters (relaxed for real market data)
  // Established tokens have lower momentum scores than the synthetic feed produced.
  minLiquidityUsd: 10000,
  maxRugScore: 0.3,
  // Council directive: raise minMomentumScore to 0.65 — high momentum (>0.75) shows 98.5% win rate
  minMomentumScore: 0.65,
  blockedTokenKeywords: ['honeypot', 'blacklist', 'tax-100', 'rug'],
  supportedVenues: ['solana/raydium', 'solana/pump.fun', 'bsc/pancakeswap'],

  // On-chain safety checks (live mode only; require a SolanaSafetyProvider)
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  requireLpLockedOrBurned: true,
  honeypotSellCheck: true,
  maxTopHolderPct: 0.5,
  safetyCacheTtlMs: 60_000,

  // Entry edge requirement (calibrated for real DexScreener market data)
  // Real token prices produce smaller momentum/edge signals than the synthetic feed.
  minExpectedEdge: 0.08,
  minRiskAdjustedScore: 0.04,

  // Take-profit / stop-loss
  // The Agent Council found that direct SL exits have 0% win rate while
  // trailing stops have 100% win rate. The fix: trail activates sooner
  // (5% gain) with a tighter trail (4%), while SL is widened to 15% as
  // an emergency safety net for catastrophic drops only.
  takeProfitBasePct: 0.16,
  takeProfitConfidenceScale: 0.22,
  stopLossBasePct: 0.15,
  stopLossConfidenceScale: 0.08,

  // Trailing stop: activates once a position gains trailActivatePct
  // Lower activation + tighter trail = trailing stops become the PRIMARY exit
  trailActivatePct: 0.05,
  trailPct: 0.04,

  // Execution quality controls
  maxExpectedSlippageBps: 180,
  minDepthScore: 0.35,
  maxExecutionFailureRate: 0.2,

  // Portfolio concentration controls
  maxVenueExposurePct: 0.5,
  maxTokenCategoryExposurePct: 0.35,
  maxCorrelatedPairExposurePct: 0.3,

  // Regime adaptation
  // Council directive: increase aggression in bear (100% win rate) and bull (96.9% win rate)
  regimeMultipliers: {
    bull: 1.15,
    chop: 0.92,
    bear: 0.95
  },
  volatilityRegimeMultipliers: {
    low: 1.05,
    mid: 1,
    high: 0.82
  },

  // Variant scoring / walk-forward validation
  walkForwardWindow: 20,
  variantStabilityWeight: 0.25,
  variantRiskWeight: 0.4,
  variantGrowthWeight: 0.35,

  learning: {
    perfBiasBase: 0.5,
    perfBiasMin: 0.2,
    perfBiasMax: 0.9,
    perfEmaAlpha: 0.3,
    pumpFunVenueBias: 0.4,
    defaultVenueBias: 0.55,
    liquidityBiasMax: 0.25,
    liquidityBiasDivider: 200000,
    finalScoreMin: 0.1,
    finalScoreMax: 0.95,
    perfWeight: 0.5,
    venueWeight: 0.3
  }
};

// Strategy variants used by StrategyVariantAgent for multi-sim pattern discovery.
// Each variant overrides specific fields from RISK_CONFIG.
const STRATEGY_VARIANTS = [
  {
    name: 'conservative',
    ...RISK_CONFIG,
    minExpectedEdge: 0.25,
    minRiskAdjustedScore: 0.12,
    maxPositionPct: 0.12,
    minMomentumScore: 0.55,
    stopLossBasePct: 0.12,
    stopLossConfidenceScale: 0.06,
    takeProfitBasePct: 0.14,
    takeProfitConfidenceScale: 0.20,
    maxDailyLossPct: 0.08,
    maxDrawdownPct: 0.10,
    minLiquidityUsd: 50000,
    trailActivatePct: 0.04,
    trailPct: 0.03,
    minRiskAdjustedScore: 0.2,
    maxExpectedSlippageBps: 120,
    maxVenueExposurePct: 0.4,
    maxTokenCategoryExposurePct: 0.3
  },
  {
    name: 'balanced',
    ...RISK_CONFIG
  },
  {
    name: 'aggressive',
    ...RISK_CONFIG,
    minExpectedEdge: 0.15,
    maxPositionPct: 0.25,
    minMomentumScore: 0.70,
    stopLossBasePct: 0.18,
    stopLossConfidenceScale: 0.10,
    takeProfitBasePct: 0.18,
    takeProfitConfidenceScale: 0.24,
    maxDailyLossPct: 0.15,
    maxDrawdownPct: 0.20,
    minLiquidityUsd: 15000,
    trailActivatePct: 0.06,
    trailPct: 0.05,
    minRiskAdjustedScore: 0.12,
    maxExpectedSlippageBps: 220,
    maxVenueExposurePct: 0.65,
    maxTokenCategoryExposurePct: 0.45
  }
];

module.exports = { RISK_CONFIG, STRATEGY_VARIANTS };
