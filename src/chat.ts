import { randomBytes } from 'node:crypto';
import { getEventHash, validateEvent, verifyEvent, type Event } from 'nostr-tools';
import { getCurrentPeriodId, getDateForPeriod, PERIOD_MS, type Word5Service } from './word5';

export const CHAT_SCHEMA = 'word5.chat.v1';
export class DailyChat {
  constructor(readonly service: Word5Service) {
    service.db.exec(`CREATE TABLE IF NOT EXISTS chat_rooms (period INTEGER PRIMARY KEY, key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, period INTEGER NOT NULL, pubkey TEXT NOT NULL, received INTEGER NOT NULL, event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_messages_period ON chat_messages(period,received);
      CREATE TABLE IF NOT EXISTS chat_requests (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, received INTEGER NOT NULL);`);
    this.prune();
  }
  prune(now = Date.now()) {
    const db = this.service.db;
    db.transaction(() => {
      db.query('DELETE FROM chat_messages WHERE (period+3)*?1 <= ?2').run(PERIOD_MS, now);
      db.query('DELETE FROM chat_rooms WHERE (period+3)*?1 <= ?2').run(PERIOD_MS, now);
      db.query('DELETE FROM chat_requests WHERE received <= ?1').run(now - 120_000);
    })();
  }
  request(event: Event, action: string, now = Date.now()) {
    this.prune(now);
    // Verify wire data afresh; nostr-tools caches verification on event objects.
    if (event) event = JSON.parse(JSON.stringify(event));
    if (!event || JSON.stringify(event).length > 7000 || !validateEvent(event) ||
        getEventHash(event) !== event.id || !verifyEvent(event) || event.kind !== 30078 ||
        event.tags.length !== 1 || event.tags[0]?.join(':') !== `schema:${CHAT_SCHEMA}` ||
        !Number.isSafeInteger(event.created_at) || Math.abs(event.created_at * 1000 - now) > 60_000) {
      throw new Error('Invalid signed chat request');
    }
    let body;
    try { body = JSON.parse(event.content); } catch { throw new Error('Invalid chat payload'); }
    if (!body || body.action !== action || !['rooms','read','send'].includes(action) ||
        typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce)) throw new Error('Invalid chat payload');
    const db = this.service.db;
    const count = db.query('SELECT COUNT(*) AS n FROM chat_requests WHERE pubkey=?1 AND received>?2').get(event.pubkey, now - 60_000) as {n:number};
    if (count.n >= 40) throw new Error('Chat rate limit; try again in a minute');
    if (db.query('SELECT id FROM chat_requests WHERE id=?1').get(event.id)) throw new Error('Replayed chat request');
    db.query('INSERT INTO chat_requests VALUES (?1,?2,?3)').run(event.id, event.pubkey, now);
    const current = getCurrentPeriodId(now);
    const eligible = (period: number) => {
      if (!Number.isSafeInteger(period) || period > current || now >= (period+3)*PERIOD_MS) throw new Error('Room expired or unavailable');
      if (!db.query('SELECT 1 FROM game_submissions WHERE pubkey=?1 AND period_id=?2 AND verified_completion=1').get(event.pubkey, period)) throw new Error('Finish this puzzle to unlock chat');
    };
    if (action === 'rooms') {
      const rows = db.query('SELECT period_id AS period FROM game_submissions WHERE pubkey=?1 AND verified_completion=1 AND period_id<=?2 AND (period_id+3)*?3>?4 ORDER BY period_id DESC').all(event.pubkey, current, PERIOD_MS, now) as {period:number}[];
      const rooms = db.transaction(() => rows.map(({period}) => {
        db.query('INSERT OR IGNORE INTO chat_rooms VALUES (?1,?2)').run(period, randomBytes(32).toString('base64'));
        const room = db.query('SELECT key FROM chat_rooms WHERE period=?1').get(period) as {key:string};
        return {period, date:getDateForPeriod(period), expiresAt:(period+3)*PERIOD_MS, key:room.key};
      }))();
      return {ok:true, rooms, now};
    }
    eligible(body.period);
    if (action === 'read') {
      const rows = db.query('SELECT event FROM chat_messages WHERE period=?1 ORDER BY received DESC,rowid DESC LIMIT 200').all(body.period) as {event:string}[];
      return {ok:true, messages:rows.reverse().map(row=>JSON.parse(row.event)), now};
    }
    if (Object.keys(body).sort().join(',') !== 'action,ciphertext,iv,nonce,period' ||
        typeof body.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(body.iv) ||
        typeof body.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.ciphertext) ||
        body.ciphertext.length > 4096 || body.ciphertext.length < 24 || body.ciphertext.length % 4 !== 0) throw new Error('Invalid encrypted message');
    const recent = db.query('SELECT COUNT(*) AS n, MAX(received) AS last FROM chat_messages WHERE pubkey=?1 AND received>?2').get(event.pubkey, now-60_000) as {n:number,last:number|null};
    if (recent.n >= 10 || (recent.last !== null && now-recent.last < 2000)) throw new Error('Sending too quickly; wait a moment');
    db.transaction(() => {
      db.query('INSERT INTO chat_messages VALUES (?1,?2,?3,?4,?5)').run(event.id,body.period,event.pubkey,now,JSON.stringify(event));
      db.query('DELETE FROM chat_messages WHERE period=?1 AND id NOT IN (SELECT id FROM chat_messages WHERE period=?1 ORDER BY received DESC,rowid DESC LIMIT 200)').run(body.period);
    })();
    return {ok:true, id:event.id, now};
  }
}
