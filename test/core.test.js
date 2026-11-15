// node test/core.test.js — checks core.js on synthetic bins and, with --live, on a real pool.
const assert = require("assert");
const BP = require("../core.js");

const mkBin = (bin, { swaps = 500, liq = 100000, vol = 1e6, mk7 = 500, mk24 = 500, pnl = 0, len = 5 } = {}) => ({
  bin: String(bin), swapCount: String(swaps), lengthE6: len, pnlAprBps: pnl,
  token0: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  token1: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  markoutByHorizon: { "5m": { aprBps: mk7 } },
});
const day = (bin, mk24, swaps = 10) => ({ bin: String(bin), swapCount: String(swaps), markoutByHorizon: { "5m": { aprBps: mk24 } } });
const days = (bins) => bins.map((i) => day(i, 500));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok", name); };

t("bin edges: #0 starts at 0%, #-2 is -0.001..-0.0005%", () => {
  const e = BP.binEdges([-2, -1, 0, 1].map((i) => mkBin(i)));
  assert.deepStrictEqual(e.get(0), [0, 0.0005]);
  assert.deepStrictEqual(e.get(-1), [-0.0005, 0]);
  assert.deepStrictEqual(e.get(-2), [-0.001, -0.0005]);
});

t("sides: above current → token0, below → token1, current → both", () => {
  assert.strictEqual(BP.sideOf(3, 0), "token0");
  assert.strictEqual(BP.sideOf(-3, 0), "token1");
  assert.strictEqual(BP.sideOf(0, 0), "both");
});

t("score blends 7d and 24h and penalises negative PnL", () => {
  const rows = BP.scoreBins([mkBin(1, { mk7: 1000, pnl: -400 })], [day(1, 500)], 0);
  assert.strictEqual(rows[0].score, 0.6 * 1000 + 0.4 * 500 + 0.25 * -400);
});

t("thin and losing bins are not eligible", () => {
  const rows = BP.scoreBins([mkBin(1, { swaps: 5 }), mkBin(2, { mk7: -200 }), mkBin(3)], [day(1, 500), day(2, -100), day(3, 500)], 0);
  assert.deepStrictEqual(rows.map((r) => r.eligible), [false, false, true]);
});

t("bins right next to the active one are skipped by default", () => {
  const rows = BP.scoreBins([-2, -1, 0, 1, 2].map((i) => mkBin(i)), days([-2, -1, 0, 1, 2]), 0);
  const p = BP.plan(rows, { amountUsd: 600, have: "token0", count: 5 });
  assert.deepStrictEqual(p.bins.map((b) => b.bin), [2]);
});

t("plan only uses bins the user can fund, never the active bin", () => {
  const bins = [-3, -2, -1, 0, 1, 2, 3].map((i) => mkBin(i, { mk7: 1000 - Math.abs(i) * 100 }));
  const rows = BP.scoreBins(bins, days([-3, -2, -1, 0, 1, 2, 3]), 0);
  const p = BP.plan(rows, { amountUsd: 600, have: "token0", count: 5 });
  assert.ok(p.bins.length && p.bins.every((b) => b.bin > 0));
  const q = BP.plan(rows, { amountUsd: 600, have: "token1", count: 5 });
  assert.ok(q.bins.every((b) => b.bin < 0));
});

t("allocation sums to the amount in both modes", () => {
  const rows = BP.scoreBins([2, 3, 4, 5].map((i) => mkBin(i, { mk7: 400 + i * 100 })), days([2, 3, 4, 5]), 0);
  for (const mode of ["spread", "max"]) {
    const p = BP.plan(rows, { amountUsd: 1000, have: "token0", count: 3, mode });
    const sum = p.bins.reduce((s, b) => s + b.usd, 0);
    assert.ok(Math.abs(sum - 1000) < 1e-6, `${mode}: ${sum}`);
  }
});

t("stale and thin bins are not eligible", () => {
  const rows = BP.scoreBins([mkBin(2), mkBin(3, { liq: 300 }), mkBin(4)], [day(2, 0, 0), day(3, 500), day(4, 500)], 0);
  assert.deepStrictEqual(rows.map((r) => r.eligible), [false, false, true]);
  assert.match(rows[0].reasons.join(), /24h/);
  assert.match(rows[1].reasons.join(), /thin/);
});

t("a pool idle for 24h is ranked on 7d instead of being emptied", () => {
  const rows = BP.scoreBins([mkBin(2, { mk7: 800 }), mkBin(3, { mk7: 600 })], [day(2, 0, 0), day(3, 0, 0)], 0);
  assert.ok(rows.every((r) => r.eligible && r.poolIdle24h));
  assert.strictEqual(rows[0].score, 800);
});

t("dilution: a big deposit into a thin bin earns less than its score", () => {
  assert.strictEqual(BP.dilutedApr(1000, 100000, 0), 1000);
  assert.ok(Math.abs(BP.dilutedApr(1000, 100000, 100000) - 500) < 1e-9);
});

t("max mode spreads a large deposit away from a thin top bin", () => {
  const rows = BP.scoreBins([mkBin(2, { mk7: 1000, liq: 30000 }), mkBin(3, { mk7: 800, liq: 1e6 })], [day(2, 1000), day(3, 800)], 0);
  const p = BP.plan(rows, { amountUsd: 50000, have: "token0", count: 2, mode: "max" });
  const thin = p.bins.find((b) => b.bin === 2);
  assert.ok(thin.usd < 25000, `thin bin got ${thin.usd}`);
});

(async () => {
  if (process.argv.includes("--live")) {
    const chain = 1, pool = "0xaef2ad7aBB651945e6D24276715f25BDED0ad41e";
    const [meta, b7, b1] = await Promise.all([BP.api.pool(chain, pool), BP.api.bins(chain, pool, "7d"), BP.api.bins(chain, pool, "24h")]);
    const rows = BP.scoreBins(b7.bins, b1.bins, b7.curBinIdx);
    const p = BP.plan(rows, { amountUsd: 617, have: "token0", count: 3 });
    console.log(`live ${meta.pair}: curBin ${b7.curBinIdx}, eligible ${rows.filter((r) => r.eligible).length}/${rows.length}`);
    for (const b of p.bins) console.log(`  #${b.bin} [${b.edges.map((e) => e.toFixed(5)).join(", ")}]% $${b.usd.toFixed(2)} score ${(b.score / 100).toFixed(2)}% eff ${(b.effAprBps / 100).toFixed(2)}%`);
    console.log(`  plan APR ${(p.aprBps / 100).toFixed(2)}%, ~$${p.weeklyUsd.toFixed(2)}/week; warnings: ${BP.poolWarnings(meta).map((w) => w.text).join(" | ")}`);
    assert.ok(p.bins.every((b) => b.bin > b7.curBinIdx));
    n++;
  }
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
