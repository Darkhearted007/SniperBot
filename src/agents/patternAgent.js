/**
 * PatternAgent analyses accumulated trade logs to detect which venues, liquidity ranges,
 * and momentum thresholds produce the highest win rates.
 * It feeds those insights back to the OrchestratorAgent so the active strategy can adapt.
 */
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

    for (const r of exits) {
      const venue = r.position?.venue || 'unknown';
      const liq = r.position?.liquidityUsd || 0;
      const momentum = r.position?.momentumScore || 0;
      const isWin = r.execution?.pnlPct > 0;

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
    }

    const winRate = (bucket) =>
      bucket.total === 0 ? 0 : bucket.wins / bucket.total;

    const bestVenue = this._bestKey(venueMap, (v) => (v.total >= 3 ? winRate(v) : -1));
    const bestLiqBucket = this._bestKey(liqBuckets, winRate);
    const bestMomBucket = this._bestKey(momentumBuckets, winRate);

    // Recommended minimum momentum score based on the best performing bucket
    const recommendedMinMomentum =
      bestMomBucket === 'high' ? 0.75 : bestMomBucket === 'mid' ? 0.50 : 0.30;

    // Recommended minimum liquidity based on the best performing bucket
    const recommendedMinLiquidity =
      bestLiqBucket === 'high' ? 100000 : bestLiqBucket === 'mid' ? 30000 : 10000;

    return {
      totalExits: exits.length,
      overallWinRate: exits.length === 0 ? 0 : exits.filter((r) => r.execution?.pnlPct > 0).length / exits.length,
      venueStats: venueMap,
      liqBucketStats: liqBuckets,
      momentumBucketStats: momentumBuckets,
      bestVenue,
      bestLiqBucket,
      bestMomBucket,
      recommendedMinMomentum,
      recommendedMinLiquidity
    };
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
