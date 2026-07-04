class PaperExecutor {
  enter(state, opportunity, decision) {
    const entryPrice = opportunity.price;
    const quantity = decision.sizeSol / entryPrice;
    const position = {
      id: `${opportunity.pair}-${Date.now()}`,
      pair: opportunity.pair,
      venue: opportunity.venue,
      entryPrice,
      quantity,
      capitalSol: decision.sizeSol,
      tpPct: decision.tpPct,
      slPct: decision.slPct,
      highPriceSeen: entryPrice,
      // opportunity metadata stored for pattern analysis
      liquidityUsd: opportunity.liquidityUsd,
      momentumScore: opportunity.momentumScore,
      openedAt: new Date().toISOString()
    };
    state.bankrollSol -= decision.sizeSol;
    state.openPositions.push(position);
    return { position };
  }

  exit(state, position, priceNow) {
    const proceeds = position.quantity * priceNow;
    const pnlSol = proceeds - position.capitalSol;
    const pnlPct = pnlSol / position.capitalSol;
    state.bankrollSol += proceeds;
    state.openPositions = state.openPositions.filter((p) => p.id !== position.id);
    state.realizedPnlSol += pnlSol;
    return { positionId: position.id, priceNow, pnlSol, pnlPct, proceeds, venue: position.venue };
  }
}

module.exports = { PaperExecutor };
