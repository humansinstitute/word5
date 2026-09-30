import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VisitTracker } from "../src/visits";
import { VisitAnnouncer, currentMilestone, milestoneCrossed } from "../src/visit-announcements";

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
    const daily = db.query("SELECT perth_date, COUNT(*) AS people FROM game_day_visitors GROUP BY perth_date").all();
    expect(daily).toEqual([{ perth_date: "2026-09-30", people: 2 }]);
    expect(() => tracker.record("invalid")).toThrow("Valid session public key required");
    db.close();
  });

  test("retries one stable Nostr event and records a single completed puzzle announcement", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "word5-announcement-")), "visits.sqlite");
    const db = new Database(path);
    const tracker = new VisitTracker(db, path);
    tracker.record("a".repeat(64), new Date("2026-09-29T23:59:00Z"));
    tracker.record("a".repeat(64), new Date("2026-09-29T23:59:10Z"));
    tracker.record("b".repeat(64), new Date("2026-09-29T23:59:20Z"));
    const eventIds: string[] = [];
    const announcer = new VisitAnnouncer(db, new Uint8Array(32).fill(1), ["wss://example.com"], async (event) => {
      eventIds.push(event.id);
      expect(event.content).toBe("2 people played Word5 yesterday!");
      return eventIds.length > 1;
    });
    const now = new Date("2026-09-30T00:01:00Z");
    expect(await announcer.announceYesterday(now)).toBe("retry");
    expect(await announcer.announceYesterday(now)).toBe("published");
    expect(await announcer.announceYesterday(now)).toBe("already-published");
    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).toBe(eventIds[1]);
    expect(milestoneCrossed(512, 200)).toBe(512);
    expect(milestoneCrossed(512, 600)).toBeNull();
    db.close();
  });

  test("publishes a current puzzle milestone once at 256 visitors", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "word5-milestone-")), "visits.sqlite");
    const db = new Database(path);
    const tracker = new VisitTracker(db, path);
    const now = new Date("2026-09-30T12:00:00Z");
    for (let i = 0; i < 256; i++) tracker.record(i.toString(16).padStart(64, "0"), now);
    const events: string[] = [];
    const announcer = new VisitAnnouncer(db, new Uint8Array(32).fill(1), ["wss://example.com"], async (event) => {
      events.push(event.id);
      expect(event.content).toContain("256 players for today's puzzle");
      return true;
    });
    expect(currentMilestone(255)).toBe(100);
    expect(await announcer.announceCurrentMilestone(now)).toBe("published");
    expect(await announcer.announceCurrentMilestone(now)).toBe("already-published");
    expect(events).toHaveLength(1);
    db.close();
  });
});
