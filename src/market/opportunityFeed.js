function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Scales small drift values (~0.01-0.03) into a 0-1 regime-strength feature.
const REGIME_STRENGTH_SCALE = 20;

function createOpportunityFeed() {
  const seed = [
    {
      pair: 'SOL/NEW1',
      tokenName: 'Nova Alpha',
      symbol: 'NOVA',
      venue: 'solana/raydium',
      tokenCategory: 'utility',
      liquidityUsd: 55000,
      rugScore: 0.1,
      momentumScore: 0.8,
      volatilityRisk: 0.2,
      price: 0.015,
      expectedSlippageBps: 55,
      depthScore: 0.82,
      executionFailureRate: 0.02
    },
    {
      pair: 'SOL/NEW2',
      tokenName: 'Meme Rug',
      symbol: 'RUGMAX',
      venue: 'solana/pump.fun',
      tokenCategory: 'meme',
      liquidityUsd: 9000,
      rugScore: 0.7,
      momentumScore: 0.95,
      volatilityRisk: 0.4,
      price: 0.002,
      expectedSlippageBps: 250,
      depthScore: 0.2,
      executionFailureRate: 0.35
    },
    {
      pair: 'BNB/NEW3',
      tokenName: 'BSC Rocket',
      symbol: 'BRKT',
      venue: 'bsc/pancakeswap',
      tokenCategory: 'meme',
      liquidityUsd: 125000,
      rugScore: 0.2,
      momentumScore: 0.7,
      volatilityRisk: 0.25,
      price: 0.03,
      expectedSlippageBps: 70,
      depthScore: 0.77,
      executionFailureRate: 0.04
    },
    {
      pair: 'SOL/NEW4',
      tokenName: 'Cloud Compute',
      symbol: 'CCMP',
      venue: 'solana/raydium',
      tokenCategory: 'infra',
      liquidityUsd: 170000,
      rugScore: 0.08,
      momentumScore: 0.62,
      volatilityRisk: 0.18,
      price: 0.081,
      expectedSlippageBps: 40,
      depthScore: 0.9,
      executionFailureRate: 0.01
    }
  ];
  let cycle = 0;
  const prices = Object.fromEntries(seed.map((entry) => [entry.pair, entry.price]));

  return {
    list() {
      cycle += 1;
      const trendStates = ['bull', 'chop', 'bear'];
      const volatilityRegime = cycle % 9 < 3 ? 'low' : cycle % 9 < 6 ? 'mid' : 'high';
      const trendState = trendStates[Math.floor(cycle / 4) % trendStates.length];
      const trendShift = trendState === 'bull' ? 0.03 : trendState === 'bear' ? -0.02 : 0.005;
      const volMultiplier = volatilityRegime === 'high' ? 1.4 : volatilityRegime === 'mid' ? 1 : 0.65;

      return seed.map((entry, index) => {
        const noise = (Math.sin((cycle + index) * 0.73) + Math.cos((cycle + index * 3) * 0.35)) * 0.5;
        const movePct = trendShift + noise * 0.015 * volMultiplier;
        const nextPrice = Math.max(1e-8, prices[entry.pair] * (1 + movePct));
        prices[entry.pair] = nextPrice;

        const momentumScore = clamp(entry.momentumScore + movePct * 3, 0.05, 0.99);
        const volatilityRisk = clamp(entry.volatilityRisk * volMultiplier + Math.abs(noise) * 0.03, 0.05, 0.98);
        const expectedSlippageBps = Math.round(clamp(
          entry.expectedSlippageBps * (1 + volatilityRisk * 0.3 + (entry.depthScore < 0.5 ? 0.4 : 0)),
          10,
          400
        ));
        const executionFailureRate = clamp(
          entry.executionFailureRate + (volatilityRegime === 'high' ? 0.03 : -0.01),
          0.005,
          0.6
        );

        return {
          ...entry,
          price: nextPrice,
          momentumScore,
          volatilityRisk,
          expectedSlippageBps,
          executionFailureRate,
          marketContext: {
            trendState,
            volatilityRegime,
            regimeStrength: clamp(Math.abs(trendShift) * REGIME_STRENGTH_SCALE, 0.1, 1)
          }
        };
      });
    }
  };
}

module.exports = { createOpportunityFeed };
