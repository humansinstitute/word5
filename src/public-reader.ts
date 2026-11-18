import { createHash } from 'node:crypto';
import { getEventHash, nip19, verifyEvent } from 'nostr-tools';
import type { Database } from 'bun:sqlite';
import { acceptedOutcomes, CONTRACT, playerReport } from './reconciliation';
import { getDateForPeriod, getGameNumberForPeriod } from './word5';

export const READER_BUILD = '20261118-1';
export const READER_PATH = '/api/public-reader/v1';
export const READER_NPUB = 'npub1ueczxknr46czqs6wx7t8mnug2pwuhragqvchhunrxvh53ufmw0xq3r7j32';
const READER_PUBKEY = nip19.decode(READER_NPUB).data as string;
const FIELDS = {
  players: ['pubkey', 'npub', 'played', 'won', 'streak', 'maxStreak'],
  games: ['periodId', 'puzzle', 'date', 'games', 'wins', 'points'],
  results: ['pubkey', 'npub', 'periodId', 'puzzle', 'date', 'result', 'points', 'sourceEventId', 'source'],
};
class ReaderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reply = (data: unknown, status = 200) => Response.json(data, { status,
  headers: { 'cache-control': 'no-store', vary: 'Authorization', ...(status === 405 ? { allow: 'GET' } : {}) } });

