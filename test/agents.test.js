const test = require('node:test');
const assert = require('node:assert/strict');

const { GoalAgent } = require('../src/agents/goalAgent');
const { PatternAgent } = require('../src/agents/patternAgent');
const { StrategyVariantAgent } = require('../src/agents/strategyVariantAgent');
const { OrchestratorAgent } = require('../src/agents/orchestratorAgent');
const { createOpportunityFeed } = require('../src/market/opportunityFeed');
const { RISK_CONFIG, STRATEGY_VARIANTS } = require('../src/config/risk');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// GoalAgent tests
// ─────────────────────────────────────────────

test('GoalAgent: reports not achieved when equity is below goal', () => {
  const agent = new GoalAgent({ goalSol: 2.0, durationMs: 86400000, startTime: Date.now() });
  const state = { bankrollSol: 0.1, openPositions: [] };
  const result = agent.checkGoal(state);
  assert.equal(result.achieved, false);
  assert.equal(result.expired, false);
  assert.equal(result.stop, false);
  assert.ok(result.progress < 1, 'progress should be < 1');
  assert.ok(result.timeRemainingMs > 0, 'time should still remain');
});

test('GoalAgent: reports achieved when equity meets goal', () => {
  const agent = new GoalAgent({ goalSol: 2.0, durationMs: 86400000, startTime: Date.now() });
  const state = { bankrollSol: 2.0, openPositions: [] };
  const result = agent.checkGoal(state);
  assert.equal(result.achieved, true);
  assert.equal(result.stop, true);
  assert.ok(result.progress >= 1.0);
});

test('GoalAgent: counts open position capital toward equity', () => {
  const agent = new GoalAgent({ goalSol: 2.0, durationMs: 86400000, startTime: Date.now() });
  // bankroll 1.5 + 0.6 in open position = 2.1 ≥ goal
  const state = {
    bankrollSol: 1.5,
    openPositions: [{ capitalSol: 0.6 }]
  };
  const result = agent.checkGoal(state);
  assert.equal(result.achieved, true);
  assert.ok(result.equity >= 2.0);
});

test('GoalAgent: reports expired when deadline has passed', () => {
  // startTime in the past — deadline already expired
  const agent = new GoalAgent({
    goalSol: 2.0,
    durationMs: 1000,
    startTime: Date.now() - 5000
  });
  const state = { bankrollSol: 0.1, openPositions: [] };
  const result = agent.checkGoal(state);
  assert.equal(result.achieved, false);
  assert.equal(result.expired, true);
  assert.equal(result.stop, true);
  assert.equal(result.timeRemainingMs, 0);
});

test('GoalAgent: summary returns hoursRemaining and pctToGoal', () => {
  const agent = new GoalAgent({ goalSol: 2.0, durationMs: 86400000, startTime: Date.now() });
  const state = { bankrollSol: 1.0, openPositions: [] };
  const s = agent.summary(state);
  assert.ok(typeof s.hoursRemaining === 'number');
  assert.ok(typeof s.pctToGoal === 'number');
  assert.ok(s.pctToGoal > 0 && s.pctToGoal < 100);
});

// ─────────────────────────────────────────────
// PatternAgent tests
// ─────────────────────────────────────────────

function makeExitRecord(venue, liquidityUsd, momentumScore, pnlPct) {
  return {
    type: 'execution',
    kind: 'exit',
    position: { venue, liquidityUsd, momentumScore },
    execution: { pnlPct }
  };
}

test('PatternAgent: returns zero stats for empty log', () => {
  const agent = new PatternAgent();
  const result = agent.analyze([]);
  assert.equal(result.totalExits, 0);
  assert.equal(result.overallWinRate, 0);
});

test('PatternAgent: correctly computes overall win rate', () => {
  const agent = new PatternAgent();
  const records = [
    makeExitRecord('solana/raydium', 60000, 0.8, 0.3),
    makeExitRecord('solana/raydium', 60000, 0.8, -0.05),
    makeExitRecord('solana/raydium', 60000, 0.8, 0.15)
  ];
  const result = agent.analyze(records);
  assert.equal(result.totalExits, 3);
  assert.ok(Math.abs(result.overallWinRate - 2 / 3) < 0.001);
});

test('PatternAgent: identifies best venue', () => {
  const agent = new PatternAgent();
  const records = [
    makeExitRecord('solana/raydium', 60000, 0.8, 0.3),
    makeExitRecord('solana/raydium', 60000, 0.8, 0.2),
    makeExitRecord('solana/raydium', 60000, 0.8, 0.1),
    makeExitRecord('bsc/pancakeswap', 80000, 0.7, -0.05),
    makeExitRecord('bsc/pancakeswap', 80000, 0.7, -0.04),
    makeExitRecord('bsc/pancakeswap', 80000, 0.7, 0.01)
  ];
  const result = agent.analyze(records);
  assert.equal(result.bestVenue, 'solana/raydium');
});

test('PatternAgent: ignores non-execution records', () => {
  const agent = new PatternAgent();
  const records = [
    { type: 'decision', pair: 'SOL/NEW1' },
    makeExitRecord('solana/raydium', 60000, 0.8, 0.3)
  ];
  const result = agent.analyze(records);
  assert.equal(result.totalExits, 1);
});

// ─────────────────────────────────────────────
// StrategyVariantAgent tests
// ─────────────────────────────────────────────

