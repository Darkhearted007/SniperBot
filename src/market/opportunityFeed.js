function createOpportunityFeed() {
  const seed = [
    { pair: 'SOL/NEW1', tokenName: 'Nova Alpha', symbol: 'NOVA', venue: 'solana/raydium', liquidityUsd: 55000, rugScore: 0.1, momentumScore: 0.8, volatilityRisk: 0.2, price: 0.015 },
    { pair: 'SOL/NEW2', tokenName: 'Meme Rug', symbol: 'RUGMAX', venue: 'solana/pump.fun', liquidityUsd: 9000, rugScore: 0.7, momentumScore: 0.95, volatilityRisk: 0.4, price: 0.002 },
    { pair: 'BNB/NEW3', tokenName: 'BSC Rocket', symbol: 'BRKT', venue: 'bsc/pancakeswap', liquidityUsd: 125000, rugScore: 0.2, momentumScore: 0.7, volatilityRisk: 0.25, price: 0.03 }
  ];

  return {
    list() {
      return seed;
    }
  };
}

module.exports = { createOpportunityFeed };
