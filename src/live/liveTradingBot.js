const { RISK_CONFIG } = require('../config/risk');
const { runSafetyChecks } = require('../safety/tokenSafety');

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

class LiveTradingBot {
  constructor({
    strategy,
    executor,
    logger,
    learning,
    feed,
    goalAgent,
    supervisionMode = false,
    approvalQueue = null,
    config = RISK_CONFIG
  }) {
    this.strategy = strategy;
    this.executor = executor;
    this.logger = logger;
    this.learning = learning;
    this.feed = feed;
    this.goalAgent = goalAgent;
    this.supervisionMode = supervisionMode;
    this.approvalQueue = approvalQueue;
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

  queueDecision(payload) {
    if (!this.supervisionMode || !this.approvalQueue) return null;
    return this.approvalQueue.upsert(payload);
  }

  getPendingDecisions() {
    return this.approvalQueue ? this.approvalQueue.listPending() : [];
  }

  getDecisionHistory() {
    return this.approvalQueue ? this.approvalQueue.listHistory() : [];
  }

  getActiveWatchlist() {
    return typeof this.feed.getActiveWatchlist === 'function' ? this.feed.getActiveWatchlist() : [];
  }

  async approvePendingDecision(id) {
    if (!this.supervisionMode || !this.approvalQueue) {
      throw new Error('Trade supervision is not enabled');
    }

    const pending = this.approvalQueue.getPending(id);
    if (!pending) {
      throw new Error(`Pending decision ${id} was not found`);
    }

    if (pending.kind === 'enter') {
      const execution = await this.executor.enter(this.state, pending.opportunity, pending.decision);
      this.logger.logExecution({
        kind: 'enter',
        opportunity: pending.opportunity,
        execution,
        decision: pending.decision,
        supervision: { status: 'approved', decisionId: pending.id }
      });
      this.approvalQueue.resolve(id, 'approved', { execution });
      return execution;
    }

    const position = this.state.openPositions.find((candidate) => candidate.id === pending.position?.id);
    if (!position) {
      this.approvalQueue.resolve(id, 'expired', { reason: 'position-no-longer-open' });
      throw new Error(`Pending exit decision ${id} no longer has an open position`);
    }

    const execution = await this.executor.exit(this.state, position);
    this.state.realizedPnlTodaySol += execution.pnlSol;
    this.learning.learn(execution);
    this.logger.logExecution({
      kind: 'exit',
      position,
      execution,
      exitDecision: pending.exitDecision,
      supervision: { status: 'approved', decisionId: pending.id }
    });
    this.approvalQueue.resolve(id, 'approved', { execution });
    return execution;
  }

  rejectPendingDecision(id, reason = 'manually-rejected') {
    if (!this.supervisionMode || !this.approvalQueue) {
      throw new Error('Trade supervision is not enabled');
    }

    const rejected = this.approvalQueue.reject(id, reason);
    this.logger.logDecision({
      supervision: {
        action: 'REJECT',
        kind: rejected.kind,
        decisionId: rejected.id,
        reason
      }
    });
    return rejected;
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

    if (decision.action === 'ENTER' && decision.sizeSol > 0) {
      if (this.supervisionMode) {
        const pending = this.queueDecision({
          key: `enter:${opportunity.pair}`,
          kind: 'enter',
          opportunity,
          decision
        });
        this.logger.logDecision({
          opportunity,
          safety,
          decision,
          state: { bankrollSol: this.state.bankrollSol },
          supervision: { status: 'pending', kind: 'enter', decisionId: pending.id }
        });
        return null;
      }

      this.logger.logDecision({ opportunity, safety, decision, state: { bankrollSol: this.state.bankrollSol } });
      const execution = await this.executor.enter(this.state, opportunity, decision);
      this.logger.logExecution({ kind: 'enter', opportunity, execution, decision });
      return execution;
    }

    this.logger.logDecision({ opportunity, safety, decision, state: { bankrollSol: this.state.bankrollSol } });
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
      if (exitDecision.action === 'EXIT') {
        if (this.supervisionMode) {
          const pending = this.queueDecision({
            key: `exit:${position.id}`,
            kind: 'exit',
            position,
            exitDecision
          });
          this.logger.logDecision({
            position,
            exitDecision,
            supervision: { status: 'pending', kind: 'exit', decisionId: pending.id }
          });
          continue;
        }

        this.logger.logDecision({ position, exitDecision });
        const execution = await this.executor.exit(this.state, position, priceNow);
        this.state.realizedPnlTodaySol += execution.pnlSol;
        this.learning.learn(execution);
        this.logger.logExecution({ kind: 'exit', position, execution, exitDecision });
        continue;
      }
      this.logger.logDecision({ position, exitDecision });
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
      openPositions: this.state.openPositions.length,
      pendingDecisions: this.getPendingDecisions().length
    };
  }

  snapshot() {
    return {
      state: this.state,
      learning: typeof this.learning.snapshot === 'function' ? this.learning.snapshot() : null,
      log: typeof this.logger.snapshot === 'function' ? this.logger.snapshot(1000) : []
    };
  }

  restore(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.state && typeof snapshot.state === 'object') {
      this.state = { ...this.state, ...snapshot.state };
    }
    if (snapshot.learning && typeof this.learning.restore === 'function') {
      this.learning.restore(snapshot.learning);
    }
    if (Array.isArray(snapshot.log) && typeof this.logger.restore === 'function') {
      this.logger.restore(snapshot.log);
    }
  }
}

module.exports = { LiveTradingBot };