test('StrategyVariantAgent: creates one instance per variant', () => {
  const feed = createOpportunityFeed();
  const agent = new StrategyVariantAgent({ feed });
  assert.equal(agent.instances.length, STRATEGY_VARIANTS.length);
});

test('StrategyVariantAgent: runCycle returns summary with one entry per variant', () => {
  const feed = createOpportunityFeed();
  const agent = new StrategyVariantAgent({ feed });
  const summary = agent.runCycle({});
  assert.equal(summary.length, STRATEGY_VARIANTS.length);
  for (const entry of summary) {
    assert.ok(typeof entry.name === 'string');
    assert.ok(typeof entry.equity === 'number');
    assert.ok(entry.equity > 0);
  }
});

test('StrategyVariantAgent: getBestVariantConfig returns balanced config before any trades', () => {
  const feed = createOpportunityFeed();
  const agent = new StrategyVariantAgent({ feed });
  const best = agent.getBestVariantConfig();
  // No trades yet → should fall back to the balanced config
  assert.equal(best.name, 'balanced');
});

test('StrategyVariantAgent: summary sorted best risk-adjusted score first', () => {
  const feed = createOpportunityFeed();
  const agent = new StrategyVariantAgent({ feed });
  // Run enough cycles to generate differing equity
  for (let i = 0; i < 5; i++) {
    agent.runCycle({});
  }
  const summary = agent.getSummary();
  for (let i = 0; i < summary.length - 1; i++) {
    assert.ok(
      summary[i].riskAdjustedScore >= summary[i + 1].riskAdjustedScore,
      'summary should be sorted best first'
    );
  }
});

// ─────────────────────────────────────────────
// OrchestratorAgent tests
// ─────────────────────────────────────────────

test('OrchestratorAgent: runCycle returns a valid cycle report', () => {
  const feed = createOpportunityFeed();
  const orchestrator = new OrchestratorAgent({ feed });
  const result = orchestrator.runCycle();
  assert.equal(result.cycle, 1);
  assert.ok(typeof result.stop === 'boolean');
  assert.ok(result.goalStatus);
  assert.ok(result.mainState);
  assert.ok(typeof result.mainState.equity === 'number');
});

test('OrchestratorAgent: stops immediately when goal already met', () => {
  const feed = createOpportunityFeed();
  // Set goal very low so it's met immediately
  const goalAgent = new GoalAgent({
    goalSol: 0.001,
    durationMs: ONE_DAY_MS,
    startTime: Date.now()
  });
  const orchestrator = new OrchestratorAgent({ feed, goalAgent });
  const result = orchestrator.runCycle();
  assert.equal(result.stop, true);
  assert.equal(result.reason, 'goal-achieved');
});

test('OrchestratorAgent: stops when deadline is expired', () => {
  const feed = createOpportunityFeed();
  const goalAgent = new GoalAgent({
    goalSol: 2.0,
    durationMs: 1,
    startTime: Date.now() - 10000
  });
  const orchestrator = new OrchestratorAgent({ feed, goalAgent });
  const result = orchestrator.runCycle();
  assert.equal(result.stop, true);
  assert.equal(result.reason, 'time-expired');
});

test('OrchestratorAgent: continues when stopOnGoal is disabled', () => {
  const feed = createOpportunityFeed();
  const goalAgent = new GoalAgent({
    goalSol: 0.001,
    durationMs: ONE_DAY_MS,
    startTime: Date.now()
  });
  const orchestrator = new OrchestratorAgent({ feed, goalAgent, stopOnGoal: false });
  const result = orchestrator.runCycle();
  assert.equal(result.stop, false);
  assert.equal(result.reason, null);
  assert.equal(result.cycle, 1);
});

test('OrchestratorAgent: accumulates cycle count across multiple calls', () => {
  const feed = createOpportunityFeed();
  const orchestrator = new OrchestratorAgent({ feed });
  orchestrator.runCycle();
  orchestrator.runCycle();
  const result = orchestrator.runCycle();
  assert.equal(result.cycle, 3);
});

test('OrchestratorAgent: variantSummary contains all variants', () => {
  const feed = createOpportunityFeed();
  const orchestrator = new OrchestratorAgent({ feed });
  const result = orchestrator.runCycle();
  assert.ok(Array.isArray(result.variantSummary));
  assert.equal(result.variantSummary.length, STRATEGY_VARIANTS.length);
});

test('OrchestratorAgent: patterns object is returned each cycle', () => {
  const feed = createOpportunityFeed();
  const orchestrator = new OrchestratorAgent({ feed });
  const result = orchestrator.runCycle();
  assert.ok(result.patterns);
  assert.ok(typeof result.patterns.overallWinRate === 'number');
});

// ─────────────────────────────────────────────
// RISK_CONFIG goal fields
// ─────────────────────────────────────────────

test('RISK_CONFIG has goalSol = 2.0 and goalDurationMs = 24h', () => {
  assert.equal(RISK_CONFIG.goalSol, 2.0);
  assert.equal(RISK_CONFIG.goalDurationMs, 24 * 60 * 60 * 1000);
});

test('STRATEGY_VARIANTS contains conservative, balanced, and aggressive', () => {
  const names = STRATEGY_VARIANTS.map((v) => v.name);
  assert.ok(names.includes('conservative'));
  assert.ok(names.includes('balanced'));
  assert.ok(names.includes('aggressive'));
});
