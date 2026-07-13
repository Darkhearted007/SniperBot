const { GoalAgent } = require('./goalAgent');
const { PatternAgent } = require('./patternAgent');
const { StrategyVariantAgent } = require('./strategyVariantAgent');
const { CouncilAgent } = require('./councilAgent');
const { MemoryStore } = require('../learning/memoryStore');
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
    councilAgent,
    memoryStore,
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

    // MemoryStore — long-term trade memory for pattern mining and lesson extraction
    this.memoryStore = memoryStore || new MemoryStore();

    // CouncilAgent — convenes agent meetings, collects reports, produces directives
    this.councilAgent = councilAgent || new CouncilAgent({
      memoryStore: this.memoryStore,
      goalAgent: this.goalAgent,
      patternAgent: this.patternAgent,
      variantAgent: this.variantAgent,
      config
    });

    this.stopOnGoal = stopOnGoal;
    this.currentRegime = 'chop';

    // Track the last council meeting output for dashboard display
    this.lastCouncilReport = null;

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

    // Opportunites are fetched from the feed once per cycle in runCycle(),
    // ensuring a single source of truth for prices across entry and exit.
    this._latestOpportunities = feed.list();
  }

  /**
   * Build a price map from the latest feed opportunities.
   * This is the single source of truth for prices — entry and exit checks
   * both use the feed's deterministic price trajectory, eliminating the
   * previous desync between the orchestrator's independent this._prices
   * and the feed's internal price state.
   */
  _buildPriceMap(opportunities) {
    return Object.fromEntries(opportunities.map((o) => [o.pair, o.price]));
  }

  /**
   * Run one full orchestration cycle.
   * @param {object|null} externalPriceMap  - If provided, used instead of synthetic prices.
   * @returns {object} cycle report
   */
  runCycle(externalPriceMap = null) {
    this.cycleCount += 1;

    // Fetch opportunities ONCE per cycle — the feed is the single source of truth.
    // Previously, feed.list() was called multiple times per cycle (in tickPrices,
    // runCycle, variant agents), advancing prices inconsistently and causing the
    // orchestrator's this._prices to diverge from the feed's internal prices.
    const opportunities = this.feed.list();
    this._latestOpportunities = opportunities;

    // Build the price map from the feed's actual prices.
    // This eliminates the old dual-price-system bug where entry used the feed's
    // deterministic sin/cos prices while exit used the orchestrator's random walk.
    const priceMap = externalPriceMap
      ? { ...externalPriceMap, ...this._buildPriceMap(opportunities) }
      : this._buildPriceMap(opportunities);

    this.currentRegime = this._detectRegime(opportunities);

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

    // 2. Advance all variant simulators for pattern discovery.
    //    Pass the same opportunities so variant simulators don't call feed.list() again.
    const variantSummary = this.variantAgent.runCycle(priceMap, opportunities);

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
    // Also reset daily loss tracking so the bot isn't permanently blocked
    // by previous-session losses (daily cap only resets at day boundaries).
    this.mainSimulator.state.circuitBreaker = false;
    this.mainSimulator.state.drawdownPct = 0;
    this.mainSimulator.state.dailyLossPct = 0;
    this.mainSimulator.state.realizedPnlTodaySol = 0;

    // 5. Advance main simulator — pass the same opportunities so it doesn't
    //    call feed.list() again and desync prices.
    this.mainSimulator.runCycle(opportunities);
    this.mainSimulator.processMarketTick(priceMap);

    // 5b. Record completed trades in MemoryStore for council learning.
    //     Scan the logger for any EXIT executions that happened this cycle.
    this._recordCycleExits();

    // 5c. Agent Council meeting — convene every N cycles or on intervention.
    //     Each meeting collects reports from all agents, finds consensus,
    //     and produces directives for the orchestrator to implement.
    const memStats = this.memoryStore.getStats();
    if (this.councilAgent.shouldConvene(this.cycleCount, memStats.consecutiveLosses)) {
      const councilResult = this.councilAgent.convene(
        this.mainSimulator.state,
        this.cycleCount,
        this._mainLogger.all()
      );
      this.lastCouncilReport = councilResult;

      // Apply council directives to the adaptive config
      this._applyCouncilDirectives(councilResult.directives);
    }

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
      council: this.lastCouncilReport,
      councilDirectives: this.councilAgent.getActiveDirectives(),
      memoryStats: {
        totalTrades: memStats.totalTrades,
        winRate: memStats.totalTrades > 0 ? Number((memStats.winRate * 100).toFixed(1)) : 0,
        consecutiveLosses: memStats.consecutiveLosses
      },
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
      variants: typeof this.variantAgent.snapshot === 'function' ? this.variantAgent.snapshot() : null,
      memoryStore: typeof this.memoryStore.snapshot === 'function' ? this.memoryStore.snapshot() : null,
      councilAgent: typeof this.councilAgent.snapshot === 'function' ? this.councilAgent.snapshot() : null
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
    // Restore council and memory (non-critical — bot can operate without them)
    if (snapshot.memoryStore && typeof this.memoryStore.restore === 'function') {
      this.memoryStore.restore(snapshot.memoryStore);
    }
    if (snapshot.councilAgent && typeof this.councilAgent.restore === 'function') {
      this.councilAgent.restore(snapshot.councilAgent);
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

  /**
   * Scan the main logger for exit executions that happened this cycle and
   * record them in the MemoryStore with full trade context for council learning.
   */
  _recordCycleExits() {
    const logs = this._mainLogger.all();
    // Get only the most recent exit executions (performed this cycle)
    const recentExits = logs.filter(
      (r) => r.type === 'execution' && r.kind === 'exit'
    ).slice(-10); // Max 10 per cycle to prevent stale recordings

    for (const exitLog of recentExits) {
      const pos = exitLog.position || {};
      const exec = exitLog.execution || {};
      const exitDec = exitLog.exitDecision || {};

      this.memoryStore.recordTrade({
        positionId: pos.id,
        symbol: (pos.pair || 'unknown').split('/')[1] || pos.pair || 'unknown',
        venue: pos.venue || 'unknown',
        entryPrice: pos.entryPrice,
        exitPrice: exec.priceNow,
        pnlSol: exec.pnlSol || 0,
        pnlPct: exec.pnlPct || 0,
        exitReason: exitDec.reason || 'unknown',
        confidence: pos.confidence,
        expectedEdge: pos.expectedEdge,
        riskAdjustedScore: pos.riskAdjustedScore,
        momentumScore: pos.momentumScore,
        volatilityRisk: pos.volatilityRisk,
        liquidityUsd: pos.liquidityUsd,
        trendState: pos.trendState || null,
        volatilityRegime: pos.volatilityRegime || null,
        tokenCategory: pos.tokenCategory,
        sizeSol: pos.capitalSol,
        openedAt: pos.openedAt,
        closedAt: exitLog.ts || new Date().toISOString(),
        durationMs: pos.openedAt
          ? Date.now() - new Date(pos.openedAt).getTime()
          : 0
      });
    }
  }

  /**
   * Apply council directives to the adaptive config.
   * The council meets every N cycles and produces directives based on
   * accumulated memory and agent reports. This method implements those directives.
   */
  _applyCouncilDirectives(directives) {
    if (!Array.isArray(directives) || directives.length === 0) return;

    for (const dir of directives) {
      switch (dir.type) {
        case 'raise-min-momentum':
          if (typeof dir.value === 'number') {
            this.adaptiveConfig.minMomentumScore = Math.max(
              this.adaptiveConfig.minMomentumScore || 0,
              dir.value
            );
          }
          break;

        case 'increase-position-size':
          if (typeof dir.value === 'number') {
            this.adaptiveConfig.maxPositionPct = Math.min(dir.value, 0.35);
          }
          break;

        case 'tighten-risk':
          if (typeof dir.value === 'number') {
            this.adaptiveConfig.maxPositionPct = Math.max(dir.value, 0.03);
          }
          break;

        case 'widen-stop-loss':
          if (typeof dir.value === 'number') {
            this.adaptiveConfig.stopLossBasePct = Math.min(dir.value, 0.15);
          }
          break;

        case 'intervention-mode':
          if (dir.value === true) {
            this.adaptiveConfig.maxPositionPct = Math.min(
              this.adaptiveConfig.maxPositionPct || 0.15,
              0.08
            );
            this.adaptiveConfig.minExpectedEdge = Math.max(
              this.adaptiveConfig.minExpectedEdge || 0.20,
              0.35
            );
          }
          break;

        case 'avoid-venue':
          // Venue avoidance is handled by the strategy engine through
          // token safety checks — we log it for now.
          break;

        case 'prioritize-venue':
          // Venue prioritization happens through the learning engine's
          // venue bias — the pattern agent already handles this.
          break;

        default:
          // Unknown directive type — ignore
          break;
      }
    }

    // Sync the updated config to the simulator and strategy
    this._syncAdaptiveConfig();
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
