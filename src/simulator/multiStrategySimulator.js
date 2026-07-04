const { LearningEngine } = require('../learning/learningEngine');
const { TradeLogger } = require('../learning/tradeLogger');
const { StrategyEngine } = require('../strategy/strategyEngine');
const { PaperExecutor } = require('../execution/paperExecutor');
const { PaperTradingSimulator } = require('./paperTradingSimulator');

/**
 * Creates a fully isolated simulator instance for a given strategy config.
 * Each instance has its own learning engine, logger, executor, and state,
 * so variants do not influence each other.
 */
function createIsolatedSimulator(feed, variantConfig) {
  const learning = new LearningEngine(variantConfig);
  const logger = new TradeLogger();
  const strategy = new StrategyEngine({ learningEngine: learning, config: variantConfig });
  const executor = new PaperExecutor();
  const simulator = new PaperTradingSimulator({
    strategy,
    executor,
    logger,
    learning,
    feed,
    config: variantConfig
  });
  return { simulator, learning, logger, config: variantConfig };
}

/**
 * Returns equity (bankroll + open position capital) for a given simulator state.
 */
function equityOf(state) {
  return state.bankrollSol + state.openPositions.reduce((s, p) => s + p.capitalSol, 0);
}

module.exports = { createIsolatedSimulator, equityOf };
