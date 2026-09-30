import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VisitTracker } from "../src/visits";

describe("game visits", () => {
  test("deduplicates by puzzle and records Perth visit hours across rollover", () => {
    const path = join(mkdtempSync(join(tmpdir(), "word5-visits-")), "visits.sqlite");
    const db = new Database(path);
    const tracker = new VisitTracker(db, path);
    const player = "a".repeat(64);
    tracker.record(player, new Date("2026-09-29T23:59:00Z"));
    tracker.record(player, new Date("2026-09-29T23:59:30Z"));
    tracker.record("b".repeat(64), new Date("2026-09-29T23:59:45Z"));

    expect(tracker.yesterday(new Date("2026-09-30T00:00:00Z"))).toEqual({
      puzzleDate: "2026-09-29", people: 2, timezone: "Australia/Perth",
    });
    tracker.record(player, new Date("2026-09-30T00:01:00Z"));
    expect(tracker.yesterday(new Date("2026-09-30T00:01:00Z")).people).toBe(2);

    const visitors = db.query("SELECT period_id, visitor_hash, visit_count FROM game_visitors ORDER BY period_id").all() as Array<{ period_id: number; visitor_hash: string; visit_count: number }>;
    expect(visitors.map((row) => row.visit_count).sort()).toEqual([1, 1, 2]);
    expect(new Set(visitors.map((row) => row.visitor_hash)).size).toBe(3);
    expect(visitors.every((row) => row.visitor_hash !== player)).toBe(true);
    const hours = db.query("SELECT DISTINCT perth_date, perth_hour FROM game_visit_events ORDER BY perth_date, perth_hour").all();
    expect(hours).toEqual([{ perth_date: "2026-09-30", perth_hour: 7 }, { perth_date: "2026-09-30", perth_hour: 8 }]);
    expect(() => tracker.record("invalid")).toThrow("Valid session public key required");
    db.close();
  });
});
