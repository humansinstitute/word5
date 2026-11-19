import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
function fixture() {
  let now = 100000,
    id = 0;
  const timers = new Map<number, { fn: Function; at: number }>(),
    events: any = {};
  const window: any = {
    addEventListener: (name: string, fn: Function) => (events[name] = fn),
  };
  const navigator = { onLine: true };
  runInNewContext(
    readFileSync(new URL("../js/profile-reader.js", import.meta.url), "utf8"),
    {
      window,
      navigator,
      URL,
      Map,
      Set,
      Promise,
      Error,
      Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
      Date: { now: () => now },
      setTimeout: (fn: Function, delay: number) => {
        timers.set(++id, { fn, at: now + delay });
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    api: window.Word5Profiles,
    timers,
    navigator,
    events,
    flush,
    async advance(ms: number) {
      now += ms;
      for (const [key, t] of [...timers])
        if (t.at <= now) {
          timers.delete(key);
          t.fn();
        }
      await flush();
    },
    now: () => now,
  };
}
const pk = "a".repeat(64);
test("failure deduplicates, retries with exponential cooldown; missing has separate TTL; successful stale values survive failure", async () => {
  const f = fixture();
  let calls = 0;
  let mode = "fail";
  const states: any[] = [];
  f.api.fetch = async () => {
    calls++;
    if (mode === "fail") throw Error("network");
    return mode === "missing"
      ? null
      : { name: "Pete", picture: "", about: "bio" };
  };
  const stop = f.api.watch(pk, (state: any) => states.push(state));
  await f.flush();
  expect(calls).toBe(1);
  expect(states.at(-1).status).toBe("error");
  expect(states.at(-1).due - f.now()).toBe(5000);
  await Promise.all(
    Array.from({ length: 20 }, () => f.api.load(pk, { force: true })),
  );
  expect(calls).toBe(1);
  await f.advance(5000);
  expect(calls).toBe(2);
  expect(states.at(-1).due - f.now()).toBe(10000);
  mode = "ready";
  await f.advance(10000);
  expect(calls).toBe(3);
  expect(states.at(-1).profile.name).toBe("Pete");
  mode = "fail";
  await f.advance(900000);
  expect(states.at(-1).status).toBe("error");
  expect(states.at(-1).profile.name).toBe("Pete");
  mode = "missing";
  await f.advance(5000);
  expect(states.at(-1).status).toBe("missing");
  expect(states.at(-1).profile.name).toBe("Pete");
  expect(states.at(-1).due - f.now()).toBe(300000);
  stop();
  expect(f.timers.size).toBe(0);
  await f.advance(999999);
  expect(calls).toBe(5);
});
test("concurrency limited across keys, unsubscribe cancels retry timers and offline causes no transport", async () => {
  const f = fixture();
  let calls = 0;
  const resolves: Function[] = [];
  f.api.fetch = () => {
    calls++;
    return new Promise((resolve) => resolves.push(resolve));
  };
  const stops = Array.from({ length: 10 }, (_, i) =>
    f.api.watch(i.toString(16).padStart(64, "0"), () => {}),
  );
  expect(calls).toBe(3);
  resolves.splice(0).forEach((resolve) => resolve(null));
  await f.flush();
  expect(calls).toBe(6);
  for (const stop of stops) stop();
  while (resolves.length) {
    resolves.splice(0).forEach((resolve) => resolve(null));
    await f.flush();
  }
  expect(f.timers.size).toBe(0);
  f.navigator.onLine = false;
  let state: any;
  const stop = f.api.watch(pk, (s: any) => (state = s));
  await f.flush();
  expect(state.status).toBe("offline");
  expect(calls).toBe(6);
  stop();
  expect(f.timers.size).toBe(0);
});
test("published profile cannot be overwritten by older pending query; unsafe URLs rejected", async () => {
  const f = fixture();
  let resolve: Function = () => {};
  f.api.fetch = () => new Promise((r) => (resolve = r));
  const pending = f.api.load(pk);
  f.api.set(pk, { name: "New" });
  resolve({ name: "Old" });
  expect((await pending).name).toBe("New");
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml,unsafe",
    "https://user:pass@example.com/a",
    "not a url",
  ])
    expect(f.api.safeUrl(url)).toBe("");
  expect(f.api.safeUrl("https://example.com/a")).toBe("https://example.com/a");
});