/** One trusted externally visible base per instance. Never trust Host/Forwarded headers. */
export class PublicReader {
  readonly base: string;
  constructor(private readonly db: Database, base = 'https://otherstuff.ai/word5/',
    private readonly allowedPubkeys: readonly string[] = [READER_PUBKEY]) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/') || url.href !== base) throw new Error('Invalid WORD5_READER_PUBLIC_BASE: use a canonical HTTPS base ending in /');
    this.base = base;
  }

  private authorize(req: Request, now: number) {
    try {
      const header = req.headers.get('authorization') || '';
      if (header.length > 8000 || !/^Nostr [A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error();
      const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(header.slice(6), 'base64')));
      const url = new URL(req.url);
      const queryIndex = req.url.indexOf('?');
      const query = queryIndex < 0 ? '' : req.url.slice(queryIndex);
      const expected = this.base + url.pathname.slice(1) + query;
      if (url.hash) throw new Error();
      if (event.kind !== 27235 || event.content !== '' || !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
        Math.abs(event.created_at - Math.floor(now / 1000)) > 60 || !Array.isArray(event.tags) ||
        !this.allowedPubkeys.includes(event.pubkey) || !verifyEvent(event) || getEventHash(event) !== event.id) throw new Error();
      // Exactly one URL and method, plus optional broker correlation metadata.
      // This metadata grants no authority; the signer allowlist remains decisive.
      const tags = event.tags;
      if (tags.length < 2 || tags.length > 3 || tags.some((t: unknown) => !Array.isArray(t) ||
        (t[0] === 'wm-session-capability'
          ? t.length !== 4 || t.slice(1).some(v => typeof v !== 'string' || !v.length || v.length > 1024)
          : t.length !== 2 || !['u', 'method'].includes(t[0]) || typeof t[1] !== 'string')) ||
        tags.filter((t: string[]) => t[0] === 'u' && t[1] === expected).length !== 1 ||
        tags.filter((t: string[]) => t[0] === 'method' && t[1] === req.method).length !== 1) throw new Error();
    } catch { throw new ReaderError(401, 'NIP-98 authorization rejected'); }
  }

  handle(req: Request, now = Date.now()): Response {
    try {
      if (req.method !== 'GET') throw new ReaderError(405, 'Read-only API: GET required');
      if (req.body || req.headers.has('transfer-encoding') || (req.headers.get('content-length') ?? '0') !== '0')
        throw new ReaderError(400, 'Request body not allowed');
      this.authorize(req, now);
      const url = new URL(req.url);
      const dataset = url.pathname.slice(READER_PATH.length + 1);
      if (url.pathname === READER_PATH) {
        if (url.search) throw new ReaderError(400, 'Discovery takes no query parameters');
        return reply({ schema: 'word5.public-reader.v1', build: READER_BUILD, contract: CONTRACT,
          base: this.base, authentication: { scheme: 'Nostr', kind: 27235, maxClockSkewSeconds: 60,
            method: 'GET', url: 'Exact external URL including query; ignore proxy headers', body: false },
          endpoints: Object.entries(FIELDS).map(([name, fields]) => ({ path: READER_PATH + '/' + name, fields })),
          query: { limit: '1-200; default 50', cursor: 'Opaque nextCursor from same dataset and filters',
            pubkey: 'Optional lowercase hex public key (players/results)', periodId: 'Optional UTC period integer (games/results)' },
          pagination: 'Stable sort; changed data returns 409, restart without cursor. Not a persisted snapshot.',
          visibility: 'public-only', exclusions: ['chats', 'encrypted backups', 'private completions', 'guesses', 'answers', 'raw events', 'operator records'] });
      }
      if (!(dataset in FIELDS) || !Object.hasOwn(FIELDS, dataset)) throw new ReaderError(404, 'Unknown reader dataset');
      const name = dataset as keyof typeof FIELDS;
      const allowed = ['limit', 'cursor', ...(name !== 'games' ? ['pubkey'] : []), ...(name !== 'players' ? ['periodId'] : [])];
      for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new ReaderError(400, 'Unknown or duplicate query parameter');
      const integer = (key: string, fallback?: number) => {
        const raw = url.searchParams.get(key);
        if (raw === null) return fallback;
        if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ReaderError(400, 'Invalid ' + key);
        return Number(raw);
      };
      const limit = integer('limit', 50)!;
      if (limit < 1 || limit > 200) throw new ReaderError(400, 'limit must be 1-200');
      const pubkey = url.searchParams.get('pubkey');
      if (pubkey !== null && !/^[0-9a-f]{64}$/.test(pubkey)) throw new ReaderError(400, 'Invalid pubkey');
      const periodId = integer('periodId');
      const projection = acceptedOutcomes(this.db, now, true);
      let rows: object[];
      if (name === 'players') {
        const authors = this.db.query(`SELECT DISTINCT pubkey FROM public_score_history WHERE created_at<=?
          UNION SELECT pubkey FROM lifetime_best_decisions WHERE revoked_at IS NULL AND effective_at<=?`)
          .all(Math.floor(now / 1000), Math.floor(now / 1000)) as { pubkey: string }[];
        const keys = [...new Set([...authors.map(r => r.pubkey), ...projection.outcomes.map(r => r.pubkey)])].sort();
        rows = keys.filter(key => !pubkey || key === pubkey).map(key => {
          const { stats } = playerReport(this.db, key, now, false, true, projection);
          return { pubkey: key, npub: nip19.npubEncode(key), played: stats.played, won: stats.won, streak: stats.streak, maxStreak: stats.maxStreak };
        });
      } else {
        const selected = projection.outcomes.filter(r => (!pubkey || r.pubkey === pubkey) && (periodId === undefined || r.periodId === periodId));
        const game = (p: number) => ({ periodId: p, puzzle: getGameNumberForPeriod(p), date: getDateForPeriod(p) });
        if (name === 'results') rows = selected.map(r => ({ pubkey: r.pubkey, npub: nip19.npubEncode(r.pubkey), ...game(r.periodId),
          result: r.result, points: r.points, sourceEventId: r.eventId, source: r.source }));
        else {
          const grouped = new Map<number, { periodId: number; puzzle: number; date: string; games: number; wins: number; points: number }>();
          for (const row of selected) {
            const item = grouped.get(row.periodId) || { ...game(row.periodId), games: 0, wins: 0, points: 0 };
            item.games++; item.wins += Number(row.result !== 'X'); item.points += row.points; grouped.set(row.periodId, item);
          }
          rows = [...grouped.values()];
        }
      }
      // Hash only projected public data and filters. Private writes cannot invalidate pagination.
      const fingerprint = hash({ name, pubkey, periodId, rows });
      let offset = 0;
      const cursor = url.searchParams.get('cursor');
      if (cursor !== null) {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new ReaderError(400, 'Invalid cursor');
        let decoded: any;
        try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new ReaderError(400, 'Invalid cursor'); }
        if (!decoded || !Number.isSafeInteger(decoded.offset) || decoded.offset < 1 || !/^[a-f0-9]{64}$/.test(decoded.fingerprint))
          throw new ReaderError(400, 'Invalid cursor');
        if (decoded.fingerprint !== fingerprint) throw new ReaderError(409, 'Public dataset changed or cursor belongs to different filters; restart pagination');
        if (decoded.offset >= rows.length) throw new ReaderError(400, 'Invalid cursor offset');
        offset = decoded.offset;
      }
      const end = offset + limit;
      return reply({ schema: 'word5.public-reader.v1', contract: CONTRACT, visibility: 'public-only', dataset: name,
        fields: FIELDS[name], rows: rows.slice(offset, end), total: rows.length,
        nextCursor: end < rows.length ? Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString('base64url') : null });
    } catch (error) {
      if (error instanceof ReaderError) return reply({ error: error.message }, error.status);
      console.error('Word5 public reader failed');
      return reply({ error: 'Public reader unavailable' }, 500);
    }
  }
}
