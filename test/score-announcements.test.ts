import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { finalizeEvent, nip19, verifyEvent, type Event } from "nostr-tools";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScoreAnnouncer, recapDueAt, startScoreAnnouncements, MAX_RECAP_ATTEMPTS, noonRecapDueAt } from "../src/score-announcements";
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
  expect(a.nextWakeAt(now)).toBe(noonRecapDueAt(period + 1));
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

const noon = Date.parse("2026-10-02T12:00:00Z");
const current = getCurrentPeriodId(noon);
const pubkey = (n: number) => n.toString(16).padStart(64, "0");
const noonEvents = (events: Event[]) => events.filter(e => e.tags.some(t => t[0] === "recap"));

test("noon exact boundary and timer, runs daily and exposes only safe status", async () => {
  const db = setup(); add(db, 1, 10, current);
  const events: Event[] = [];
  const a = new ScoreAnnouncer(db, key, ["mock"], async e => { events.push(e); return true; });
  expect(noonRecapDueAt(current)).toBe(noon);
  await a.run(noon - 1);
  expect(noonEvents(events)).toHaveLength(0);
  expect(a.nextWakeAt(noon - 1)).toBe(noon);
  let delay = 0;
  const stop = startScoreAnnouncements(a, () => noon - 1, (_cb, ms) => { delay = ms; return setTimeout(() => {}, 100000); });
  await new Promise(resolve => setTimeout(resolve, 0)); stop();
  expect(delay).toBe(1);
  await a.run(noon);
  expect(noonEvents(events)).toHaveLength(1);
  expect(a.status(noon).noon).toMatchObject({ schedule: "12:00 UTC daily", windowPeriods: 21,
    includesCurrentPeriod: true, nextWakeAt: new Date(noon + 86400000).toISOString(),
    latest: { period_id: current, status: "published", attempts: 1 } });
  expect(JSON.stringify(a.status(noon))).not.toContain("event_json");
  expect(a.nextWakeAt(noon)).toBe(recapDueAt(current));
  await a.run(noon + 86400000);
  expect(noonEvents(events)).toHaveLength(2);
  expect(noonEvents(events)[1].id).not.toBe(noonEvents(events)[0].id);
  db.close();
});

test("noon includes exactly 21 periods, aggregates and orders top ten with privacy and mentions", async () => {
  const db = setup();
  for (let p = current - 20; p <= current; p++) add(db, 1, 10, p, 1, "yes", p === current ? "X" : "1");
  add(db, 2, 210, current, 1, "yes", "X");
  add(db, 3, 210, current); // wins beat the loss, but account 1 has more wins
  for (let n = 14; n >= 4; n--) add(db, n, 10, current);
  add(db, 90, 9999, current - 21); add(db, 91, 9999, current + 1);
  add(db, 92, 9999, current, 0); add(db, 93, 9999, current, 1, null);
  const events: Event[] = [];
  await new ScoreAnnouncer(db, key, ["mock"], async e => { events.push(e); return true; }).run(noon);
  const e = noonEvents(events)[0];
  expect(verifyEvent(e)).toBe(true);
  expect(e.tags.filter(t => t[0] === "p").map(t => t[1])).toEqual([1,3,2,4,5,6,7,8,9,10].map(pubkey));
  expect(e.content).toContain("210 points · 21 games · 20 wins");
  expect(e.content).toContain("2026-09-12 through 2026-10-02 (inclusive)");
  expect(e.content).toContain("Snapshot: 2026-10-02T12:00:00.000Z");
  expect(e.content).toContain("today’s puzzle is still in progress");
  for (const event of events) {
    expect(event.content).toContain("#word5"); expect(event.tags).toContainEqual(["t", "word5"]);
    expect(event.content).toContain("https://otherstuff.ai/word5/");
    for (const tag of event.tags.filter(t => t[0] === "p")) expect(event.content).toContain(`nostr:${nip19.npubEncode(tag[1])}`);
    for (const n of [90,91,92,93]) expect(event.content).not.toContain(nip19.npubEncode(pubkey(n)));
  }
  db.close();
});

test("noon tie ordering uses wins then games then pubkey", async () => {
  const db = setup(); add(db,1,20,current,1,"yes","X"); add(db,2,20,current);
  add(db,3,10,current); add(db,3,10,current-1,1,"yes","X");
  add(db,4,20,current);
  const events: Event[]=[];
  await new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);return true;}).run(noon);
  expect(noonEvents(events)[0].tags.filter(t=>t[0]==="p").map(t=>t[1])).toEqual([3,2,4,1].map(pubkey));
  db.close();
});

