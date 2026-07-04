const { GoalAgent } = require('./goalAgent');
const { PatternAgent } = require('./patternAgent');
const { StrategyVariantAgent } = require('./strategyVariantAgent');
const { LearningEngine } = require('../learning/learningEngine');
const { TradeLogger } = require('../learning/tradeLogger');
const { StrategyEngine } = require('../strategy/strategyEngine');
const { PaperExecutor } = require('../execution/paperExecutor');
const { PaperTradingSimulator } = require('../simulator/paperTradingSimulator');
const { equityOf } = require('../simulator/multiStrategySimulator');
const { RISK_CONFIG } = require('../config/risk');

/**
 * OrchestratorAgent coordinates all sub-agents to pursue the hardcoded goal of
 * growing 0.1 SOL → 2 SOL within 24 hours.
 *
 * Each `runCycle(priceMap)` call:
 *  1. Checks goal / deadline — returns { stop: true } if done.
 *  2. Advances all variant simulators (pattern discovery).
 *  3. PatternAgent analyses cumulative trade logs.
 *  4. Hot-swaps the main simulator's strategy to the best-performing variant.
 *  5. Advances the main simulator.
 *  6. Returns a full cycle report.
 */
class OrchestratorAgent {
  /**
   * @param {object} opts
   * @param {object} opts.feed            - Opportunity feed (implements .list())
   * @param {object} [opts.goalAgent]     - GoalAgent instance (created if omitted)
   * @param {object} [opts.patternAgent]  - PatternAgent instance (created if omitted)
   * @param {object} [opts.variantAgent]  - StrategyVariantAgent instance (created if omitted)
   * @param {object} [opts.config]        - Base risk config (defaults to RISK_CONFIG)
   */
  constructor({ feed, goalAgent, patternAgent, variantAgent, config = RISK_CONFIG }) {
    this.feed = feed;
    this.config = config;
    this.cycleCount = 0;

    this.goalAgent = goalAgent || new GoalAgent({
      goalSol: config.goalSol,
      durationMs: config.goalDurationMs
    });

    this.patternAgent = patternAgent || new PatternAgent();

    this.variantAgent = variantAgent || new StrategyVariantAgent({ feed });

    // Main simulator — strategy config is hot-swapped after each variant cycle
    this._mainLearning = new LearningEngine(config);
    this._mainLogger = new TradeLogger();
    this._mainStrategy = new StrategyEngine({ learningEngine: this._mainLearning, config });
    this._mainExecutor = new PaperExecutor();
    this.mainSimulator = new PaperTradingSimulator({
      strategy: this._mainStrategy,
      executor: this._mainExecutor,
      logger: this._mainLogger,
      learning: this._mainLearning,
      feed,
      config
    });

    // Tracks the active variant name driving the main sim
    this.activeVariantName = 'balanced';

    // Price state for synthetic ticks
    this._prices = {};
    for (const opp of feed.list()) {
      this._prices[opp.pair] = opp.price;
    }
  }

  /**
   * Advance prices using a momentum-biased random walk.
   * Callers can also supply an explicit priceMap (e.g. from a real feed).
   */
  tickPrices(externalPriceMap = null) {
    if (externalPriceMap) {
      this._prices = { ...this._prices, ...externalPriceMap };
      return { ...this._prices };
    }
    const opps = this.feed.list();
    for (const opp of opps) {
      const momentum = opp.momentumScore - 0.5; // bias: positive momentum → upward drift
      const volatility = opp.volatilityRisk;
      const drift = momentum * 0.04;
      const noise = (Math.random() - 0.5) * volatility * 0.15;
      this._prices[opp.pair] = Math.max(
        1e-8,
        this._prices[opp.pair] * (1 + drift + noise)
      );
    }
    return { ...this._prices };
  }

  /**
   * Run one full orchestration cycle.
   * @param {object|null} externalPriceMap  - If provided, used instead of synthetic prices.
   * @returns {object} cycle report
   */
  runCycle(externalPriceMap = null) {
    this.cycleCount += 1;
    const priceMap = this.tickPrices(externalPriceMap);

    // 1. Goal check — hard stop
    const goalStatus = this.goalAgent.checkGoal(this.mainSimulator.state);
    if (goalStatus.stop) {
      return {
        stop: true,
        reason: goalStatus.achieved ? 'goal-achieved' : 'time-expired',
        cycle: this.cycleCount,
        goalStatus,
        mainState: this.mainSimulator.state
      };
    }

    // 2. Advance all variant simulators for pattern discovery
    const variantSummary = this.variantAgent.runCycle(priceMap);

    // 3. Analyse accumulated patterns from variant trade logs
    const allVariantLogs = this.variantAgent.instances
      .flatMap((inst) => inst.logger.all());
    const patterns = this.patternAgent.analyze(allVariantLogs);

    // 4. Hot-swap main strategy to best-performing variant config
    const bestConfig = this.variantAgent.getBestVariantConfig();
    if (bestConfig.name !== this.activeVariantName) {
      this.activeVariantName = bestConfig.name || this.activeVariantName;
      // Replace the strategy config in-place (learning history is intentionally preserved)
      this._mainStrategy.config = bestConfig;
      this.mainSimulator.config = bestConfig;
    }

    // 5. Advance main simulator
    this.mainSimulator.runCycle();
    this.mainSimulator.processMarketTick(priceMap);

    // 6. Final goal re-check (position may have exited this cycle)
    const goalStatusPost = this.goalAgent.checkGoal(this.mainSimulator.state);

    return {
      stop: goalStatusPost.stop,
      reason: goalStatusPost.achieved ? 'goal-achieved' : goalStatusPost.expired ? 'time-expired' : null,
      cycle: this.cycleCount,
      goalStatus: goalStatusPost,
      activeVariant: this.activeVariantName,
      variantSummary,
      patterns,
      mainState: {
        bankrollSol: this.mainSimulator.state.bankrollSol,
        realizedPnlSol: this.mainSimulator.state.realizedPnlSol,
        openPositions: this.mainSimulator.state.openPositions.length,
        equity: equityOf(this.mainSimulator.state),
        circuitBreaker: this.mainSimulator.state.circuitBreaker,
        drawdownPct: this.mainSimulator.state.drawdownPct,
        dailyLossPct: this.mainSimulator.state.dailyLossPct
      }
    };
  }

  get logger() {
    return this._mainLogger;
  }
}

module.exports = { OrchestratorAgent };
