// node test/scenarios.test.js — user scenarios and edge cases for core.js, no network.
const assert = require("assert");
const BP = require("../core.js");

const mkBin = (bin, { swaps = 500, liq = 100000, vol = 1e6, mk = 500, mk1m = mk, mk30m = mk, pnl = 0, len = 5 } = {}) => ({
  bin: String(bin), swapCount: String(swaps), lengthE6: len, pnlAprBps: pnl,
  token0: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  token1: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  markoutByHorizon: { "1m": { aprBps: mk1m }, "5m": { aprBps: mk }, "30m": { aprBps: mk30m } },
});
const day = (bin, mk = 500, swaps = 10) => mkBin(bin, { swaps, mk });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const score = (bins, cur = 0, opts, dayBins) => BP.scoreBins(bins, dayBins || bins.map((b) => day(Number(b.bin))), cur, opts);
const usd = (p) => p.bins.reduce((s, b) => s + b.usd, 0);
const bookRows = (cur = 0) => score(range(-6, 6).map((i) => mkBin(i, { mk: 1200 - Math.abs(i) * 100 })), cur);

// small deterministic PRNG so the property tests are reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

let n = 0;
const failed = [];
const t = (name, fn) => {
  try { fn(); n++; console.log("ok", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n   ", e.message.split("\n")[0]); }
};

// --- what the user types ---
t("01 amount 0 gives an empty plan, not NaN", () => {
  const p = BP.plan(bookRows(), { amountUsd: 0, have: "token0" });
  assert.deepStrictEqual(p.bins, []); assert.strictEqual(p.aprBps, null);
});
t("02 negative or non-numeric amount gives an empty plan", () => {
  for (const a of [-5, NaN, undefined]) assert.strictEqual(BP.plan(bookRows(), { amountUsd: a, have: "token0" }).bins.length, 0);
});
t("03 asking for more bins than qualify returns only the ones that do", () => {
  const p = BP.plan(bookRows(), { amountUsd: 1000, have: "token0", count: 5 });
  assert.strictEqual(p.bins.length, 5); // bins 2..6 on the token0 side
  const q = BP.plan(score([mkBin(3), mkBin(4)]), { amountUsd: 1000, have: "token0", count: 5 });
  assert.strictEqual(q.bins.length, 2); assert.ok(Math.abs(usd(q) - 1000) < 1e-6);
});
t("04 holding both tokens may pick bins on both sides", () => {
  const p = BP.plan(bookRows(), { amountUsd: 1000, have: "both", count: 4 });
  const sides = new Set(p.bins.map((b) => b.side));
  assert.ok(sides.has("token0") && sides.has("token1"));
});
t("05 a tiny deposit barely dilutes: expected APR equals the score", () => {
  const p = BP.plan(bookRows(), { amountUsd: 1, have: "token0", count: 1 });
  assert.ok(Math.abs(p.aprBps - p.bins[0].score) / p.bins[0].score < 1e-4); // $1 into a $100k bin: 1/100001
});
t("06 a whale deposit is diluted and Max APR beats Top score", () => {
  // both bins must pass the liquidity filter (2% of the largest bin), or there is nothing to choose between
  const rows = score([mkBin(2, { mk: 1000, liq: 50000 }), mkBin(3, { mk: 900, liq: 2e6 })]);
  const a = BP.plan(rows, { amountUsd: 500000, have: "token0", count: 2, strategy: "score" });
  const b = BP.plan(rows, { amountUsd: 500000, have: "token0", count: 2, strategy: "max" });
  assert.ok(b.aprBps > a.aprBps, `${b.aprBps} vs ${a.aprBps}`);
  assert.ok(a.aprBps < 1000);
});
t("07 binShare is the part of the bin you would own", () => {
  const p = BP.plan(score([mkBin(3, { liq: 9000 })], 0, { minLiquidityUsd: 0 }), { amountUsd: 1000, have: "token0", count: 1 });
  assert.ok(Math.abs(p.bins[0].binShare - 0.1) < 1e-12);
});

// --- what the pool looks like ---
t("08 every bin losing over the window: nothing to recommend, even after a good day", () => {
  const rows = score(range(-3, 3).map((i) => mkBin(i, { mk: -100 }))); // 24h markout is +500 here
  assert.ok(rows.every((r) => !r.eligible && r.reasons.some((x) => /losing/.test(x))));
  assert.strictEqual(BP.plan(rows, { amountUsd: 1000, have: "both" }).bins.length, 0);
});
t("09 active bin at the top edge: nothing on the token0 side, token1 still works", () => {
  const rows = bookRows(6);
  assert.strictEqual(BP.plan(rows, { amountUsd: 1000, have: "token0" }).bins.length, 0);
  assert.ok(BP.plan(rows, { amountUsd: 1000, have: "token1" }).bins.length > 0);
});
t("10 non-uniform bin widths stack correctly", () => {
  const e = BP.binEdges([mkBin(-2, { len: 100 }), mkBin(-1, { len: 50 }), mkBin(0, { len: 50 }), mkBin(1, { len: 200 })]);
  assert.deepStrictEqual(e.get(1), [0.005, 0.025]);
  assert.deepStrictEqual(e.get(-2), [-0.015, -0.005]);
});
t("11 no 24h data at all is treated as an idle pool, ranked on the main window", () => {
  const rows = BP.scoreBins([mkBin(3, { mk: 700 })], [], 0);
  assert.ok(rows[0].eligible && rows[0].poolIdle24h); assert.strictEqual(rows[0].score, 700);
});
t("12 null trading PnL does not break the score", () => {
  const rows = score([mkBin(3, { mk: 600, pnl: null })], 0, {}, [day(3, 600)]);
  assert.strictEqual(rows[0].score, 600);
});
t("13 a bin silent for 24h in an active pool is stale even if its week was great", () => {
  const rows = BP.scoreBins([mkBin(3, { mk: 5000 }), mkBin(4)], [day(3, 0, 0), day(4)], 0);
  assert.ok(!rows[0].eligible); assert.strictEqual(rows[0].mkDay, null);
});
t("14 30d window needs 300 swaps, 24h window needs 15", () => {
  const b = [mkBin(3, { swaps: 200 })];
  assert.ok(!score(b, 0, { window: "30d" })[0].eligible);
  assert.ok(score(b, 0, { window: "7d" })[0].eligible);
  assert.ok(BP.scoreBins([mkBin(3, { swaps: 15 })], [mkBin(3, { swaps: 15 })], 0, { window: "24h" })[0].eligible);
});
t("15 30m horizon reads the 30m markout and can turn a bin negative", () => {
  const rows = BP.scoreBins([mkBin(3, { mk: 500, mk30m: -300 })], [mkBin(3, { swaps: 10, mk: 500, mk30m: -300 })], 0, { horizon: "30m" });
  assert.ok(!rows[0].eligible);
});
t("16 equal scores give the same plan every time (deterministic tie-break)", () => {
  const rows = score(range(-5, 5).map((i) => mkBin(i, { mk: 500 })));
  const a = BP.plan(rows, { amountUsd: 1000, have: "both", count: 3 }).bins.map((b) => b.bin);
  const b = BP.plan([...rows].reverse(), { amountUsd: 1000, have: "both", count: 3 }).bins.map((b) => b.bin);
  assert.deepStrictEqual(a, b);
});
t("17 skipNearCurrent 0 lets the bin next to the active one in", () => {
  const p = BP.plan(bookRows(), { amountUsd: 1000, have: "token0", count: 1, skipNearCurrent: 0 });
  assert.deepStrictEqual(p.bins.map((b) => b.bin), [1]);
});

// --- pool warnings and filters ---
t("18 warnings: red tier, unverified curator, feed down, paused, greedy curator", () => {
  const w = BP.poolWarnings({
    classificationSummary: { tierQualification: "red", reasonCodes: ["curator_unverified", "price_provider_mutable", "remove_liquidity_extension_present"] },
    priceProviderStatus: "feed_down", pauseLevel: 1, spreadAdminFeeE6: 400000,
  }).map((x) => x.text).join(" | ");
  for (const s of ["High Risk", "not verified", "replaced", "block your exit", "feed_down", "paused", "40%"]) assert.ok(w.includes(s), s);
});
t("19 a healthy green pool has no warnings", () => {
  assert.deepStrictEqual(BP.poolWarnings({ classificationSummary: { tierQualification: "green", reasonCodes: [] }, priceProviderStatus: "healthy", pauseLevel: 0, spreadAdminFeeE6: 50000 }), []);
});
t("20 pool filters: min TVL, min 24h volume, tiers", () => {
  const pools = [
    { tvlFiat: 5e6, volumeByWindow: { "24h": 2e8 }, classificationSummary: { tierQualification: "yellow" } },
    { tvlFiat: 2700, volumeByWindow: { "24h": 1e4 }, classificationSummary: { tierQualification: "green" } },
    { tvlFiat: 1e6, volumeByWindow: { "24h": 0 }, classificationSummary: { tierQualification: "red" } },
  ];
  assert.strictEqual(BP.filterPools(pools, { minTvl: 10000 }).length, 2);
  assert.strictEqual(BP.filterPools(pools, { minVolume24h: 1 }).length, 2);
  assert.strictEqual(BP.filterPools(pools, { tiers: ["green", "yellow"] }).length, 2);
  assert.strictEqual(BP.filterPools(pools, { minTvl: 10000, minVolume24h: 1, tiers: ["green", "yellow"] }).length, 1);
});

// --- prices ---
t("21 reference estimate divides the deviation back out and bin prices rise with the bin", () => {
  const ref = BP.estimateReference({ bid: 100.9, ask: 101.1, curEdges: [0.9, 1.1] }); // mid 101 at +1%
  assert.ok(Math.abs(ref - 100) < 1e-9);
  const lo = BP.binPriceRange([-0.5, 0], ref), hi = BP.binPriceRange([0, 0.5], ref);
  assert.ok(lo[0] < lo[1] && lo[1] === hi[0] && hi[0] === ref && hi[1] > hi[0]);
});
t("22 unavailable quote sides give no reference instead of a crazy price", () => {
  assert.strictEqual(BP.quoteUsable({ bid: 0, ask: 1 }), false);
  assert.strictEqual(BP.quoteUsable({ bid: 1, ask: 2 ** 64 }), false);
  assert.strictEqual(BP.quoteUsable({ bid: 1, ask: 1.0001 }), true);
  assert.strictEqual(BP.estimateReference({ bid: 1, ask: 1, curEdges: null }), null);
});

// --- properties over random books ---
t("23 random books: every strategy sums to the amount, stays on side, never picks ineligible or near bins", () => {
  const r = rng(42);
  for (let k = 0; k < 200; k++) {
    const cur = Math.floor(r() * 9) - 4;
    const bins = range(-8, 8).map((i) => mkBin(i, {
      mk: Math.round(r() * 3000 - 800), swaps: Math.floor(r() * 2000), liq: Math.round(r() * 300000), pnl: Math.round(r() * 2000 - 1000),
    }));
    const days = range(-8, 8).map((i) => day(i, Math.round(r() * 3000 - 1000), r() < 0.2 ? 0 : 20));
    const rows = BP.scoreBins(bins, days, cur);
    for (const strategy of Object.keys(BP.STRATEGIES)) for (const have of ["token0", "token1", "both"]) {
      const amt = Math.round(r() * 1e5) + 1;
      const p = BP.plan(rows, { amountUsd: amt, have, count: 1 + Math.floor(r() * 5), strategy });
      if (!p.bins.length) continue;
      assert.ok(Math.abs(usd(p) - amt) < 1e-6 * amt, `${strategy} sum`);
      for (const b of p.bins) {
        assert.ok(b.eligible && b.score > 0 && Math.abs(b.distance) > 1);
        if (have !== "both") assert.strictEqual(b.side, have);
        assert.ok(b.effAprBps <= b.score + 1e-9, "dilution never adds APR");
      }
    }
  }
});
t("24 random books: Max APR is never worse than any other split of the same bins", () => {
  const r = rng(7);
  for (let k = 0; k < 100; k++) {
    const rows = score(range(2, 6).map((i) => mkBin(i, { mk: 300 + Math.round(r() * 2000), liq: 1000 + Math.round(r() * 50000) })), 0, { minLiquidityUsd: 0, minLiquidityShare: 0 });
    const amt = 1000 + Math.round(r() * 200000);
    const max = BP.plan(rows, { amountUsd: amt, have: "token0", count: 5, strategy: "max" });
    for (const s of ["score", "flat", "volume"]) {
      const other = BP.plan(rows, { amountUsd: amt, have: "token0", count: 5, strategy: s });
      assert.ok(max.aprBps >= other.aprBps - 0.5, `${s}: ${other.aprBps} > max ${max.aprBps}`); // 0.5 bps for the 400-step grid
    }
  }
});

console.log(`${n} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