test("legacy daily upgrade preserves stored event bytes and coexists with restart-safe noon retries", async () => {
  const dir=mkdtempSync(join(tmpdir(),"word5-noon-")); const path=join(dir,"test.sqlite");
  let db=setup(path); add(db,1); add(db,2,20,current);
  db.exec(`CREATE TABLE game_score_announcements (period_id INTEGER PRIMARY KEY,event_json TEXT,status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,published_at_utc TEXT)`);
  const old = finalizeEvent({kind:1,created_at:Math.floor(now/1000),tags:[["t","word5"]],content:"legacy unchanged"},key);
  const oldJson=JSON.stringify(old);
  db.query("INSERT INTO game_score_announcements VALUES (?,?, 'published',1,?,?)").run(period,oldJson,now,new Date(now).toISOString());
  const events:Event[]=[];
  await new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);return false;}).run(noon);
  expect(events).toHaveLength(1); expect(noonEvents(events)).toHaveLength(1);
  expect(db.query("SELECT event_json FROM game_score_announcements WHERE period_id=?").get(period)).toEqual({event_json:oldJson});
  db.close(); db=new Database(path); add(db,3,999,current);
  const a=new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);return true;});
  await a.run(noon+59999); expect(events).toHaveLength(1);
  await a.run(noon+60000); expect(events).toHaveLength(2); expect(events[1]).toEqual(events[0]);
  db.close(); db=new Database(path);
  await new ScoreAnnouncer(db,key,["mock"],async()=>{throw Error("must not publish");}).run(noon+120000);
  expect(db.query("SELECT event_json FROM game_score_announcements WHERE period_id=?").get(period)).toEqual({event_json:oldJson});
  db.close(); rmSync(dir,{recursive:true});
});

test("noon empty skip and latest-only startup catchup labels actual snapshot", async () => {
  const db=setup(); let calls=0;
  const a=new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return true;});
  await a.run(noon); add(db,1,10,current); await a.run(noon+1000);
  expect(calls).toBe(0);
  expect(db.query("SELECT status,event_json FROM game_score_noon_announcements").get()).toEqual({status:"empty",event_json:null});
  db.close();
  const db2=setup(); add(db2,1,10,current-20);
  const events:Event[]=[]; const late=noon+3600000;
  await new ScoreAnnouncer(db2,key,["mock"],async e=>{events.push(e);return true;}).run(late);
  expect(noonEvents(events)).toHaveLength(1);
  expect(noonEvents(events)[0].content).toContain(new Date(late).toISOString());
  expect(db2.query("SELECT period_id FROM game_score_noon_announcements").all()).toEqual([{period_id:current}]);
  db2.close();
  const db3=setup(); add(db3,1,10,current-1);
  await new ScoreAnnouncer(db3,key,["mock"],async e=>{events.push(e);return true;}).run(noon-1);
  expect(db3.query("SELECT * FROM game_score_noon_announcements").all()).toHaveLength(0); db3.close();
});

test("noon hangs and competing runners are bounded; retry cap survives reinstantiation", async () => {
  const db=setup(); add(db,1,10,current); let calls=0;
  const a=new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return new Promise(()=>{});},1);
  const running=a.run(noon);
  // Daily empty processing yields before noon claim.
  await new Promise(resolve=>setTimeout(resolve,0));
  const b=new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return false;});
  await b.run(noon); await running; expect(calls).toBe(1);
  let time=noon+60000;
  for(let i=1;i<MAX_RECAP_ATTEMPTS;i++) {
    const restarted=new ScoreAnnouncer(db,key,["mock"],async()=>{calls++;return false;});
    await restarted.run(time); time=restarted.nextWakeAt(time);
  }
  await b.run(noon+7200000); expect(calls).toBe(MAX_RECAP_ATTEMPTS);
  expect(b.status(noon+7200000).noon.latest).toMatchObject({status:"failed",attempts:MAX_RECAP_ATTEMPTS});
  db.close();
});

test("daily and noon for the same period have independent IDs; old pending noon retains snapshot", async () => {
  const db=setup(); add(db,1,10,current);
  const events:Event[]=[];
  const a=new ScoreAnnouncer(db,key,["mock"],async e=>{events.push(e);return !e.tags.some(t=>t[0]==="recap");});
  await a.run(noon);
  const saved=noonEvents(events)[0];
  const nextMorning=recapDueAt(current);
  await a.run(nextMorning);
  const daily=events.find(e=>e.tags.some(t=>t[0]==="period" && t[1]===String(current)) && !e.tags.some(t=>t[0]==="recap"))!;
  expect(daily.id).not.toBe(saved.id);
  expect(noonEvents(events)[1]).toEqual(saved);
  expect(db.query("SELECT period_id FROM game_score_announcements WHERE period_id=?").get(current)).toEqual({period_id:current});
  expect(db.query("SELECT period_id FROM game_score_noon_announcements").all()).toEqual([{period_id:current}]);
  db.close();
});
