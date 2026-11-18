import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { PublicReader, READER_PATH, READER_NPUB } from '../src/public-reader';
import { Word5Service, getDateForPeriod, getWordForPeriod } from '../src/word5';
import { acceptedOutcomes, playerReport } from '../src/reconciliation';

const roots: string[] = [];
const services: Word5Service[] = [];
afterEach(() => { services.splice(0).forEach(s => s.db.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture(base = 'https://otherstuff.ai/word5/') {
  const rootDir = mkdtempSync(join(tmpdir(), 'word5-reader-')); roots.push(rootDir);
  mkdirSync(join(rootDir, 'assets')); writeFileSync(join(rootDir, 'assets/answers.txt'), 'apple\nbrave\ncrane\n');
  const service = new Word5Service({ rootDir, dbPath: ':memory:', relays: [], gamestrRelays: [] }); services.push(service);
  const key = generateSecretKey(), pubkey = getPublicKey(key), period = 20770, now = period * 86400000 + 200000;
  const reader = new PublicReader(service.db, base, [pubkey]);
  const score = (p = period, result = '2', kind = 1, signer = key) => finalizeEvent({ kind, created_at: p * 86400 + 10,
    tags: [['t', 'word5'], ['period', String(p)], ['puzzle', String(p % 1000)], ['result', result]], content: '' }, signer);
  const request = (suffix = '', options: { method?: string; signedMethod?: string; signedUrl?: string; signer?: Uint8Array; createdAt?: number; tags?: string[][]; kind?: number; content?: string; mutate?: (e: any) => void; headers?: Record<string,string>; rawAuth?: string } = {}) => {
    const method = options.method || 'GET';
    const external = base + READER_PATH.slice(1) + suffix;
    const event = finalizeEvent({ kind: options.kind ?? 27235, created_at: options.createdAt ?? Math.floor(now / 1000),
      tags: options.tags ?? [['u', options.signedUrl ?? external], ['method', options.signedMethod ?? method]], content: options.content ?? '' }, options.signer ?? key);
    options.mutate?.(event);
    const req = new Request('http://127.0.0.1:41005' + READER_PATH + suffix, { method,
      headers: { authorization: options.rawAuth ?? 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64'), ...options.headers } });
    return reader.handle(req, now);
  };
  const completion = (signer = key) => finalizeEvent({kind:30078,created_at:Math.floor(now/1000),tags:[['schema','word5.completion.v1']],content:JSON.stringify({game:'word5',periodId:period,puzzle:period%1000,date:getDateForPeriod(period),result:'1',guesses:[getWordForPeriod(service.answers,period)],hardMode:false})},signer);
  return { service, key, pubkey, period, now, reader, score, request, completion, base };
}

describe('reader NIP-98 boundary', () => {
  test('production signer is exactly the approved npub; discovery lists explicit fields', async () => {
    expect(nip19.decode(READER_NPUB).type).toBe('npub');
    const f = fixture();
    const discovery = await f.request().json();
    expect(discovery.endpoints.map((x: any) => x.path)).toEqual(['players','games','results'].map(x => READER_PATH + '/' + x));
    const defaultReader = new PublicReader(f.service.db);
    const event = finalizeEvent({kind:27235,created_at:f.now/1000,tags:[['u',f.base+READER_PATH.slice(1)],['method','GET']],content:''},f.key);
    expect(defaultReader.handle(new Request('http://local'+READER_PATH,{headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')}}),f.now).status).toBe(401);
  });
  test('valid production prefix and dev root; internal, wrong prefix/origin/query/order and proxy tricks fail', () => {
    for (const base of ['https://otherstuff.ai/word5/', 'https://reader.example.test/']) {
      const f = fixture(base), suffix = '/results?limit=1&periodId=20770';
      expect(f.request(suffix).status).toBe(200);
      for (const url of ['http://127.0.0.1:41005'+READER_PATH+suffix, 'https://evil.test/'+READER_PATH.slice(1)+suffix,
        base+READER_PATH.slice(1)+'/results?periodId=20770&limit=1', base+READER_PATH.slice(1)+'/results?limit=2&periodId=20770',
        base+READER_PATH.slice(1)+'/results', base+'word5/'+READER_PATH.slice(1)+suffix]) {
        expect(f.request(suffix,{signedUrl:url,headers:{'x-forwarded-host':'evil.test','x-forwarded-proto':'https','forwarded':'host=evil.test;proto=https'}}).status).toBe(401);
      }
      expect(f.request(suffix,{headers:{'x-forwarded-host':'evil.test','x-forwarded-prefix':'/evil'}}).status).toBe(200);
    }
  });
  test('signature, event hash, signer, kind, content, time and singleton tags checked', () => {
    const f = fixture();
    for (const options of [{signer:generateSecretKey()}, {kind:1}, {content:'private'}, {createdAt:NaN},
      {createdAt:Math.floor(f.now/1000)-61}, {createdAt:Math.floor(f.now/1000)+61}, {createdAt:-1},
      {signedMethod:'POST'}, {mutate:(e:any)=>{e.sig='0'.repeat(128);}}, {mutate:(e:any)=>{e.id='0'.repeat(64);}},
      {tags:[['u',f.base+READER_PATH.slice(1)],['method','GET'],['method','GET']]},
      {tags:[['u',f.base+READER_PATH.slice(1)],['method','GET','extra']]},
      {tags:[['u',f.base+READER_PATH.slice(1)]]}, {rawAuth:'Basic xyz'}, {rawAuth:'Nostr !!!'},
      {rawAuth:'Nostr '+Buffer.from('{}').toString('base64')}, {rawAuth:'Nostr '+'a'.repeat(8001)}]) {
      // finalizeEvent cannot serialize NaN as a valid timestamp; it becomes null on the wire.
      expect(f.request('',options).status).toBe(401);
    }
    expect(f.request('',{createdAt:Math.floor(f.now/1000)-60}).status).toBe(200);
    expect(f.request('',{createdAt:Math.floor(f.now/1000)+60}).status).toBe(200);
  });
  test('all writes/HEAD/OPTIONS rejected; no operator, backup, chat or arbitrary dataset exposure', () => {
    const f = fixture();
    for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) expect(f.request('/results',{method}).status).toBe(405);
    for (const path of ['/chats','/backup','/reconciliation/snapshot','/constructor','/toString','/results/']) expect(f.request(path).status).toBe(404);
    expect(f.request('/results',{headers:{'content-length':'1'}}).status).toBe(400);
  });
  test('invalid base fails closed', () => {
    const f = fixture();
    for (const base of ['http://host/','https://user:pass@host/','https://host/x','https://host/?x=1','https://host/#x']) expect(()=>new PublicReader(f.service.db,base)).toThrow();
  });
});

describe('public dataset and pagination', () => {
  test('deduplicates, excludes ambiguous results, reuses canonical public stats and returns only declared fields', async () => {
    const f = fixture(), second = generateSecretKey();
    for (const e of [f.score(f.period-2), f.score(f.period-2,'2',5555), f.score(f.period-1), f.score(f.period,'X'),
      f.score(f.period-1,'1',1,second), f.score(f.period-1,'2',5555,second)]) f.service.socialHistory.archive(e);
    const results = await f.request('/results').json();
    expect(results.rows).toHaveLength(3);
    const canonical = acceptedOutcomes(f.service.db,f.now,true).outcomes;
    expect(results.rows.map((r:any)=>[r.pubkey,r.periodId,r.result,r.points,r.sourceEventId])).toEqual(canonical.map(r=>[r.pubkey,r.periodId,r.result,r.points,r.eventId]));
    for (const name of ['players','games','results']) {
      const data = await f.request('/'+name).json();
      for (const row of data.rows) expect(Object.keys(row)).toEqual(data.fields);
    }
    const players = await f.request('/players?pubkey='+f.pubkey).json();
    expect(players.rows[0]).toMatchObject(playerReport(f.service.db,f.pubkey,f.now,false,true).stats);
    const games = await f.request('/games?periodId='+f.period).json();
    expect(games.rows).toEqual([{periodId:f.period,puzzle:f.period%1000,date:getDateForPeriod(f.period),games:1,wins:0,points:0}]);
    expect((await f.request('/results?pubkey='+getPublicKey(second)).json()).rows).toEqual([]);
  });
  test('private completion and arbitrary secret tables cannot change responses or cursor; no guesses/answers/raw data', async () => {
    const f = fixture();
    for (const p of [f.period-2,f.period-1]) f.service.socialHistory.archive(f.score(p));
    const before = await Promise.all(['players','games','results'].map(async name => [name, await f.request('/'+name+'?limit=1').text()]));
    f.service.complete(f.completion(),f.now);
    f.service.complete(f.completion(generateSecretKey()),f.now);
    f.service.db.exec(`CREATE TABLE secret_chat_fixture(content TEXT); INSERT INTO secret_chat_fixture VALUES('private chat secret'); CREATE TABLE encrypted_backup_fixture(content TEXT); INSERT INTO encrypted_backup_fixture VALUES('backup secret');`);
    for (const [name, body] of before) expect(await f.request('/'+name+'?limit=1').text()).toBe(body);
    const results = await f.request('/results').text();
    expect(results).not.toContain('apple'); expect(results).not.toContain('guesses'); expect(results).not.toContain('secret');
    expect(results).not.toContain(f.completion().id);
  });
  test('complete paging without repeats, filters bound, public changes invalidate, malformed inputs rejected', async () => {
    const f = fixture();
    for (let n=0;n<5;n++) f.service.socialHistory.archive(f.score(f.period-n));
    let cursor: string|null = null; const seen:any[]=[];
    do {
      const page = await f.request('/results?limit=2'+(cursor?'&cursor='+cursor:'')).json();
      seen.push(...page.rows); cursor=page.nextCursor;
    } while(cursor);
    expect(seen).toHaveLength(5); expect(new Set(seen.map(r=>r.sourceEventId)).size).toBe(5);
    const first = await f.request('/results?limit=1').json();
    expect(f.request('/games?cursor='+first.nextCursor).status).toBe(409);
    expect(f.request('/results?pubkey='+f.pubkey+'&cursor='+first.nextCursor).status).toBe(409);
    f.service.socialHistory.archive(f.score(f.period-6));
    expect(f.request('/results?cursor='+first.nextCursor).status).toBe(409);
    for (const query of ['limit=0','limit=201','limit=-1','limit=1.5','limit=1e2','limit=Infinity','limit=9007199254740992',
      'limit=1&limit=2','bogus=1','pubkey=no','periodId=-1','periodId=','cursor=','cursor=!!!','cursor='+Buffer.from('{"offset":-1}').toString('base64url')])
      expect(f.request('/results?'+query).status).toBe(400);
    expect(f.request('/players?periodId=1').status).toBe(400);
    expect(f.request('/games?pubkey='+f.pubkey).status).toBe(400);
  });
});

test('inventory exceeds old 200-row cap and reviewed baseline uses canonical public calculations', async () => {
  const f = fixture();
  const insert = f.service.db.query(`INSERT INTO lifetime_best_decisions(decision_id,pubkey,max_streak,provenance,reason,effective_at) VALUES(?,?,?,?,?,?)`);
  for(let n=1;n<=205;n++) insert.run('reviewed-'+n,n.toString(16).padStart(64,'0'),n,'owner-confirmed','fixture baseline',Math.floor(f.now/1000));
  const page = await f.request('/players?limit=200').json();
  expect(page.rows).toHaveLength(200); expect(page.total).toBe(205);
  const next = await f.request('/players?limit=200&cursor='+page.nextCursor).json();
  expect(next.rows).toHaveLength(5); expect(next.nextCursor).toBeNull();
  expect(next.rows[4]).toMatchObject({played:0,won:0,streak:0,maxStreak:205});
  expect((await f.request('/games').json()).rows).toEqual([]);
  expect((await f.request('/results').json()).rows).toEqual([]);
});

test('query bytes including trailing empty query, escaped delimiters and encoded keys bind exact signature URL', () => {
  const f = fixture();
  expect(f.request('/results?').status).toBe(200);
  expect(f.request('/results?',{signedUrl:f.base+READER_PATH.slice(1)+'/results'}).status).toBe(401);
  expect(f.request('/results?%6cimit=1',{signedUrl:f.base+READER_PATH.slice(1)+'/results?limit=1'}).status).toBe(401);
  expect(f.request('/results?%6cimit=1').status).toBe(200);
  expect(f.request('/results?limit=1%26periodId%3D20770').status).toBe(400);
});

test('published completion without archived public post yields public ID only; unpublished result cannot resolve public conflict', async () => {
  const f = fixture();
  f.service.socialHistory.archive(f.score(f.period,'2'));
  f.service.socialHistory.archive(f.score(f.period,'3',5555));
  f.service.complete(f.completion(),f.now);
  expect((await f.request('/results').json()).rows).toEqual([]);
  const publicId = 'b'.repeat(64);
  f.service.db.query('UPDATE game_submissions SET published_at=CURRENT_TIMESTAMP,public_event_id=? WHERE pubkey=?').run(publicId,f.pubkey);
  const data = await f.request('/results').json();
  expect(data.rows[0]).toMatchObject({sourceEventId:publicId,result:'1',points:10});
  expect(JSON.stringify(data)).not.toContain(f.completion().id);
  expect(Object.keys(data.rows[0])).toEqual(data.fields);
});

test('optional broker capability tag is shape checked and cannot bypass signer allowlist', () => {
  const f = fixture(), tags=[['u',f.base+READER_PATH.slice(1)],['method','GET'],['wm-session-capability','session','capability','request']];
  expect(f.request('',{tags}).status).toBe(200);
  expect(f.request('',{tags,signer:generateSecretKey()}).status).toBe(401);
  for (const tag of [['wm-session-capability','session'],['wm-session-capability','','capability','request'],
    ['wm-session-capability','s'.repeat(1025),'capability','request'],['payload','0'.repeat(64)],['extra','harmless']])
    expect(f.request('',{tags:[...tags.slice(0,2),tag]}).status).toBe(401);
  expect(f.request('',{tags:[...tags,tags[2]!]}).status).toBe(401);
});

test('isolated real server routes reader before side effects and preserves existing public routes', async () => {
  const root = mkdtempSync(join(tmpdir(),'word5-reader-server-')); roots.push(root);
  const probe = Bun.serve({port:0,fetch:()=>new Response()}); const port=probe.port!; probe.stop(true);
  // Explicit environment and --no-env-file prevent loading repository signing secrets.
  const child = Bun.spawn([process.execPath,'--no-env-file','run','src/server.ts'],{
    cwd:join(import.meta.dir,'..'), env:{PATH:process.env.PATH!,HOME:root,PORT:String(port),WORD5_DB_PATH:join(root,'test.sqlite'),
      WORD5_RELAYS:'',GAMESTR_RELAYS:'',WORD5_READER_PUBLIC_BASE:'https://reader.example.test/'},stdout:'ignore',stderr:'pipe',
  });
  const base='http://127.0.0.1:'+port;
  try {
    let health:any;
    for(let i=0;i<100;i++) {
      try { const response=await fetch(base+'/api/health'); if(response.ok){health=await response.json();break;} } catch {}
      await Bun.sleep(50);
    }
    expect(health?.publicReader).toEqual({build:'20261118-1',path:READER_PATH});
    expect(health?.publicData.enabled).toBe(false);
    for(const endpoint of ['', '/players','/games','/results']) {
      const response=await fetch(base+READER_PATH+endpoint); expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(base+READER_PATH+'/results',{method:'POST'})).status).toBe(405);
    expect((await fetch(base+'/api/day')).status).toBe(200);
    expect((await fetch(base+'/api/top-streaks?limit=1')).status).toBe(200);
    expect((await fetch(base+'/api/leaderboard?limit=1')).status).toBe(200);
    expect((await fetch(base+'/api/native-backup/read',{method:'POST'})).status).toBe(503);
    const key=generateSecretKey();
    const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u','https://reader.example.test'+READER_PATH+'/results'],['method','GET']],content:''},key);
    expect((await fetch(base+READER_PATH+'/results',{headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')}})).status).toBe(401);
  } finally { child.kill(); await child.exited; }
},10000);
