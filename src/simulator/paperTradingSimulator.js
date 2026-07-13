const { RISK_CONFIG } = require('../config/risk');
const { runSafetyChecks } = require('../safety/tokenSafety');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

class PaperTradingSimulator {
  constructor({ strategy, executor, logger, learning, feed, config = RISK_CONFIG }) {
    this.strategy = strategy;
    this.executor = executor;
    this.logger = logger;
    this.learning = learning;
    this.feed = feed;
    this.config = config;
    this.state = {
      bankrollSol: config.startingBankrollSol,
      openPositions: [],
      realizedPnlSol: 0,
      dailyLossPct: 0,
      drawdownPct: 0,
      circuitBreaker: false,
      highWatermark: config.startingBankrollSol,
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
    const safety = runSafetyChecks(opportunity, this.config);
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
    const cfg = this.config;
    const equity = this.state.bankrollSol + this.state.openPositions.reduce((sum, p) => sum + p.capitalSol, 0);
    const baselineWatermark = this.state.highWatermark > 0 ? this.state.highWatermark : Math.max(cfg.startingBankrollSol, Number.EPSILON);
    this.state.highWatermark = Math.max(baselineWatermark, equity);
    this.state.drawdownPct = 1 - (equity / this.state.highWatermark);
    this.state.dailyLossPct = Math.max(0, -this.state.realizedPnlTodaySol / cfg.startingBankrollSol);
    if (this.state.drawdownPct >= cfg.maxDrawdownPct) {
      this.state.circuitBreaker = true;
    } else if (this.state.drawdownPct < cfg.maxDrawdownPct * 0.7) {
      this.state.circuitBreaker = false;
    }
  }

  runCycle(externalOpportunities = null) {
    // When external opportunities are provided (e.g. from the orchestrator),
    // use them instead of calling feed.list(). This ensures a single source
    // of truth for prices in each orchestration cycle and eliminates desync
    // between the feed's price system and the orchestrator's price map.
    const opportunities = externalOpportunities || this.feed.list();
    opportunities.forEach((opp) => this.processOpportunity(opp));
    return this.state;
  }
}

module.exports = { PaperTradingSimulator };
