import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Word5Service } from "./word5";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PORT = Number(process.env.PORT || 41005);
const RELAYS = String(process.env.WORD5_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social")
  .split(",")
  .map((relay) => relay.trim())
  .filter(Boolean);

const service = new Word5Service({
  rootDir: ROOT,
  dbPath: process.env.WORD5_DB_PATH || join(ROOT, "data", "word5.sqlite"),
  word5Nsec: process.env.WORD5_NSEC,
  relays: RELAYS,
});

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
      if (url.pathname === "/api/submit" && req.method === "POST") {
        return json(await service.submit(await readJson(req)));
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
