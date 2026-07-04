const { LearningEngine } = require('./learning/learningEngine');
const { TradeLogger } = require('./learning/tradeLogger');
const { StrategyEngine } = require('./strategy/strategyEngine');
const { PaperExecutor } = require('./execution/paperExecutor');
const { createOpportunityFeed } = require('./market/opportunityFeed');
const { PaperTradingSimulator } = require('./simulator/paperTradingSimulator');
const { createDashboardServer } = require('./dashboard/server');
const { OrchestratorAgent } = require('./agents/orchestratorAgent');
const { GoalAgent } = require('./agents/goalAgent');
const { PatternAgent } = require('./agents/patternAgent');
const { StrategyVariantAgent } = require('./agents/strategyVariantAgent');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const { orchestrator, goalAgent, variantAgent } = buildOrchestrator();

  const server = createDashboardServer({
    simulator: orchestrator.mainSimulator,
    logger: orchestrator.logger,
    goalAgent,
    variantAgent
  });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard running on :${port}`);
    console.log(`Goal: ${orchestrator.config.goalSol} SOL in 24 hours (auto-stop enabled)`);
  });

  // Simulation loop — cycles as fast as possible in paper-trading mode.
  // In a live integration, replace the inner body with real price feed data
  // and add an appropriate await sleep(ms) between cycles.
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
      // Yield to event loop periodically so the dashboard remains responsive
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
}

module.exports = { buildApp, buildOrchestrator };
