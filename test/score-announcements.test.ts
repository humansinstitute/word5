import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { finalizeEvent, nip19, verifyEvent, type Event } from "nostr-tools";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScoreAnnouncer, recapDueAt, startScoreAnnouncements, MAX_RECAP_ATTEMPTS } from "../src/score-announcements";
import { getCurrentPeriodId } from "../src/word5";
const now = Date.parse("2026-10-02T00:21:00Z");
const period = getCurrentPeriodId(now) - 1;
const key = new Uint8Array(32).fill(1); // synthetic test signer only
function setup(path = ":memory:") {
  const db = new Database(path);
  db.exec(`CREATE TABLE game_submissions (pubkey TEXT,period_id INTEGER,points INTEGER,result TEXT,verified_completion INTEGER,published_at TEXT)`);
  return db;
}
function add(db: Database, n: number, points = 10, p = period, verified = 1, published: string | null = "yes", result = "1") {
  db.query("INSERT INTO game_submissions VALUES (?,?,?,?,?,?)").run(n.toString(16).padStart(64, "0"), p, points, result, verified, published);
}
test("UTC boundary and exact scheduler delay, with previous full period across month", async () => {
  const db = setup(); add(db, 1);
  const events: Event[] = [];
  const a = new ScoreAnnouncer(db, key, ["mock"], async e => { events.push(e); return true; });
  expect(recapDueAt(period)).toBe(now);
  expect(await a.run(now - 1)).toBe("not-due");
  expect(events).toHaveLength(0);
  expect(a.nextWakeAt(now - 1)).toBe(now);
  let delay = 0;
  const stop = startScoreAnnouncements(a, () => now - 1, (_cb, ms) => { delay = ms; return setTimeout(() => {}, 100000); });
  await new Promise(resolve => setTimeout(resolve, 0)); stop();
  expect(delay).toBe(1);
  expect(await a.run(now)).toBe("published");
  expect(events[0].tags).toContainEqual(["date", "2026-10-01"]);
  expect(events[0].tags).toContainEqual(["puzzle", "727"]);
  expect(a.nextWakeAt(now)).toBe(now + 86400000);
  db.close();
});
test("published verified only, unique top ten with stable ties and native mentions", async () => {
  const db = setup();
  for (let n = 12; n >= 1; n--) add(db, n, 10);
  add(db, 20, 999, period, 0); add(db, 21, 999, period, 1, null);
  add(db, 22, 999, period + 1); add(db, 23, 999, period - 1);
  add(db, 30, 10, period, 1, "yes", "X");
  let event!: Event;
  await new ScoreAnnouncer(db, key, ["mock"], async e => { event = e; return true; }).run(now);
  const keys = event.tags.filter(t => t[0] === "p").map(t => t[1]);
  expect(keys).toEqual(Array.from({length: 10}, (_, i) => (i+1).toString(16).padStart(64,"0")));
  expect(verifyEvent(event)).toBe(true);
  keys.forEach((pk, i) => expect(event.content).toContain(`${i+1}. nostr:${nip19.npubEncode(pk!)} — 10 points`));
  expect(event.content).toContain("https://otherstuff.ai/word5/");
  expect(event.content).toContain("Play today");
  db.close();
});
test("existing points/wins/games tie semantics aggregate unique accounts", async () => {
  const db = setup(); add(db, 1, 20, period, 1, "yes", "X"); add(db, 2, 20);
  add(db, 3, 10); add(db, 3, 10);
  let event!: Event;
  await new ScoreAnnouncer(db,key,["mock"], async e => {event=e;return true;}).run(now);
  expect(event.tags.filter(t=>t[0]==="p").map(t=>t[1])).toEqual([3,2,1].map(n=>n.toString(16).padStart(64,"0")));
  expect(event.content).toContain("top 3 publicly posted scores");
  expect(event.content).not.toContain("4. nostr:"); db.close();
});
test("disk restart and uncertain relay acceptance retry exact event; completed state suppresses resend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "word5-recap-")); const path = join(dir,"test.sqlite");
  let db = setup(path); add(db,1);
  const events: Event[] = [];
  const fail = new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);throw new Error("uncertain");});
  expect(await fail.run(now)).toBe("retry"); db.close();
  db = new Database(path); add(db,2,999);
  const retry = new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);return true;});
  expect(await retry.run(now+59999)).toBe("idle");
  expect(await retry.run(now+60000)).toBe("published");
  expect(events[1]).toEqual(events[0]);
  expect(await retry.run(now+120000)).toBe("idle");
  db.close(); db = new Database(path);
  expect(await new ScoreAnnouncer(db,key,["mock"],async()=>{throw Error("must not send");}).run(now+180000)).toBe("idle");
  db.close(); rmSync(dir,{recursive:true});
});
test("bounded hangs, competing runners, persistent retry cap and pending catchup after rollover", async () => {
  const db = setup(); add(db,1); let calls=0;
  const a = new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return new Promise(()=>{});},1);
  const b = new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return true;});
  const running = a.run(now);
  expect(await b.run(now)).toBe("idle");
  expect(await running).toBe("retry");
  expect(await b.run(now+86400000)).toBe("published"); // resumes old pending ID
  expect(calls).toBe(2);
  db.close();
  const db2=setup(); add(db2,1); calls=0;
  let time=now;
  for(let i=0;i<MAX_RECAP_ATTEMPTS;i++) {
    const restarted=new ScoreAnnouncer(db2,key,["mock"],async()=>{calls++;return false;});
    expect(await restarted.run(time)).toBe("retry"); time=restarted.nextWakeAt(time);
  }
  expect(await new ScoreAnnouncer(db2,key,["mock"],async()=>{calls++;return true;}).run(now+7200000)).toBe("idle");
  expect(calls).toBe(MAX_RECAP_ATTEMPTS); db2.close();
});
test("empty persisted skip, missing signer and relays never publish", async () => {
  const db=setup(); let calls=0; const publish=async()=>{calls++;return true;};
  expect(await new ScoreAnnouncer(db,null,["mock"],publish).run(now)).toBe("disabled");
  expect(await new ScoreAnnouncer(db,key,[],publish).run(now)).toBe("disabled");
  const a=new ScoreAnnouncer(db,key,["mock"],publish);
  expect(await a.run(now)).toBe("idle"); add(db,1);
  expect(await a.run(now+1000)).toBe("idle"); expect(calls).toBe(0);
  expect(db.query("SELECT status,event_json FROM game_score_announcements").get()).toEqual({status:"empty",event_json:null}); db.close();
});
test("crash on final claim wakes at lease expiry and becomes terminal without another send", async () => {
  const db=setup(); add(db,1);
  const a=new ScoreAnnouncer(db,key,["mock"],async()=>false);
  await a.run(now);
  db.query("UPDATE game_score_announcements SET attempts=?,next_attempt_ms=?").run(MAX_RECAP_ATTEMPTS,now+60000);
  expect(a.nextWakeAt(now)).toBe(now+60000);
  expect(await a.run(now+60000)).toBe("idle");
  expect(a.status(now+60000).latest).toMatchObject({status:"failed",attempts:MAX_RECAP_ATTEMPTS}); db.close();
});
