const { RISK_CONFIG } = require('../config/risk');
const { runSafetyChecks } = require('../safety/tokenSafety');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

class PaperTradingSimulator {
  constructor({ strategy, executor, logger, learning, feed }) {
    this.strategy = strategy;
    this.executor = executor;
    this.logger = logger;
    this.learning = learning;
    this.feed = feed;
    this.state = {
      bankrollSol: RISK_CONFIG.startingBankrollSol,
      openPositions: [],
      realizedPnlSol: 0,
      dailyLossPct: 0,
      drawdownPct: 0,
      circuitBreaker: false,
      highWatermark: RISK_CONFIG.startingBankrollSol,
      realizedPnlTodaySol: 0,
      activeDay: todayUtc()
    };
  }

  resetDailyIfNeeded() {
    const day = todayUtc();
    if (this.state.activeDay !== day) {
      this.state.activeDay = day;
      this.state.realizedPnlTodaySol = 0;
      this.state.dailyLossPct = 0;
    }
  }

  processOpportunity(opportunity) {
    this.resetDailyIfNeeded();
    const safety = runSafetyChecks(opportunity);
    const decision = this.strategy.decide({ state: this.state, opportunity, safety });
    this.logger.logDecision({ opportunity, safety, decision, state: { bankrollSol: this.state.bankrollSol } });

    if (decision.action === 'ENTER' && decision.sizeSol > 0) {
      const execution = this.executor.enter(this.state, opportunity, decision);
      this.logger.logExecution({ kind: 'enter', opportunity, execution, decision });
      return execution;
    }
    return null;
  }

  processMarketTick(priceMap) {
    this.resetDailyIfNeeded();
    for (const position of [...this.state.openPositions]) {
      const priceNow = priceMap[position.pair];
      if (typeof priceNow !== 'number') {
        this.logger.logDecision({
          position,
          exitDecision: { action: 'HOLD', reason: 'missing-market-price' }
        });
        continue;
      }
      const exitDecision = this.strategy.exitDecision(position, priceNow);
      this.logger.logDecision({ position, exitDecision });
      if (exitDecision.action === 'EXIT') {
        const execution = this.executor.exit(this.state, position, priceNow);
        this.state.realizedPnlTodaySol += execution.pnlSol;
        this.learning.learn(execution);
        this.logger.logExecution({ kind: 'exit', position, execution, exitDecision });
      }
    }
    const equity = this.state.bankrollSol + this.state.openPositions.reduce((sum, p) => sum + p.capitalSol, 0);
    const baselineWatermark = this.state.highWatermark > 0 ? this.state.highWatermark : Math.max(RISK_CONFIG.startingBankrollSol, Number.EPSILON);
    this.state.highWatermark = Math.max(baselineWatermark, equity);
    this.state.drawdownPct = 1 - (equity / this.state.highWatermark);
    this.state.dailyLossPct = Math.max(0, -this.state.realizedPnlTodaySol / RISK_CONFIG.startingBankrollSol);
    if (this.state.drawdownPct >= RISK_CONFIG.maxDrawdownPct) this.state.circuitBreaker = true;
  }

  runCycle() {
    const opportunities = this.feed.list();
    opportunities.forEach((opp) => this.processOpportunity(opp));
    return this.state;
  }
}

module.exports = { PaperTradingSimulator };
