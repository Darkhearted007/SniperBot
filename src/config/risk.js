const RISK_CONFIG = {
  // Bankroll & goal
  startingBankrollSol: 0.1,
  goalSol: 2.0,
  goalDurationMs: 24 * 60 * 60 * 1000,

  // Position sizing
  maxPositionPct: 0.15,
  maxSlippagePct: 0.08,

  // Daily / drawdown guards (tightened for capital preservation)
  maxDailyLossPct: 0.10,
  maxDrawdownPct: 0.15,

  // Safety filters
  minLiquidityUsd: 25000,
  maxRugScore: 0.3,
  minMomentumScore: 0.60,
  blockedTokenKeywords: ['honeypot', 'blacklist', 'tax-100', 'rug'],
  supportedVenues: ['solana/raydium', 'solana/pump.fun', 'bsc/pancakeswap'],

  // On-chain safety checks (live mode only; require a SolanaSafetyProvider)
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  requireLpLockedOrBurned: true,
  honeypotSellCheck: true,
  maxTopHolderPct: 0.5,
  safetyCacheTtlMs: 60_000,

  // Entry edge requirement
  minExpectedEdge: 0.25,
  minRiskAdjustedScore: 0.18,

  // Take-profit / stop-loss (asymmetric R:R ~6:1)
  takeProfitBasePct: 0.25,
  takeProfitConfidenceScale: 0.30,
  stopLossBasePct: 0.05,
  stopLossConfidenceScale: 0.10,

  // Trailing stop: activates once a position gains trailActivatePct
  trailActivatePct: 0.10,
  trailPct: 0.05,

  // Execution quality controls
  maxExpectedSlippageBps: 180,
  minDepthScore: 0.35,
  maxExecutionFailureRate: 0.2,

  // Portfolio concentration controls
  maxVenueExposurePct: 0.5,
  maxTokenCategoryExposurePct: 0.35,
  maxCorrelatedPairExposurePct: 0.3,

  // Regime adaptation
  regimeMultipliers: {
    bull: 1.12,
    chop: 0.92,
    bear: 0.78
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
    minExpectedEdge: 0.35,
    maxPositionPct: 0.10,
    stopLossBasePct: 0.04,
    stopLossConfidenceScale: 0.06,
    takeProfitBasePct: 0.40,
    takeProfitConfidenceScale: 0.30,
    maxDailyLossPct: 0.08,
    maxDrawdownPct: 0.10,
    minLiquidityUsd: 50000,
    trailActivatePct: 0.08,
    trailPct: 0.04,
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
    maxPositionPct: 0.20,
    stopLossBasePct: 0.07,
    stopLossConfidenceScale: 0.10,
    takeProfitBasePct: 0.25,
    takeProfitConfidenceScale: 0.20,
    maxDailyLossPct: 0.15,
    maxDrawdownPct: 0.20,
    minLiquidityUsd: 15000,
    trailActivatePct: 0.12,
    trailPct: 0.06,
    minRiskAdjustedScore: 0.12,
    maxExpectedSlippageBps: 220,
    maxVenueExposurePct: 0.65,
    maxTokenCategoryExposurePct: 0.45
  }
];

module.exports = { RISK_CONFIG, STRATEGY_VARIANTS };
