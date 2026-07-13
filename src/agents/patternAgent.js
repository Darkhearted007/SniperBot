/**
 * PatternAgent analyses accumulated trade logs to detect which venues, liquidity ranges,
 * and momentum thresholds produce the highest win rates.
 * It feeds those insights back to the OrchestratorAgent so the active strategy can adapt.
 *
 * Enhanced with deep pattern extraction: generates specific observations (win/loss
 * correlations) that the CouncilAgent uses during meetings to form strategic directives.
 */

const MIN_OBSERVATIONS_FOR_DEEP_PATTERN = 3;
const WIN_RATE_THRESHOLD_HIGH = 0.70;
const WIN_RATE_THRESHOLD_LOW = 0.35;

class PatternAgent {
  /**
   * Analyse all execution records from a TradeLogger and return detected patterns.
   * @param {Array} records  - TradeLogger.all() output
   * @returns {object}        - Pattern summary
   */
  analyze(records) {
    const exits = records.filter((r) => r.type === 'execution' && r.kind === 'exit');

    const venueMap = {};
    const liqBuckets = { low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 } };
    const momentumBuckets = { low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 } };
    const regimeBuckets = { bull: { wins: 0, total: 0 }, chop: { wins: 0, total: 0 }, bear: { wins: 0, total: 0 } };
    const exitReasonBuckets = { 'take-profit': { wins: 0, total: 0 }, 'stop-loss': { wins: 0, total: 0 }, 'trailing-stop': { wins: 0, total: 0 }, other: { wins: 0, total: 0 } };

    for (const r of exits) {
      const venue = r.position?.venue || 'unknown';
      const liq = r.position?.liquidityUsd || 0;
      const momentum = r.position?.momentumScore || 0;
      const isWin = r.execution?.pnlPct > 0;
      const trendState = r.position?.marketContext?.trendState || r.position?.trendState || null;

      // venue stats
      if (!venueMap[venue]) venueMap[venue] = { wins: 0, total: 0, avgPnlPct: 0 };
      venueMap[venue].total += 1;
      if (isWin) venueMap[venue].wins += 1;
      venueMap[venue].avgPnlPct =
        ((venueMap[venue].avgPnlPct * (venueMap[venue].total - 1)) + (r.execution?.pnlPct || 0)) /
        venueMap[venue].total;

      // liquidity bucket: low < 30k, mid 30k–100k, high > 100k
      const liqKey = liq < 30000 ? 'low' : liq < 100000 ? 'mid' : 'high';
      liqBuckets[liqKey].total += 1;
      if (isWin) liqBuckets[liqKey].wins += 1;

      // momentum bucket: low < 0.5, mid 0.5–0.75, high > 0.75
      const momKey = momentum < 0.5 ? 'low' : momentum < 0.75 ? 'mid' : 'high';
      momentumBuckets[momKey].total += 1;
      if (isWin) momentumBuckets[momKey].wins += 1;

      if (trendState && regimeBuckets[trendState]) {
        regimeBuckets[trendState].total += 1;
        if (isWin) regimeBuckets[trendState].wins += 1;
      }

      // exit reason
      const reason = r.exitDecision?.reason || 'other';
      const reasonKey = exitReasonBuckets[reason] ? reason : 'other';
      exitReasonBuckets[reasonKey].total += 1;
      if (isWin) exitReasonBuckets[reasonKey].wins += 1;
    }

    const winRate = (bucket) =>
      bucket.total === 0 ? 0 : bucket.wins / bucket.total;

    const bestVenue = this._bestKey(venueMap, (v) => (v.total >= 3 ? winRate(v) : -1));
    const bestLiqBucket = this._bestKey(liqBuckets, winRate);
    const bestMomBucket = this._bestKey(momentumBuckets, winRate);
    const bestTrendRegime = this._bestKey(regimeBuckets, (bucket) => (bucket.total > 0 ? winRate(bucket) : -1));

    const recommendedMinMomentum =
      bestMomBucket === 'high' ? 0.75 : bestMomBucket === 'mid' ? 0.50 : 0.30;
    const recommendedMinLiquidity =
      bestLiqBucket === 'high' ? 100000 : bestLiqBucket === 'mid' ? 30000 : 10000;
    const recommendedRiskMode = bestTrendRegime === 'bull'
      ? 'growth'
      : bestTrendRegime === 'chop'
        ? 'balanced'
        : bestTrendRegime === 'bear'
          ? 'defensive'
          : 'balanced';

    // Deep observations — generated from the raw data
    const deepObservations = this._generateDeepObservations(
      venueMap, liqBuckets, momentumBuckets, regimeBuckets, exitReasonBuckets, exits
    );

    return {
      totalExits: exits.length,
      overallWinRate: exits.length === 0 ? 0 : exits.filter((r) => r.execution?.pnlPct > 0).length / exits.length,
      venueStats: venueMap,
      liqBucketStats: liqBuckets,
      momentumBucketStats: momentumBuckets,
      regimeStats: regimeBuckets,
      exitReasonStats: exitReasonBuckets,
      bestVenue,
      bestLiqBucket,
      bestMomBucket,
      bestTrendRegime,
      recommendedMinMomentum,
      recommendedMinLiquidity,
      recommendedRiskMode,
      deepObservations
    };
  }

  /**
   * Get deep patterns — used by CouncilAgent for meeting reports.
   * This wraps analyze() output into a council-friendly format.
   */
  getDeepPatterns(records = []) {
    const analysis = records.length > 0 ? this.analyze(records) : { totalExits: 0, overallWinRate: 0, deepObservations: [] };
    return {
      recentWinRate: analysis.overallWinRate,
      recentTradeCount: analysis.totalExits,
      bestVenue: analysis.bestVenue || 'unknown',
      bestRegime: analysis.bestTrendRegime || 'unknown',
      recommendedRiskMode: analysis.recommendedRiskMode || 'balanced',
      suggestions: (analysis.deepObservations || []).filter((o) => o.type === 'suggestion'),
      warnings: (analysis.deepObservations || []).filter((o) => o.type === 'warning'),
      exitReasonAnalysis: analysis.exitReasonStats
        ? Object.fromEntries(
            Object.entries(analysis.exitReasonStats).map(([k, v]) => [
              k,
              v.total > 0 ? { total: v.total, winRate: (v.wins / v.total * 100).toFixed(1) + '%' } : { total: 0, winRate: 'N/A' }
            ])
          )
        : {}
    };
  }

  /**
   * Generate specific, actionable observations from pattern data.
   * These feed directly into CouncilAgent meetings.
   */
  _generateDeepObservations(venueMap, liqBuckets, momentumBuckets, regimeBuckets, exitReasonBuckets, exits) {
    const observations = [];

    // Venue observations
    for (const [venue, stats] of Object.entries(venueMap)) {
      if (stats.total >= MIN_OBSERVATIONS_FOR_DEEP_PATTERN) {
        const wr = stats.wins / stats.total;
        if (wr >= WIN_RATE_THRESHOLD_HIGH) {
          observations.push({
            type: 'suggestion',
            category: 'venue',
            message: `✅ ${venue}: ${(wr * 100).toFixed(0)}% win rate over ${stats.total} trades — prioritize this venue`,
            strength: wr
          });
        } else if (wr <= WIN_RATE_THRESHOLD_LOW) {
          observations.push({
            type: 'warning',
            category: 'venue',
            message: `⛔ ${venue}: only ${(wr * 100).toFixed(0)}% win rate over ${stats.total} trades — consider reducing exposure`,
            strength: 1 - wr
          });
        }
      }
    }

    // Momentum observations
    for (const [band, stats] of Object.entries(momentumBuckets)) {
      if (stats.total >= MIN_OBSERVATIONS_FOR_DEEP_PATTERN) {
        const wr = stats.wins / stats.total;
        const label = band === 'high' ? 'Momentum > 0.75' : band === 'mid' ? 'Momentum 0.5-0.75' : 'Momentum < 0.5';
        if (wr >= WIN_RATE_THRESHOLD_HIGH) {
          observations.push({
            type: 'suggestion',
            category: 'momentum',
            message: `✅ ${label}: ${(wr * 100).toFixed(0)}% win rate — maintain current momentum threshold`,
            strength: wr
          });
        } else if (wr <= WIN_RATE_THRESHOLD_LOW) {
          observations.push({
            type: 'warning',
            category: 'momentum',
            message: `⚠️ ${label}: only ${(wr * 100).toFixed(0)}% win rate — consider raising min momentum threshold`,
            strength: 1 - wr
          });
        }
      }
    }

    // Regime observations
    for (const [regime, stats] of Object.entries(regimeBuckets)) {
      if (stats.total >= MIN_OBSERVATIONS_FOR_DEEP_PATTERN) {
        const wr = stats.wins / stats.total;
        if (wr >= WIN_RATE_THRESHOLD_HIGH) {
          observations.push({
            type: 'suggestion',
            category: 'regime',
            message: `✅ ${regime.toUpperCase()} market: ${(wr * 100).toFixed(0)}% win rate — favorable conditions`,
            strength: wr
          });
        } else if (wr <= WIN_RATE_THRESHOLD_LOW) {
          observations.push({
            type: 'warning',
            category: 'regime',
            message: `⚠️ ${regime.toUpperCase()} market: only ${(wr * 100).toFixed(0)}% win rate — be defensive`,
            strength: 1 - wr
          });
        }
      }
    }

    // Exit reason analysis
    for (const [reason, stats] of Object.entries(exitReasonBuckets)) {
      if (stats.total >= MIN_OBSERVATIONS_FOR_DEEP_PATTERN) {
        const wr = stats.wins / stats.total;
        if (reason === 'stop-loss' && wr < 0.5) {
          observations.push({
            type: 'warning',
            category: 'exit-reason',
            message: `⚠️ Stop-loss exits: ${stats.total} trades, ${(wr * 100).toFixed(0)}% profitable — stops may be too tight or entries poorly timed`,
            strength: 1 - wr
          });
        }
        if (reason === 'take-profit' && wr > 0.9) {
          observations.push({
            type: 'suggestion',
            category: 'exit-reason',
            message: `✅ Take-profit exits: ${stats.total} trades, ${(wr * 100).toFixed(0)}% profitable — TP targets are well-calibrated`,
            strength: wr
          });
        }
        if (reason === 'trailing-stop' && wr > 0.7) {
          observations.push({
            type: 'suggestion',
            category: 'exit-reason',
            message: `✅ Trailing-stop exits: ${stats.total} trades, ${(wr * 100).toFixed(0)}% profitable — trailing strategy is effective`,
            strength: wr
          });
        }
      }
    }

    // Profitability check across all exits
    const totalExits = Object.values(exitReasonBuckets).reduce((s, v) => s + v.total, 0);
    const totalWins = Object.values(exitReasonBuckets).reduce((s, v) => s + v.wins, 0);
    if (totalExits >= 10) {
      const overallWR = totalWins / totalExits;
      if (overallWR < 0.4) {
        observations.push({
          type: 'warning',
          category: 'overall',
          message: `⚠️ Overall win rate is ${(overallWR * 100).toFixed(0)}% over ${totalExits} trades — below profitability threshold`,
          strength: 1 - overallWR
        });
      } else if (overallWR > 0.75) {
        observations.push({
          type: 'suggestion',
          category: 'overall',
          message: `✅ Overall win rate is ${(overallWR * 100).toFixed(0)}% over ${totalExits} trades — strategy is performing well`,
          strength: overallWR
        });
      }
    }

    return observations;
  }

  _bestKey(map, scoreFn) {
    let best = null;
    let bestScore = -Infinity;
    for (const [key, val] of Object.entries(map)) {
      const score = scoreFn(val);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  }
}

module.exports = { PatternAgent };
