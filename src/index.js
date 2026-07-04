const { LearningEngine } = require('./learning/learningEngine');
const { TradeLogger } = require('./learning/tradeLogger');
const { StrategyEngine } = require('./strategy/strategyEngine');
const { PaperExecutor } = require('./execution/paperExecutor');
const { createOpportunityFeed } = require('./market/opportunityFeed');
const { PaperTradingSimulator } = require('./simulator/paperTradingSimulator');
const { createDashboardServer } = require('./dashboard/server');

function buildApp() {
  const learning = new LearningEngine();
  const logger = new TradeLogger();
  const strategy = new StrategyEngine({ learningEngine: learning });
  const executor = new PaperExecutor();
  const feed = createOpportunityFeed();
  const simulator = new PaperTradingSimulator({ strategy, executor, logger, learning, feed });

  return { simulator, logger, learning };
}

if (require.main === module) {
  const { simulator, logger } = buildApp();
  simulator.runCycle();
  simulator.processMarketTick({
    'SOL/NEW1': 0.020,
    'BNB/NEW3': 0.026
  });

  const server = createDashboardServer({ simulator, logger });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard running on :${port}`);
  });
}

module.exports = { buildApp };
