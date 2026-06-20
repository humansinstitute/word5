const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "js", "nostr-ui.js"),
  "utf8"
);

const context = {
  console,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Map,
  Object,
  RegExp,
  Math,
  JSON,
  URL,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  crypto: { subtle: {} },
  document: {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {},
    createElement: () => ({
      style: {},
      addEventListener() {},
      appendChild() {},
      querySelector: () => null,
    }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  localStorage: {
    getItem: () => null,
    setItem() {},
  },
  navigator: { clipboard: { writeText() {} } },
  window: { __WORD5_TEST__: true },
};
context.globalThis = context;

vm.createContext(context);
vm.runInContext(source, context, { filename: "js/nostr-ui.js" });

const { buildWord5Stats, dedupeWord5Entries, isNextWord5Puzzle, applyCorrectionBaseline } =
  context.window.NostrUI.__test;

const now = Math.floor(Date.now() / 1000);
const entry = (puzzle, result, offset = puzzle) => ({
  id: `${puzzle}-${result}`,
  kind: 1,
  created_at: now - 1000 + offset,
  periodId: puzzle,
  puzzle,
  result,
  won: result !== "X",
  streak: 0,
  maxStreak: 0,
  played: 0,
  taggedWon: 0,
});

assert.equal(isNextWord5Puzzle(1423, 1424), true);
assert.equal(isNextWord5Puzzle(1423, 1425), false);

{
  const report = buildWord5Stats([entry(1423, "4"), entry(1424, "3")]);
  assert.equal(report.stats.streak, 2);
  assert.equal(report.stats.maxStreak, 2);
  assert.equal(report.meta.trailingWinRun, 2);
  assert.equal(report.meta.lastPuzzle, 1424);
}

{
  const report = buildWord5Stats([
    { ...entry(1423, "4"), streak: 8, maxStreak: 8 },
    { ...entry(1425, "3"), streak: 9, maxStreak: 9 },
  ]);
  assert.equal(report.stats.streak, 1);
  assert.equal(report.stats.maxStreak, 1);
  assert.equal(report.meta.trailingWinRun, 1);
  assert.equal(report.meta.lastPuzzle, 1425);
}

{
  const report = buildWord5Stats([
    entry(1423, "4"),
    entry(1424, "X"),
    entry(1425, "3"),
  ]);
  assert.equal(report.stats.streak, 1);
  assert.equal(report.stats.maxStreak, 1);
  assert.equal(report.stats.won, 2);
}

{
  const stats = applyCorrectionBaseline(
    {
      created_at: now - 985,
      stats: { played: 10, won: 8, streak: 4, maxStreak: 6 },
    },
    [
      entry(1423, "4", 10),
      entry(1425, "3", 20),
    ]
  );
  assert.equal(stats.played, 11);
  assert.equal(stats.won, 9);
  assert.equal(stats.streak, 1);
  assert.equal(stats.maxStreak, 6);
}

{
  const deduped = dedupeWord5Entries([
    { ...entry(1423, "4", 1), kind: 5555 },
    { ...entry(1423, "3", 2), kind: 1 },
    entry(1424, "2", 3),
  ]);
  assert.deepEqual(
    deduped.map((item) => [item.puzzle, item.result]),
    [
      [1423, "3"],
      [1424, "2"],
    ]
  );
}

console.log("streak reconstruction tests passed");
