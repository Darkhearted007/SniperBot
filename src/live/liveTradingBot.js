const { RISK_CONFIG } = require('../config/risk');
const { runSafetyChecks } = require('../safety/tokenSafety');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

class LiveTradingBot {
  constructor({ strategy, executor, logger, learning, feed, goalAgent, config = RISK_CONFIG }) {
    this.strategy = strategy;
    this.executor = executor;
    this.logger = logger;
    this.learning = learning;
    this.feed = feed;
    this.goalAgent = goalAgent;
    this.config = config;
    this.state = {
      bankrollSol: 0,
      openPositions: [],
      realizedPnlSol: 0,
      dailyLossPct: 0,
      drawdownPct: 0,
      circuitBreaker: false,
      highWatermark: 0,
      realizedPnlTodaySol: 0,
      activeDay: todayUtc()
    };
    this.initialized = false;
  }

  async initialize() {
    this.state.bankrollSol = await this.executor.getInitialBankrollSol();
    if (this.state.bankrollSol <= 0) {
      throw new Error('Live trading requires a positive managed bankroll after reserve/cap settings');
    }
    this.config = { ...this.config, startingBankrollSol: this.state.bankrollSol };
    this.strategy.config = this.config;
    this.state.highWatermark = Math.max(this.state.bankrollSol, Number.EPSILON);
    this.initialized = true;
    return this.state;
  }

  resetDailyIfNeeded() {
    const day = todayUtc();
    if (this.state.activeDay !== day) {
      this.state.activeDay = day;
      this.state.realizedPnlTodaySol = 0;
      this.state.dailyLossPct = 0;
    }
  }

  async processOpportunity(opportunity) {
    this.resetDailyIfNeeded();
    const safety = runSafetyChecks(opportunity, this.config);
    const decision = this.strategy.decide({ state: this.state, opportunity, safety });
    this.logger.logDecision({ opportunity, safety, decision, state: { bankrollSol: this.state.bankrollSol } });

    if (decision.action === 'ENTER' && decision.sizeSol > 0) {
      const execution = await this.executor.enter(this.state, opportunity, decision);
      this.logger.logExecution({ kind: 'enter', opportunity, execution, decision });
      return execution;
    }
    return null;
  }

  async processMarketTick(priceMap) {
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
        const execution = await this.executor.exit(this.state, position, priceNow);
        this.state.realizedPnlTodaySol += execution.pnlSol;
        this.learning.learn(execution);
        this.logger.logExecution({ kind: 'exit', position, execution, exitDecision });
      }
    }

    const cfg = this.config;
    const equity = this.state.bankrollSol + this.state.openPositions.reduce((sum, p) => sum + p.capitalSol, 0);
    const baselineWatermark = this.state.highWatermark > 0
      ? this.state.highWatermark
      : Math.max(cfg.startingBankrollSol, Number.EPSILON);
    this.state.highWatermark = Math.max(baselineWatermark, equity);
    this.state.drawdownPct = 1 - (equity / this.state.highWatermark);
    this.state.dailyLossPct = Math.max(0, -this.state.realizedPnlTodaySol / cfg.startingBankrollSol);
    if (this.state.drawdownPct >= cfg.maxDrawdownPct || this.state.dailyLossPct >= cfg.maxDailyLossPct) {
      this.state.circuitBreaker = true;
    }
    await this.executor.syncBankroll(this.state);
  }

  async runCycle() {
    if (!this.initialized) {
      await this.initialize();
    }
    const opportunities = await this.feed.list();
    for (const opportunity of opportunities) {
      await this.processOpportunity(opportunity);
    }
    const priceMap = Object.fromEntries(opportunities.map((opportunity) => [opportunity.pair, opportunity.price]));
    await this.processMarketTick(priceMap);
    return {
      goalStatus: this.goalAgent ? this.goalAgent.summary(this.state) : null,
      bankrollSol: this.state.bankrollSol,
      realizedPnlSol: this.state.realizedPnlSol,
      openPositions: this.state.openPositions.length
    };
  }
}

module.exports = { LiveTradingBot };
