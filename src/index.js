const { LearningEngine } = require('./learning/learningEngine');
const { TradeLogger } = require('./learning/tradeLogger');
const { StrategyEngine } = require('./strategy/strategyEngine');
const { PaperExecutor } = require('./execution/paperExecutor');
const { SolanaLiveExecutor } = require('./execution/solanaLiveExecutor');
const { createOpportunityFeed } = require('./market/opportunityFeed');
const { createLiveFeed, createComprehensiveWatchlist } = require('./market/liveFeed');
const { SolanaWatchlistFeed } = require('./market/solanaWatchlistFeed');
const { PoolDiscoveryFeed } = require('./market/poolDiscoveryFeed');
const { PaperTradingSimulator } = require('./simulator/paperTradingSimulator');
const { createDashboardServer } = require('./dashboard/server');
const { OrchestratorAgent } = require('./agents/orchestratorAgent');
const { GoalAgent } = require('./agents/goalAgent');
const { PatternAgent } = require('./agents/patternAgent');
const { StrategyVariantAgent } = require('./agents/strategyVariantAgent');
const { LiveTradingBot } = require('./live/liveTradingBot');
const { SolanaRpcClient } = require('./live/solanaRpcClient');
const { SolanaSafetyProvider } = require('./safety/onChainSafety');
const { TradeApprovalQueue } = require('./live/tradeApprovalQueue');
const { getTradingMode, parseLiveTradingConfig } = require('./live/config');
const { createSupabaseClient, ensureTables } = require('./lib/supabase');
const { loadState, saveState } = require('./learning/stateStore');

function buildApp(env = process.env) {
  const supabase = createSupabaseClient(env);
  const learning = new LearningEngine();
  const logger = new TradeLogger({ supabase });
  const strategy = new StrategyEngine({ learningEngine: learning });
  const executor = new PaperExecutor();
  const feed = createOpportunityFeed();
  const simulator = new PaperTradingSimulator({ strategy, executor, logger, learning, feed });

  return { simulator, logger, learning, supabase };
}

function buildOrchestrator({ stopOnGoal = true, persistedState = null, supabase = null } = {}) {
  // Use live feed when USE_LIVE_FEED=true, otherwise synthetic feed
  const useLiveFeed = parseBoolean(process.env.USE_LIVE_FEED);
  const feed = useLiveFeed
    ? createLiveFeed(createComprehensiveWatchlist())
    : createOpportunityFeed();
  const goalAgent = new GoalAgent();
  const patternAgent = new PatternAgent();
  const variantAgent = new StrategyVariantAgent({ feed });

  // Build the Agent Council with MemoryStore — persistent memory for
  // trade recall, pattern mining, and strategic meetings.
  const orchestrator = new OrchestratorAgent({
    feed,
    goalAgent,
    patternAgent,
    variantAgent,
    stopOnGoal
  });

  if (persistedState?.orchestrator) {
    orchestrator.restore(persistedState.orchestrator);
  }

  return {
    orchestrator,
    goalAgent,
    variantAgent,
    patternAgent,
    councilAgent: orchestrator.councilAgent,
    memoryStore: orchestrator.memoryStore
  };
}

