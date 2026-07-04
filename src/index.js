const { LearningEngine } = require('./learning/learningEngine');
const { TradeLogger } = require('./learning/tradeLogger');
const { StrategyEngine } = require('./strategy/strategyEngine');
const { PaperExecutor } = require('./execution/paperExecutor');
const { SolanaLiveExecutor } = require('./execution/solanaLiveExecutor');
const { createOpportunityFeed } = require('./market/opportunityFeed');
const { SolanaWatchlistFeed } = require('./market/solanaWatchlistFeed');
const { PaperTradingSimulator } = require('./simulator/paperTradingSimulator');
const { createDashboardServer } = require('./dashboard/server');
const { OrchestratorAgent } = require('./agents/orchestratorAgent');
const { GoalAgent } = require('./agents/goalAgent');
const { PatternAgent } = require('./agents/patternAgent');
const { StrategyVariantAgent } = require('./agents/strategyVariantAgent');
const { LiveTradingBot } = require('./live/liveTradingBot');
const { SolanaRpcClient } = require('./live/solanaRpcClient');
const { getTradingMode, parseLiveTradingConfig } = require('./live/config');

function buildApp() {
  const learning = new LearningEngine();
  const logger = new TradeLogger();
  const strategy = new StrategyEngine({ learningEngine: learning });
  const executor = new PaperExecutor();
  const feed = createOpportunityFeed();
  const simulator = new PaperTradingSimulator({ strategy, executor, logger, learning, feed });

  return { simulator, logger, learning };
}

function buildOrchestrator() {
  const feed = createOpportunityFeed();
  const goalAgent = new GoalAgent();
  const patternAgent = new PatternAgent();
  const variantAgent = new StrategyVariantAgent({ feed });
  const orchestrator = new OrchestratorAgent({ feed, goalAgent, patternAgent, variantAgent });
  return { orchestrator, goalAgent, variantAgent, patternAgent };
}

async function buildLiveApp(env = process.env) {
  const liveConfig = parseLiveTradingConfig(env);
  if (liveConfig.mode !== 'live') {
    throw new Error('buildLiveApp requires TRADING_MODE=live');
  }

  const learning = new LearningEngine();
  const logger = new TradeLogger();
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
    maxBankrollSol: liveConfig.maxBankrollSol
  });
  const feed = new SolanaWatchlistFeed({
    watchlist: liveConfig.watchlist,
    quoteApiBase: liveConfig.quoteApiBase,
    slippageBps: liveConfig.slippageBps
  });
  const bot = new LiveTradingBot({
    strategy,
    executor,
    logger,
    learning,
    feed,
    goalAgent
  });
  await bot.initialize();

  return { bot, logger, learning, goalAgent, liveConfig, client };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  (async () => {
    const mode = getTradingMode(process.env);
    const port = Number(process.env.PORT || 3000);

    if (mode === 'live') {
      const { bot, logger, goalAgent, liveConfig, client } = await buildLiveApp(process.env);
      const server = createDashboardServer({
        simulator: bot,
        logger,
        goalAgent,
        variantAgent: null
      });
      server.listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`Dashboard running on :${port}`);
        console.log(`Live trading enabled for wallet ${client.walletAddress}`);
      });

      // eslint-disable-next-line no-console
      console.log('Live bot started — polling configured Solana watchlist…');
      while (true) {
        try {
          const result = await bot.runCycle();
          // eslint-disable-next-line no-console
          console.log(
            `Live cycle | bankroll: ${result.bankrollSol.toFixed(6)} SOL` +
            ` | realized pnl: ${result.realizedPnlSol.toFixed(6)} SOL` +
            ` | open positions: ${result.openPositions}`
          );
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`Live cycle failed: ${error.message}`);
        }
        await sleep(liveConfig.pollIntervalMs);
      }
    }

    const { orchestrator, goalAgent, variantAgent } = buildOrchestrator();
    const server = createDashboardServer({
      simulator: orchestrator.mainSimulator,
      logger: orchestrator.logger,
      goalAgent,
      variantAgent
    });
    server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Dashboard running on :${port}`);
      console.log(`Goal: ${orchestrator.config.goalSol} SOL in 24 hours (auto-stop enabled)`);
    });

    // Simulation loop — cycles as fast as possible in paper-trading mode.
    (async () => {
      // eslint-disable-next-line no-console
      console.log('Orchestrator started — running strategy discovery cycles…');
      for (let i = 0; i < 10000; i++) {
        const result = orchestrator.runCycle();
        if (result.stop) {
          // eslint-disable-next-line no-console
          console.log(`\n🏁 Bot stopped after ${result.cycle} cycles: ${result.reason}`);
          // eslint-disable-next-line no-console
          console.log(`   Final equity: ${result.goalStatus.equity.toFixed(6)} SOL`);
          // eslint-disable-next-line no-console
          console.log(`   Progress to goal: ${(result.goalStatus.progress * 100).toFixed(1)}%`);
          break;
        }
        if (i % 50 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `Cycle ${result.cycle} | equity: ${result.goalStatus.equity.toFixed(6)} SOL` +
            ` (${(result.goalStatus.progress * 100).toFixed(1)}%) | variant: ${result.activeVariant}`
          );
          await sleep(0);
        }
      }
    })();
  })().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildApp, buildOrchestrator, buildLiveApp };
