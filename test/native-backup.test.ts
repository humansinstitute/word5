import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip44 } from "nostr-tools";
import { NativeBackup, BACKUP_TAGS, digest, BackupError, backupRequest } from "../src/native-backup";
const now = 1794387900000;
const url = "https://otherstuff.ai/word5/api/native-backup/";
function fixture() {
 const db = new Database(":memory:"); const key = generateSecretKey(); const player = generateSecretKey();
 const owner = getPublicKey(player); let tick = 0;
 const service = new NativeBackup(db, key, pubkey => ({pubkey, stats: { played: 12 }}));
 const auth = (op: string, body: any, sk = player) => finalizeEvent({kind:27235,created_at:now/1000 + tick++, tags:[["u",url+op],["method","POST"],["payload",digest(JSON.stringify(body))],["nonce",crypto.randomUUID()]],content:""},sk);
 const store = (text: string) => finalizeEvent({kind:30078,created_at:now/1000,tags:BACKUP_TAGS,content:nip44.v2.encrypt(text,nip44.v2.utils.getConversationKey(player,owner))},player);
 return {db,key,player,owner,service,auth,store};
}
describe("private native full-state backup", () => {
 test("new install fetches exact encrypted full state and no private history enters a public table", () => {
  const f = fixture(); const text = JSON.stringify({stats:{played:100,streak:42},history:[{period:20768,guesses:["CRANE"]}],unfinished:["SLATE"]});
  const event = f.store(text); const body = {previous:null,event};
  const signed = f.service.handle("write",body,f.auth("write",body),url+"write",now);
  expect(verifyEvent(signed)).toBe(true);
  const fetched = f.service.handle("read",{},f.auth("read",{}),url+"read",now);
  expect(verifyEvent(fetched)).toBe(true);
  const restored = JSON.parse(fetched.content).event;
  expect(nip44.v2.decrypt(restored.content,nip44.v2.utils.getConversationKey(f.player,f.owner))).toBe(text);
  const row = f.db.query("SELECT event_json FROM native_backups").get() as any;
  expect(row.event_json).not.toContain("CRANE"); expect(row.event_json).not.toContain("streak");
  expect(f.db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(2);
 });
 test("atomic compare-and-swap rejects stale/blank overwrite and binds empty responses", () => {
  const f=fixture(); const first=f.store("a".repeat(200)); const body={previous:null,event:first};
  f.service.handle("write",body,f.auth("write",body),url+"write",now);
  const stale={previous:null,event:f.store("b".repeat(200))}; const request=f.auth("write",stale);
  const result=f.service.handle("write",stale,request,url+"write",now);
  expect(JSON.parse(result.content).conflict).toBe(true); expect(JSON.parse(result.content).event.id).toBe(first.id);
  expect(result.tags).toContainEqual(["request",request.id]);
 });
 test("tampering, wrong account, stale auth, replay, method/path/body substitutions fail", () => {
  const f=fixture(); const body={previous:null,event:f.store("a".repeat(200))}; const auth=f.auth("write",body);
  expect(()=>f.service.handle("write",{...body,previous:"0".repeat(64)},auth,url+"write",now)).toThrow();
  expect(()=>f.service.handle("write",body,auth,url+"read",now)).toThrow();
  expect(()=>f.service.handle("write",body,auth,url+"write",now+120000)).toThrow();
  expect(()=>f.service.handle("write",body,f.auth("write",body,generateSecretKey()),url+"write",now)).toThrow();
  const bad={previous:null,event:{...body.event,content:"z".repeat(120)}};
  expect(()=>f.service.handle("write",bad,f.auth("write",bad),url+"write",now)).toThrow();
  f.service.handle("write",body,auth,url+"write",now);
  expect(()=>f.service.handle("write",body,auth,url+"write",now)).toThrow("already used");
 });
 test("accounts cannot fetch each other's backup; read is signed and fresh", () => {
  const f=fixture(); const body={previous:null,event:f.store("a".repeat(200))}; f.service.handle("write",body,f.auth("write",body),url+"write",now);
  const other=generateSecretKey(); const r=f.service.handle("read",{},f.auth("read",{},other),url+"read",now);
  expect(JSON.parse(r.content).event).toBeNull(); expect(r.tags).toContainEqual(["p",getPublicKey(other)]);
 });
 test("request stream is bounded before parsing", async () => {
  const f=fixture(); const req=new Request(url+"write",{method:"POST",body:"x".repeat(110001)});
  await expect(backupRequest(req,f.service,url)).rejects.toThrow("too large");
 });
});

test("HTTP streaming endpoint signs canonical external URL responses behind a stripped proxy path", async () => {
 const f=fixture();
 const server=Bun.serve({port:0,fetch:async req=>{
   try { return Response.json({event:await backupRequest(req,f.service,url.replace("api/native-backup/",""))}); }
   catch(error) { return Response.json({error:"Rejected"},{status:error instanceof BackupError ? error.status : 400}); }
 }});
 try {
  const body={};
  const auth=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:"",tags:[["u",url+"read"],["method","POST"],["payload",digest(JSON.stringify(body))],["nonce",crypto.randomUUID()]]},f.player);
  const response=await fetch(`http://localhost:${server.port}/api/native-backup/read`,{method:"POST",body:JSON.stringify({body,auth})});
  expect(response.status).toBe(200); const result:any=await response.json();
  expect(verifyEvent(result.event)).toBe(true); expect(result.event.pubkey).toBe(getPublicKey(f.key));
  expect(JSON.parse(result.event.content).event).toBeNull();
  const replay=await fetch(`http://localhost:${server.port}/api/native-backup/read`,{method:"POST",body:JSON.stringify({body,auth})});
  expect(replay.status).toBe(409);
 } finally { server.stop(true); f.db.close(); }
});