async function buildLiveApp(env = process.env, persistedState = null) {
  const liveConfig = parseLiveTradingConfig(env);
  if (liveConfig.mode !== 'live') {
    throw new Error('buildLiveApp requires TRADING_MODE=live');
  }

  const supabase = createSupabaseClient(env);
  const learning = new LearningEngine();
  const logger = new TradeLogger({ supabase });
  const strategy = new StrategyEngine({ learningEngine: learning });
  const goalAgent = new GoalAgent();
  const client = await new SolanaRpcClient({
    rpcUrl: liveConfig.rpcUrl,
    walletSecret: liveConfig.walletSecret
  }).init();
  const executor = new SolanaLiveExecutor({
    client,
    quoteApiBase: liveConfig.quoteApiBase,
    swapApiBase: liveConfig.swapApiBase,
    slippageBps: liveConfig.slippageBps,
    minSolReserve: liveConfig.minSolReserve,
    maxBankrollSol: liveConfig.maxBankrollSol,
    jupiterApiKey: env.JUPITER_API_KEY
  });
  const feed = new SolanaWatchlistFeed({
    watchlist: liveConfig.watchlist,
    watchlistCandidates: liveConfig.watchlistCandidates,
    autoWatchlistSize: liveConfig.autoWatchlistSize,
    quoteApiBase: liveConfig.quoteApiBase,
    slippageBps: liveConfig.slippageBps
  });

  let poolDiscoveryFeed = null;
  if (liveConfig.poolDiscoveryEnabled) {
    poolDiscoveryFeed = new PoolDiscoveryFeed({
      wsUrl: liveConfig.wsUrl,
      rpcUrl: liveConfig.rpcUrl,
      programIds: liveConfig.poolDiscoveryProgramIds,
      maxCandidates: liveConfig.poolDiscoveryMaxCandidates,
      onError: (error) => logEvent('error', 'pool-discovery-error', { error: error.message }),
      onStatus: (status) => logEvent('info', 'pool-discovery-status', status)
    }).start();
    feed.dynamicCandidateSource = poolDiscoveryFeed;
  }

  const safetyProvider = liveConfig.requireOnChainSafety
    ? new SolanaSafetyProvider({
      rpcUrl: liveConfig.rpcUrl,
      quoteApiBase: liveConfig.quoteApiBase,
      cacheTtlMs: liveConfig.safetyCacheTtlMs,
      jupiterApiKey: env.JUPITER_API_KEY
    })
    : null;

  const approvalQueue = new TradeApprovalQueue();
  const bot = new LiveTradingBot({
    strategy,
    executor,
    logger,
    learning,
    feed,
    goalAgent,
    supervisionMode: liveConfig.supervisionMode,
    approvalQueue,
    safetyProvider
  });
  await bot.initialize();
  if (persistedState?.live) {
    bot.restore(persistedState.live);
  }

  return { bot, logger, learning, goalAgent, liveConfig, client, poolDiscoveryFeed };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parseNonNegativeNumber(value, defaultValue, fieldName = 'Parameter') {
  if (value == null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
  return parsed;
}

function logEvent(level, message, context = {}) {
  const logger = level === 'error' ? console.error : console.log;
  logger(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...context
  }));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

const MAX_LIVE_BACKOFF_MS = 60 * 1000;
const MAX_PAPER_BACKOFF_MS = 5 * 1000;
const DEFAULT_PAPER_BASE_DELAY_MS = 50;
const PAPER_PROGRESS_LOG_INTERVAL = 50;
const DEFAULT_STATE_PERSIST_EVERY = 10;

async function runMain(env = process.env, runtime = process) {
  const mode = getTradingMode(env);
  const port = Number(env.PORT || 3000);
  const statePersistEvery = Math.max(1, Number(env.BOT_STATE_PERSIST_EVERY_CYCLES || DEFAULT_STATE_PERSIST_EVERY));
  const shutdown = {
    requested: false,
    reason: null
  };
  let server = null;
  let shuttingDown = false;
  let persistedState = null;
  let persistDebounceCounter = 0;
  let activeOrchestrator = null;
  let activeLiveBot = null;

  // Try to auto-create Supabase tables on boot (best-effort)
  const bootSupabase = createSupabaseClient(env);
  if (bootSupabase) {
    ensureTables(bootSupabase).catch(() => {});
  }

  persistedState = await loadState(env.BOT_STATE_FILE, env);

  const requestShutdown = (reason) => {
    if (shutdown.requested) return;
    shutdown.requested = true;
    shutdown.reason = reason;
    logEvent('warn', 'shutdown-requested', { reason });
  };

  const signalHandler = (signal) => requestShutdown(`signal:${signal}`);
  const unhandledRejectionHandler = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logEvent('error', 'unhandled-rejection', { error: error.message });
    runtime.exitCode = 1;
    requestShutdown('unhandled-rejection');
  };
  const uncaughtExceptionHandler = (error) => {
    logEvent('error', 'uncaught-exception', { error: error.message });
    runtime.exitCode = 1;
    requestShutdown('uncaught-exception');
  };

  runtime.on('SIGINT', signalHandler);
  runtime.on('SIGTERM', signalHandler);
  runtime.on('unhandledRejection', unhandledRejectionHandler);
  runtime.on('uncaughtException', uncaughtExceptionHandler);

  try {
    if (mode === 'live') {
      const { bot, logger, goalAgent, liveConfig, client, poolDiscoveryFeed } = await buildLiveApp(env, persistedState);
      activeLiveBot = bot;
      server = createDashboardServer({
        simulator: bot,
        logger,
        goalAgent,
        variantAgent: null
      });
      server.listen(port, () => {
        logEvent('info', 'dashboard-started', { port, mode: 'live' });
        logEvent('info', 'live-trading-enabled', { walletAddress: client.walletAddress });
      });

      logEvent('info', 'live-loop-started', { pollIntervalMs: liveConfig.pollIntervalMs });
      let consecutiveCycleFailures = 0;
      while (!shutdown.requested) {
        try {
          const result = await bot.runCycle();
          consecutiveCycleFailures = 0;
          persistDebounceCounter += 1;
          if (persistDebounceCounter % statePersistEvery === 0) {
            await saveState(env.BOT_STATE_FILE, { live: bot.snapshot() }, env);
          }
          logEvent('info', 'live-cycle-complete', {
            bankrollSol: Number(result.bankrollSol.toFixed(6)),
            realizedPnlSol: Number(result.realizedPnlSol.toFixed(6)),
            openPositions: result.openPositions
          });
        } catch (error) {
          consecutiveCycleFailures += 1;
          const backoffMs = Math.min(
            liveConfig.pollIntervalMs * 2 ** (consecutiveCycleFailures - 1),
            MAX_LIVE_BACKOFF_MS
          );
          logEvent('error', 'live-cycle-failed', {
            error: error.message,
            consecutiveFailures: consecutiveCycleFailures,
            backoffMs
          });
          await sleep(backoffMs);
          continue;
        }
        await sleep(liveConfig.pollIntervalMs);
      }
      if (poolDiscoveryFeed) {
        poolDiscoveryFeed.stop();
      }
      return;
    }

    const paperAutoStopOnGoal = parseBoolean(env.PAPER_AUTO_STOP_ON_GOAL);
    const paperCycleDelayMs = parseNonNegativeNumber(env.PAPER_CYCLE_DELAY_MS, 0, 'PAPER_CYCLE_DELAY_MS');
    const paperBackoffBaseDelayMs = paperCycleDelayMs > 0 ? paperCycleDelayMs : DEFAULT_PAPER_BASE_DELAY_MS;
    const { orchestrator, goalAgent, variantAgent } = buildOrchestrator({
      stopOnGoal: paperAutoStopOnGoal,
      persistedState
    });
    activeOrchestrator = orchestrator;
    server = createDashboardServer({
      simulator: orchestrator.mainSimulator,
      logger: orchestrator.logger,
      goalAgent,
      variantAgent
    });
    server.listen(port, () => {
      logEvent('info', 'dashboard-started', { port, mode: 'paper' });
      logEvent('info', 'goal-tracking-configured', {
        goalSol: orchestrator.config.goalSol,
        autoStopOnGoal: paperAutoStopOnGoal
      });
    });

    logEvent('info', 'paper-loop-started', { cycleDelayMs: paperCycleDelayMs });
    let cycleCounter = 0;
    let consecutiveCycleFailures = 0;
    while (!shutdown.requested) {
      try {
        const result = orchestrator.runCycle();
        cycleCounter += 1;
        consecutiveCycleFailures = 0;
        if (cycleCounter % statePersistEvery === 0) {
          await saveState(env.BOT_STATE_FILE, { orchestrator: orchestrator.snapshot() }, env);
        }

        if (result.stop) {
          logEvent('warn', 'paper-goal-stop-triggered', {
            cycle: result.cycle,
            reason: result.reason,
            equity: Number(result.goalStatus.equity.toFixed(6))
          });
          requestShutdown('paper-goal-stop');
          break;
        }

        if (cycleCounter % PAPER_PROGRESS_LOG_INTERVAL === 0) {
          logEvent('info', 'paper-cycle-progress', {
            cycle: result.cycle,
            equity: Number(result.goalStatus.equity.toFixed(6)),
            progressPct: Number((result.goalStatus.progress * 100).toFixed(1)),
            activeVariant: result.activeVariant
          });
        }
      } catch (error) {
        consecutiveCycleFailures += 1;
        const backoffMs = Math.min(
          paperBackoffBaseDelayMs * 2 ** (consecutiveCycleFailures - 1),
          MAX_PAPER_BACKOFF_MS
        );
        logEvent('error', 'paper-cycle-failed', {
          error: error.message,
          consecutiveFailures: consecutiveCycleFailures,
          backoffMs
        });
        await sleep(backoffMs);
        continue;
      }

      if (paperCycleDelayMs > 0) {
        await sleep(paperCycleDelayMs);
      } else if (cycleCounter % PAPER_PROGRESS_LOG_INTERVAL === 0) {
        await sleep(0);
      }
    }
  } finally {
    if (!shuttingDown) {
      shuttingDown = true;
      if (mode === 'paper' && activeOrchestrator) {
        try {
          await saveState(env.BOT_STATE_FILE, { orchestrator: activeOrchestrator.snapshot() }, env);
        } catch (error) {
          logEvent('error', 'state-save-failed', { error: error.message });
        }
      }
      if (mode === 'live' && activeLiveBot) {
        try {
          await saveState(env.BOT_STATE_FILE, { live: activeLiveBot.snapshot() }, env);
        } catch (error) {
          logEvent('error', 'state-save-failed', { error: error.message });
        }
      }
      await closeServer(server);
      runtime.off('SIGINT', signalHandler);
      runtime.off('SIGTERM', signalHandler);
      runtime.off('unhandledRejection', unhandledRejectionHandler);
      runtime.off('uncaughtException', uncaughtExceptionHandler);
      logEvent('info', 'shutdown-complete', { reason: shutdown.reason || 'unknown' });
    }
  }
}

if (require.main === module) {
  runMain(process.env).catch((error) => {
    logEvent('error', 'fatal-startup-error', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = { buildApp, buildOrchestrator, buildLiveApp, runMain, logEvent };
