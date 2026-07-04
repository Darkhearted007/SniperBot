const { fetchJupiterQuote, fetchJupiterSwap } = require('../live/jupiterClient');
const { LAMPORTS_PER_SOL } = require('../live/constants');

function solToLamports(sol) {
  // Lamports are integers, so any fractional lamport remainder is truncated;
  // callers must still provide a large enough SOL amount to reach at least 1 lamport.
  return Math.floor(Number(sol) * LAMPORTS_PER_SOL);
}

class SolanaLiveExecutor {
  constructor({
    client,
    fetchImpl = fetch,
    quoteApiBase,
    swapApiBase,
    slippageBps = 100,
    minSolReserve = 0.02,
    maxBankrollSol = null
  }) {
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.quoteApiBase = quoteApiBase;
    this.swapApiBase = swapApiBase;
    this.slippageBps = slippageBps;
    this.minSolReserve = minSolReserve;
    this.maxBankrollSol = maxBankrollSol;
  }

  async getActualFreeSol() {
    const onChainBalance = await this.client.getBalanceSol();
    return Math.max(0, onChainBalance - this.minSolReserve);
  }

  async getInitialBankrollSol() {
    const freeSol = await this.getActualFreeSol();
    if (this.maxBankrollSol == null) {
      return freeSol;
    }
    return Math.max(0, Math.min(freeSol, this.maxBankrollSol));
  }

  async syncBankroll(state) {
    const freeSol = await this.getActualFreeSol();
    state.bankrollSol = Math.min(state.bankrollSol, freeSol);
  }

  async enter(state, opportunity, decision) {
    const inLamports = solToLamports(decision.sizeSol);
    if (inLamports <= 0) {
      throw new Error('Calculated live trade amount is too small');
    }

    const quote = await fetchJupiterQuote({
      fetchImpl: this.fetchImpl,
      quoteApiBase: this.quoteApiBase,
      inputMint: opportunity.inputMint,
      outputMint: opportunity.outputMint,
      amount: String(inLamports),
      slippageBps: this.slippageBps
    });
    const swap = await fetchJupiterSwap({
      fetchImpl: this.fetchImpl,
      swapApiBase: this.swapApiBase,
      quoteResponse: quote,
      userPublicKey: this.client.walletAddress
    });
    const { signature } = await this.client.signAndSendTransaction(swap.swapTransaction);

    const spentSol = Number(quote.inAmount) / LAMPORTS_PER_SOL;
    const rawTokenAmount = String(quote.outAmount);
    const quantity = Number(quote.outAmount) / (10 ** opportunity.decimals);
    const position = {
      id: `${opportunity.pair}-${signature}`,
      pair: opportunity.pair,
      venue: opportunity.venue,
      entryPrice: spentSol / quantity,
      quantity,
      rawTokenAmount,
      capitalSol: spentSol,
      tpPct: decision.tpPct,
      slPct: decision.slPct,
      highPriceSeen: spentSol / quantity,
      liquidityUsd: opportunity.liquidityUsd,
      momentumScore: opportunity.momentumScore,
      openedAt: new Date().toISOString(),
      inputMint: opportunity.inputMint,
      outputMint: opportunity.outputMint,
      decimals: opportunity.decimals,
      entrySignature: signature
    };

    state.bankrollSol = Math.max(0, state.bankrollSol - spentSol);
    state.openPositions.push(position);
    await this.syncBankroll(state);

    return { position, signature, quote };
  }

  async exit(state, position) {
    const quote = await fetchJupiterQuote({
      fetchImpl: this.fetchImpl,
      quoteApiBase: this.quoteApiBase,
      inputMint: position.outputMint,
      outputMint: position.inputMint,
      amount: position.rawTokenAmount,
      slippageBps: this.slippageBps
    });
    const swap = await fetchJupiterSwap({
      fetchImpl: this.fetchImpl,
      swapApiBase: this.swapApiBase,
      quoteResponse: quote,
      userPublicKey: this.client.walletAddress
    });
    const { signature } = await this.client.signAndSendTransaction(swap.swapTransaction);

    const proceeds = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const pnlSol = proceeds - position.capitalSol;
    const pnlPct = pnlSol / position.capitalSol;

    state.bankrollSol += proceeds;
    state.openPositions = state.openPositions.filter((candidate) => candidate.id !== position.id);
    state.realizedPnlSol += pnlSol;
    await this.syncBankroll(state);

    return {
      positionId: position.id,
      priceNow: proceeds / position.quantity,
      pnlSol,
      pnlPct,
      proceeds,
      venue: position.venue,
      signature
    };
  }
}

module.exports = { SolanaLiveExecutor };
