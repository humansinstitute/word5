import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [normalizedPath, rawPath, outputPath] = process.argv.slice(2);
if (!normalizedPath || !rawPath || !outputPath) {
  throw new Error("usage: bun scripts/build-social-history-seed.ts <normalized-events.json> <raw-events.ndjson> <output.ndjson.gz>");
}

const accepted = JSON.parse(readFileSync(normalizedPath, "utf8")) as Array<{ eventId: string }>;
const acceptedIds = new Set(accepted.map((row) => row.eventId));
const raw = readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const selected = raw.filter((row) => acceptedIds.has(row.event?.id))
  .map((row) => ({ event: row.event, relays: [...new Set(row.relays || [])].sort() }))
  .sort((a, b) => a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id));
if (selected.length !== acceptedIds.size) throw new Error(`expected ${acceptedIds.size} signed events, found ${selected.length}`);
const ndjson = `${selected.map((row) => JSON.stringify(row)).join("\n")}\n`;
writeFileSync(outputPath, gzipSync(ndjson, { level: 9 }));
console.log(`wrote ${selected.length} signed events (${ndjson.length} bytes raw)`);
