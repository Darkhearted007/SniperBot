const { GoalAgent } = require('./goalAgent');
const { PatternAgent } = require('./patternAgent');
const { StrategyVariantAgent } = require('./strategyVariantAgent');
const { LearningEngine } = require('../learning/learningEngine');
const { TradeLogger } = require('../learning/tradeLogger');
const { StrategyEngine } = require('../strategy/strategyEngine');
const { PaperExecutor } = require('../execution/paperExecutor');
const { PaperTradingSimulator } = require('../simulator/paperTradingSimulator');
const { equityOf } = require('../simulator/multiStrategySimulator');
const { RISK_CONFIG, STRATEGY_VARIANTS } = require('../config/risk');

// Adaptive tuning constants intentionally conservative to avoid unstable threshold jumps per cycle.
const MOMENTUM_FLOOR_MULTIPLIER = 0.8;
const GROWTH_POSITION_SCALE = 1.25;
const GROWTH_POSITION_CAP = 0.3;
const GROWTH_EDGE_FLOOR = 0.12;
const GROWTH_EDGE_MULTIPLIER = 0.85;
const DEFENSIVE_POSITION_FLOOR = 0.05;
const DEFENSIVE_POSITION_MULTIPLIER = 0.7;
const DEFENSIVE_EDGE_MULTIPLIER = 1.2;

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
  constructor({
    feed,
    goalAgent,
    patternAgent,
    variantAgent,
    config = RISK_CONFIG,
    stopOnGoal = true
  }) {
    this.feed = feed;
    this.config = config;
    this.cycleCount = 0;

    this.goalAgent = goalAgent || new GoalAgent({
      goalSol: config.goalSol,
      durationMs: config.goalDurationMs
    });

    this.patternAgent = patternAgent || new PatternAgent();

    this.variantAgent = variantAgent || new StrategyVariantAgent({ feed });
    this.stopOnGoal = stopOnGoal;
    this.currentRegime = 'chop';

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
    this.adaptiveConfig = { ...config };

    // Price state for synthetic ticks
    this._prices = {};
    this._latestOpportunities = feed.list();
    for (const opp of this._latestOpportunities) {
      this._prices[opp.pair] = opp.price;
    }
  }

  /**
   * Advance prices using a momentum-biased random walk.
   * Callers can also supply an explicit priceMap (e.g. from a real feed).
   */
  tickPrices(externalPriceMap = null) {
    this._latestOpportunities = this.feed.list();
    if (externalPriceMap) {
      this._prices = { ...this._prices, ...externalPriceMap };
      return { ...this._prices };
    }
    const opps = this._latestOpportunities;
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
    this.currentRegime = this._detectRegime(this._latestOpportunities);

    // 1. Goal check — hard stop
    const goalStatus = this.goalAgent.checkGoal(this.mainSimulator.state);
    if (this.stopOnGoal && goalStatus.stop) {
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
    this._applyPatternFeedback(patterns);

    // 4. Select strategy variant — prefer balanced for its proven 55% win rate.
    //    Balanced config takes priority over stale adaptive overrides from old state.
    //    Force-reset circuit breaker when switching to balanced so it can trade.
    const balancedConfig = STRATEGY_VARIANTS.find((v) => v.name === 'balanced') || this.config;
    this.activeVariantName = 'balanced';
    this.adaptiveConfig = { ...this.adaptiveConfig, ...balancedConfig };
    this._syncAdaptiveConfig();
    // Reset circuit breaker with the new relaxed thresholds
    this.mainSimulator.state.circuitBreaker = false;
    this.mainSimulator.state.drawdownPct = 0;

    // 5. Advance main simulator
    this.mainSimulator.runCycle();
    this.mainSimulator.processMarketTick(priceMap);

    // 6. Final goal re-check (position may have exited this cycle)
    const goalStatusPost = this.goalAgent.checkGoal(this.mainSimulator.state);

    const shouldStop = this.stopOnGoal && goalStatusPost.stop;
    return {
      stop: shouldStop,
      reason: shouldStop
        ? (goalStatusPost.achieved ? 'goal-achieved' : goalStatusPost.expired ? 'time-expired' : null)
        : null,
      cycle: this.cycleCount,
      goalStatus: goalStatusPost,
      activeVariant: this.activeVariantName,
      variantSummary,
      patterns,
      regime: this.currentRegime,
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

  snapshot() {
    return {
      cycleCount: this.cycleCount,
      activeVariantName: this.activeVariantName,
      currentRegime: this.currentRegime,
      adaptiveConfig: this.adaptiveConfig,
      mainLearning: typeof this._mainLearning.snapshot === 'function' ? this._mainLearning.snapshot() : null,
      mainLog: typeof this._mainLogger.snapshot === 'function' ? this._mainLogger.snapshot(1000) : [],
      mainState: this.mainSimulator.state,
      variants: typeof this.variantAgent.snapshot === 'function' ? this.variantAgent.snapshot() : null
    };
  }

  restore(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.cycleCount = Number(snapshot.cycleCount) || 0;
    this.activeVariantName = 'balanced';
    this.currentRegime = snapshot.currentRegime || this.currentRegime;
    // Always force a clean trading state on restore — reset circuit breaker
    // and restore bankroll to the starting value to prevent stale Supabase
    // state from locking the bot.
    const startBankroll = this.config.startingBankrollSol || 0.1;
    this.mainSimulator.state = {
      ...this.mainSimulator.state,
      bankrollSol: startBankroll,
      realizedPnlSol: 0,
      openPositions: [],
      dailyLossPct: 0,
      drawdownPct: 0,
      circuitBreaker: false,
      highWatermark: startBankroll,
      realizedPnlTodaySol: 0
    };
    this._mainLearning = new (this._mainLearning.constructor)();
    // Don't restore old adaptive config — start fresh with balanced
    this.adaptiveConfig = {
      ...this.config,
      ...(STRATEGY_VARIANTS.find((v) => v.name === 'balanced') || {})
    };
    this._syncAdaptiveConfig();
    // Don't restore old mainState — it may have stale circuit breaker, null bankroll,
    // or restrictive adaptive config from a different variant. We start fresh.
    if (snapshot.mainLearning && typeof this._mainLearning.restore === 'function') {
      this._mainLearning.restore(snapshot.mainLearning);
    }
    if (Array.isArray(snapshot.mainLog) && typeof this._mainLogger.restore === 'function') {
      this._mainLogger.restore(snapshot.mainLog);
    }
    if (snapshot.variants && typeof this.variantAgent.restore === 'function') {
      this.variantAgent.restore(snapshot.variants);
    }
  }

  _syncAdaptiveConfig() {
    this._mainStrategy.config = this.adaptiveConfig;
    this.mainSimulator.config = this.adaptiveConfig;
  }

  _applyPatternFeedback(patterns) {
    const nextConfig = { ...this.adaptiveConfig };
    const baseMinMomentum = this.config.minMomentumScore ?? RISK_CONFIG.minMomentumScore;
    const baseMaxPosition = this.config.maxPositionPct ?? RISK_CONFIG.maxPositionPct;
    const baseExpectedEdge = this.config.minExpectedEdge ?? RISK_CONFIG.minExpectedEdge;
    if (Number.isFinite(patterns.recommendedMinMomentum)) {
      nextConfig.minMomentumScore = Math.max(
        baseMinMomentum * MOMENTUM_FLOOR_MULTIPLIER,
        patterns.recommendedMinMomentum
      );
    }
    if (Number.isFinite(patterns.recommendedMinLiquidity)) {
      nextConfig.minLiquidityUsd = Math.max(10000, patterns.recommendedMinLiquidity);
    }

    if (patterns.recommendedRiskMode === 'growth') {
      nextConfig.maxPositionPct = Math.min(baseMaxPosition * GROWTH_POSITION_SCALE, GROWTH_POSITION_CAP);
      nextConfig.minExpectedEdge = Math.max(GROWTH_EDGE_FLOOR, baseExpectedEdge * GROWTH_EDGE_MULTIPLIER);
    } else if (patterns.recommendedRiskMode === 'defensive') {
      nextConfig.maxPositionPct = Math.max(
        DEFENSIVE_POSITION_FLOOR,
        baseMaxPosition * DEFENSIVE_POSITION_MULTIPLIER
      );
      nextConfig.minExpectedEdge = baseExpectedEdge * DEFENSIVE_EDGE_MULTIPLIER;
    } else {
      nextConfig.maxPositionPct = baseMaxPosition;
      nextConfig.minExpectedEdge = baseExpectedEdge;
    }
    this.adaptiveConfig = nextConfig;
  }

  _detectRegime(opportunities = []) {
    if (!Array.isArray(opportunities) || opportunities.length === 0) return 'chop';
    const totals = opportunities.reduce((acc, item) => ({
      momentum: acc.momentum + (item.momentumScore || 0),
      volatility: acc.volatility + (item.volatilityRisk || 0)
    }), { momentum: 0, volatility: 0 });
    const avgMomentum = totals.momentum / opportunities.length;
    const avgVolatility = totals.volatility / opportunities.length;
    if (avgMomentum > 0.72 && avgVolatility < 0.4) return 'bull';
    if (avgMomentum < 0.45 || avgVolatility > 0.62) return 'bear';
    return 'chop';
  }
}

module.exports = { OrchestratorAgent };
