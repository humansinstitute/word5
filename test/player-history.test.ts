import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Word5Service, getWordForPeriod, getDateForPeriod } from '../src/word5';

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'word5-history-'));
  mkdirSync(join(rootDir, 'assets'));
  writeFileSync(join(rootDir, 'assets/answers.txt'), 'apple\nbrave\ncrane\n');
  writeFileSync(join(rootDir, 'assets/wla.txt'), 'apple\nbrave\ncrane\nother\n');
  const service = new Word5Service({ rootDir, dbPath: ':memory:', relays: [], gamestrRelays: [] });
  const secret = generateSecretKey(), pubkey = getPublicKey(secret);
  const publicScore = (period: number, result = '2', kind = 1) => finalizeEvent({ kind, created_at: period * 86400 + 10,
    tags: [['t', 'word5'], ['puzzle', String(period % 1000)], ['result', result]], content: '' }, secret);
  const complete = (period: number, seconds = 20) => service.complete(finalizeEvent({ kind: 30078, created_at: period * 86400 + seconds,
    tags: [['schema', 'word5.completion.v1']], content: JSON.stringify({ game: 'word5', periodId: period,
      puzzle: period % 1000, date: getDateForPeriod(period), result: '1',
      guesses: [getWordForPeriod(service.answers, period)], hardMode: false }) }, secret), period * 86400000 + (seconds + 10) * 1000);
  return { service, secret, pubkey, publicScore, complete };
}

