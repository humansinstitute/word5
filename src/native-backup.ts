import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { finalizeEvent, getEventHash, verifyEvent, type Event } from "nostr-tools";

export const BACKUP_TAGS = [["d", "word5:backup:v1"], ["schema", "word5.encrypted-backup.v1"]];
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class BackupError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
/** Private storage only: never pass these records to relay/public-score code. */
export class NativeBackup {
  constructor(readonly db: Database, readonly key: Uint8Array, readonly history: (pubkey: string) => unknown) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_backups(pubkey TEXT PRIMARY KEY, event_id TEXT NOT NULL, event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_backup_auth(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
  }
  handle(operation: "read" | "write", body: any, auth: Event, url: string, now = Date.now()) {
    const seconds = Math.floor(now / 1000);
    const fail = (message: string, status = 400): never => { throw new BackupError(message, status); };
    if (!auth || !verifyEvent(auth) || auth.id !== getEventHash(auth) || auth.kind !== 27235 || auth.content !== "" ||
      Math.abs(auth.created_at - seconds) > 60 || (auth.tags?.length !== 4 || auth.tags[3]?.length !== 2 || auth.tags[3]?.[0] !== "nonce" || !/^[0-9a-f-]{36}$/.test(auth.tags[3]?.[1] || "") || JSON.stringify(auth.tags.slice(0,3)) !== JSON.stringify([["u", url], ["method", "POST"], ["payload", digest(JSON.stringify(body))]]))) fail("Invalid backup authorization", 401);
    const keys = Object.keys(body || {}).sort().join(",");
    if ((operation === "read" && keys !== "") || (operation === "write" && keys !== "event,previous")) fail("Invalid backup request");
    if (operation === "write") {
      const e = body.event;
      if (!e || !verifyEvent(e) || e.id !== getEventHash(e) || e.pubkey !== auth.pubkey || e.kind !== 30078 ||
        Math.abs(e.created_at - seconds) > 300 || JSON.stringify(e.tags) !== JSON.stringify(BACKUP_TAGS) ||
        typeof e.content !== "string" || e.content.length < 100 || e.content.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.content) ||
        !(body.previous === null || (typeof body.previous === "string" && /^[0-9a-f]{64}$/.test(body.previous)))) fail("Invalid encrypted backup");
    }
    const result = this.db.transaction(() => {
      this.db.query("DELETE FROM native_backup_auth WHERE expires < ?").run(seconds);
      if (this.db.query("SELECT 1 FROM native_backup_auth WHERE id=?").get(auth.id)) fail("Authorization already used", 409);
      this.db.query("INSERT INTO native_backup_auth VALUES(?,?)").run(auth.id, seconds + 120);
      const row = this.db.query("SELECT event_id,event_json FROM native_backups WHERE pubkey=?").get(auth.pubkey) as {event_id: string;event_json: string} | null;
      if (operation === "write") {
        if ((row?.event_id ?? null) !== body.previous) return { conflict: true, event: row ? JSON.parse(row.event_json) : null };
        this.db.query("INSERT INTO native_backups VALUES(?,?,?) ON CONFLICT(pubkey) DO UPDATE SET event_id=excluded.event_id,event_json=excluded.event_json").run(auth.pubkey, body.event.id, JSON.stringify(body.event));
        return { event: body.event };
      }
      return { event: row ? JSON.parse(row.event_json) : null, history: this.history(auth.pubkey) };
    })();
    // Signed, request-bound envelope prevents substituted emptiness, identity and baseline responses.
    return finalizeEvent({kind: 27235, created_at: seconds, tags: [["request", auth.id], ["p", auth.pubkey], ["schema", "word5.backup-response.v1"]], content: JSON.stringify(result)}, this.key);
  }
}
export async function backupRequest(req: Request, backup: NativeBackup, publicBase: string) {
  const reader = req.body?.getReader();
  if (!reader) throw new BackupError("Missing backup request");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {value, done} = await reader.read(); if (done) break; size += value.length; if (size > 110000) { await reader.cancel(); throw new BackupError("Backup request too large", 413); } chunks.push(value); }
  let data: any;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BackupError("Invalid backup JSON"); }
  if (!data || Object.keys(data).sort().join(",") !== "auth,body") throw new BackupError("Invalid backup envelope");
  const op = new URL(req.url).pathname.endsWith("/write") ? "write" : "read";
  return backup.handle(op, data.body, data.auth, `${publicBase}api/native-backup/${op}`);
}
