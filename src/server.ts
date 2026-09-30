import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Word5Service } from "./word5";
import { VisitTracker } from "./visits";
import { VisitAnnouncer } from "./visit-announcements";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PORT = Number(process.env.PORT || 41005);
const RELAYS = String(process.env.WORD5_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social")
  .split(",")
  .map((relay) => relay.trim())
  .filter(Boolean);
const GAMESTR_RELAYS = String(process.env.GAMESTR_RELAYS || "wss://main.relay.gamestr.io")
  .split(",")
  .map((relay) => relay.trim())
  .filter(Boolean);

const service = new Word5Service({
  rootDir: ROOT,
  dbPath: process.env.WORD5_DB_PATH || join(ROOT, "data", "word5.sqlite"),
  word5Nsec: process.env.WORD5_NSEC,
  relays: RELAYS,
  gamestrRelays: GAMESTR_RELAYS,
});
const visits = new VisitTracker(service.db, process.env.WORD5_DB_PATH || join(ROOT, "data", "word5.sqlite"));
const visitAnnouncer = new VisitAnnouncer(service.db, service.secretKey, RELAYS);
async function announceCompletedGame() {
  try {
    const result = await visitAnnouncer.announceYesterday();
    if (result === "published") console.log("Published yesterday's Word5 player count");
  } catch (error) {
    console.error("Word5 visit announcement failed:", error instanceof Error ? error.message : String(error));
  }
}
async function announceLiveMilestone() {
  try {
    const result = await visitAnnouncer.announceCurrentMilestone();
    if (result === "published") console.log("Published a Word5 daily player milestone");
  } catch (error) {
    console.error("Word5 milestone announcement failed:", error instanceof Error ? error.message : String(error));
  }
}
void announceCompletedGame();
void announceLiveMilestone();
setInterval(announceCompletedGame, 5 * 60 * 1000);
setInterval(announceLiveMilestone, 5 * 60 * 1000);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

async function readJson(req: Request) {
  try {
    return await req.json();
  } catch {
    throw new Error("Request body must be JSON");
  }
}

function staticResponse(pathname: string): Response {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  if (!/^\/(?:index\.html|social\.html|manifest\.webmanifest|assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*|js\/[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(safePath)) {
    return new Response("Not found", { status: 404 });
  }
  const filePath = normalize(join(ROOT, safePath));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  const ext = extname(filePath);
  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, app: "word5-server", time: new Date().toISOString() });
      }
      if (url.pathname === "/api/day") {
        return json(service.getDay());
      }
      if (url.pathname === "/api/visit" && req.method === "POST") {
        const body = await readJson(req);
        const result = visits.record(body?.sessionPubkey);
        void announceLiveMilestone();
        return json(result);
      }
      if ((url.pathname === "/api/visits/last-completed-game" || url.pathname === "/api/visits/yesterday") && req.method === "GET") {
        return json(visits.yesterday());
      }
      if (url.pathname === "/api/visits/current-game" && req.method === "GET") {
        return json({ ...visits.recentGames(new Date(), 1)[0], timezone: "UTC" });
      }
      if (url.pathname === "/api/visits/recent-games" && req.method === "GET") {
        return json({ games: visits.recentGames(), timezone: "UTC" });
      }
      if (url.pathname === "/api/completion" && req.method === "POST") {
        return json(service.complete((await readJson(req))?.event));
      }
      if (url.pathname === "/api/publication" && req.method === "POST") {
        return json(await service.markPublished((await readJson(req))?.event));
      }
      if (url.pathname === "/api/scores" && req.method === "GET") {
        const days = Number(url.searchParams.get("days") || 7);
        if (days !== 1 && days !== 7 && days !== 21) throw new Error("days must be 1, 7 or 21");
        return json(service.scores(days, url.searchParams.get("published") === "true", Number(url.searchParams.get("limit") || 50)));
      }
      if (url.pathname === "/api/leaderboard") {
        return json(service.leaderboard(Number(url.searchParams.get("limit") || 50)));
      }
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "Not found" }, { status: 404 });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      return staticResponse(url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, error: message }, { status: 400 });
    }
  },
});

console.log(`Word5 server listening on ${server.url}`);
