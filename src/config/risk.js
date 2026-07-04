const RISK_CONFIG = {
  startingBankrollSol: 0.1,
  maxPositionPct: 0.2,
  maxSlippagePct: 0.08,
  maxDailyLossPct: 0.25,
  maxDrawdownPct: 0.3,
  minLiquidityUsd: 10000,
  blockedTokenKeywords: ["honeypot", "blacklist", "tax-100", "rug"],
  supportedVenues: ["solana/raydium", "solana/pump.fun", "bsc/pancakeswap"],
  minExpectedEdge: 0.15,
  takeProfitBasePct: 0.2,
  takeProfitConfidenceScale: 0.25,
  stopLossBasePct: 0.08,
  stopLossConfidenceScale: 0.1,
  learning: {
    perfBiasBase: 0.5,
    perfBiasMin: 0.2,
    perfBiasMax: 0.9,
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

module.exports = { RISK_CONFIG };
