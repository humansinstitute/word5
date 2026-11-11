import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const completionFunction = source.match(/    function updateStatsForCompletedGame\(won\) \{[\s\S]*?\n    \}/)![0];
function complete(lastPeriodId: number | null, periodId: number) {
  const state = { periodId, lastPeriodId, lastCompletedPuzzle: lastPeriodId === null ? 0 : lastPeriodId % 1000,
    stats: { played: 40, won: 39, streak: 12, maxStreak: 15 } };
  runInNewContext(`${completionFunction}; updateStatsForCompletedGame(true);`, { state });
  return state;
}
test('offline local continuation uses absolute periods, including rollover, never a 1000-day alias', () => {
  expect(complete(20999, 21000).stats.streak).toBe(13);
  expect(complete(19999, 21000).stats.streak).toBe(1);
  expect(complete(null, 21000).stats.streak).toBe(1);
  expect(complete(20998, 21000).stats.maxStreak).toBe(15);
  expect(complete(20999, 21000).lastPeriodId).toBe(21000);
});