describe('authoritative player history', () => {
  test('clean phone gets unpublished completions, continues next day, and retries/duplicate public formats count once', () => {
    const f = fixture();
    f.service.socialHistory.archive(f.publicScore(20998));
    f.service.socialHistory.archive(f.publicScore(20998, '2', 5555));
    f.complete(20999); f.complete(20999);
    const before = f.service.playerHistory(f.pubkey, 21000 * 86400000 + 30000);
    expect(before.stats).toEqual({ played: 2, won: 2, streak: 2, maxStreak: 2 });
    expect(before.completed).toBe(false);
    expect(before.lastPuzzle).toBe(999);
    f.complete(21000);
    const after = f.service.playerHistory(f.pubkey, 21000 * 86400000 + 30000);
    expect(after.stats).toEqual({ played: 3, won: 3, streak: 3, maxStreak: 3 });
    expect(after.completed).toBe(true);
    expect(JSON.stringify(after)).not.toContain('guesses');
    expect(after).not.toHaveProperty('rows');
    expect(after).not.toHaveProperty('eventId');
    expect(after).not.toHaveProperty('createdAt');
    expect(f.service.playerHistory(getPublicKey(generateSecretKey()), 21000 * 86400000).stats.played).toBe(0);
    f.service.db.close();
  });
  test('unpublished historical completion details are not exposed by the restoration summary', () => {
    const f = fixture();
    const saved = f.complete(21002);
    const summary = f.service.playerHistory(f.pubkey, 21030 * 86400000);
    expect(summary.stats.played).toBe(1);
    expect(summary.currentResult).toBeNull();
    expect(summary).not.toHaveProperty('rows');
    expect(JSON.stringify(summary)).not.toContain(String(saved.submission.eventId));
    expect(JSON.stringify(summary)).not.toContain('createdAt');
    f.service.db.close();
  });
  test('loss, skipped period and expiry break the active streak; all-time maximum remains', () => {
    const f = fixture();
    for (const [p, result] of [[21010, '2'], [21011, '2'], [21012, 'X'], [21013, '2'], [21015, '2']] as const)
      f.service.socialHistory.archive(f.publicScore(p, result));
    expect(f.service.playerHistory(f.pubkey, 21015 * 86400000).stats).toEqual({ played: 5, won: 4, streak: 1, maxStreak: 2 });
    expect(f.service.playerHistory(f.pubkey, 21017 * 86400000).stats.streak).toBe(0);
    f.service.db.close();
  });
  test('a same-day win after a correction extends the baseline; a correction after a win includes it', () => {
    const f = fixture();
    const correction = (period: number, seconds: number) => finalizeEvent({ kind: 5555, created_at: period * 86400 + seconds,
      tags: [['t', 'word5'], ['schema', 'word5.stats.v1'], ['played', '40'], ['won', '39'], ['streak', '12'], ['maxStreak', '15']], content: '' }, f.secret);
    f.service.socialHistory.archive(correction(21002, 100)); f.complete(21002, 200);
    expect(f.service.playerHistory(f.pubkey, 21002 * 86400000 + 300000).stats).toEqual({ played: 41, won: 40, streak: 13, maxStreak: 15 });
    f.service.socialHistory.archive(correction(21002, 250));
    expect(f.service.playerHistory(f.pubkey, 21002 * 86400000 + 300000).stats).toEqual({ played: 40, won: 39, streak: 12, maxStreak: 15 });
    f.service.db.close();
  });
  test('signed correction replaces old baseline and later verified wins extend it exactly once', () => {
    const f = fixture();
    f.service.socialHistory.archive(f.publicScore(21010));
    const correction = finalizeEvent({ kind: 5555, created_at: 21010 * 86400 + 100,
      tags: [['t', 'word5'], ['schema', 'word5.stats.v1'], ['played', '40'], ['won', '39'], ['streak', '12'], ['maxStreak', '15']], content: '' }, f.secret);
    f.service.socialHistory.archive(correction); f.complete(21011); f.complete(21011);
    expect(f.service.playerHistory(f.pubkey, 21011 * 86400000 + 30000).stats).toEqual({ played: 41, won: 40, streak: 13, maxStreak: 15 });
    expect(() => f.service.playerHistory('bad')).toThrow('pubkey');
    f.service.db.close();
  });
  test('native authenticated baseline contains known outcomes without expanding public history', () => {
    const f = fixture(); f.complete(21000); f.service.socialHistory.archive(f.publicScore(20999,'3'));
    const native = f.service.playerHistory(f.pubkey,21000*86400000+30000,true) as any;
    expect(native.coveredPeriods).toEqual([20999,21000]);
    expect(native.outcomes).toEqual([[20999,3],[21000,1]]);
    expect(native.distribution).toEqual([1,0,1,0,0,0]);
    expect(native.correctionAnchor).toBeNull();
    const publicSummary = f.service.playerHistory(f.pubkey,21000*86400000+30000);
    expect(publicSummary).not.toHaveProperty('coveredPeriods');
    expect(publicSummary).not.toHaveProperty('outcomes');
    expect(publicSummary).not.toHaveProperty('distribution');
    expect(publicSummary).not.toHaveProperty('correctionAnchor');
    f.service.db.close();
  });

  test('native correction seed is captured before later public games advance it', () => {
    const f = fixture();
    const correction = finalizeEvent({ kind: 5555, created_at: 21000 * 86400 + 100,
      tags: [['t', 'word5'], ['schema', 'word5.stats.v1'], ['played', '0'], ['won', '0'], ['streak', '0'], ['maxStreak', '0']], content: '' }, f.secret);
    f.service.socialHistory.archive(correction);
    f.service.socialHistory.archive(f.publicScore(21002));
    f.service.socialHistory.archive(f.publicScore(21004));
    const now = 21004 * 86400000 + 30000;
    const native = f.service.playerHistory(f.pubkey, now, true) as any;
    expect(native.stats).toEqual({ played: 2, won: 2, streak: 1, maxStreak: 1 });
    expect(native.lastPeriodId).toBe(21004);
    expect(native.correctionCreatedAt).toBe(correction.created_at);
    expect(native.correctionEventId).toBe(correction.id);
    expect(native.correctionAnchor).toEqual({ streak: 0, maxStreak: 0, lastPeriod: 21000, covered: [] });
    expect(native.outcomes).toEqual([[21002, 2], [21004, 2]]);
    expect(f.service.playerHistory(f.pubkey, now)).not.toHaveProperty('correctionAnchor');
    f.service.db.close();
  });

  test('native correction coverage distinguishes an earlier from a later same-day completion', () => {
    const f = fixture();
    const correction = (seconds: number) => finalizeEvent({ kind: 5555, created_at: 21002 * 86400 + seconds,
      tags: [['t', 'word5'], ['schema', 'word5.stats.v1'], ['played', '40'], ['won', '39'], ['streak', '12'], ['maxStreak', '15']], content: '' }, f.secret);
    f.service.socialHistory.archive(correction(100));
    f.complete(21002, 200);
    const before = f.service.playerHistory(f.pubkey, 21002 * 86400000 + 300000, true) as any;
    expect(before.correctionAnchor).toEqual({ streak: 12, maxStreak: 15, lastPeriod: 21001, covered: [] });
    expect(before.stats.streak).toBe(13);
    f.service.socialHistory.archive(correction(250));
    const after = f.service.playerHistory(f.pubkey, 21002 * 86400000 + 300000, true) as any;
    expect(after.correctionAnchor).toEqual({ streak: 12, maxStreak: 15, lastPeriod: 21002, covered: [21002] });
    expect(after.stats.streak).toBe(12);
    expect(JSON.stringify(after.correctionAnchor)).not.toContain('guesses');
    f.service.db.close();
  });

});
