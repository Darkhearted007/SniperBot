const { RISK_CONFIG } = require('../config/risk');

/**
 * GoalAgent monitors the hardcoded target of raising 0.1 SOL → 2 SOL within 24 hours.
 * Call `checkGoal(state)` after every simulation cycle.
 * Returns `{ achieved, expired, stop }` — when stop is true the bot must halt.
 */
class GoalAgent {
  constructor({
    goalSol = RISK_CONFIG.goalSol,
    durationMs = RISK_CONFIG.goalDurationMs,
    startTime = Date.now()
  } = {}) {
    this.goalSol = goalSol;
    this.durationMs = durationMs;
    this.startTime = startTime;
  }

  /**
   * @param {object} state - simulator state (bankrollSol, openPositions)
   * @returns {{ achieved, expired, stop, equity, progress, timeRemainingMs, elapsed }}
   */
  checkGoal(state) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const timeRemainingMs = Math.max(0, this.durationMs - elapsed);

    // Total equity = available bankroll + capital locked in open positions
    const equity = state.bankrollSol +
      (state.openPositions || []).reduce((sum, p) => sum + p.capitalSol, 0);

    const achieved = equity >= this.goalSol;
    const expired = !achieved && elapsed >= this.durationMs;
    const progress = equity / this.goalSol;

    return {
      achieved,
      expired,
      stop: achieved || expired,
      equity,
      progress,
      timeRemainingMs,
      elapsed,
      goalSol: this.goalSol
    };
  }

  summary(state) {
    const status = this.checkGoal(state);
    const hoursRemaining = (status.timeRemainingMs / 3_600_000).toFixed(2);
    const pctToGoal = (status.progress * 100).toFixed(1);
    return {
      ...status,
      hoursRemaining: Number(hoursRemaining),
      pctToGoal: Number(pctToGoal)
    };
  }
}

module.exports = { GoalAgent };
