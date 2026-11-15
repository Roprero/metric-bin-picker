// node test/core.test.js — checks core.js on synthetic bins and, with --live, on real pools for every window × horizon × strategy.
const assert = require("assert");
const BP = require("../core.js");

const mkBin = (bin, { swaps = 500, liq = 100000, vol = 1e6, mk = 500, mk1m = mk, mk30m = mk, pnl = 0, len = 5 } = {}) => ({
  bin: String(bin), swapCount: String(swaps), lengthE6: len, pnlAprBps: pnl,
  token0: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  token1: { avgLiquidityFiat: liq / 2, volumeFiat: vol, reserveFiat: 0 },
  markoutByHorizon: { "1m": { aprBps: mk1m }, "5m": { aprBps: mk }, "30m": { aprBps: mk30m } },
});
const day = (bin, mk, swaps = 10) => mkBin(bin, { swaps, mk });
const days = (bins, mk = 500) => bins.map((i) => day(i, mk));
const sum = (p) => p.bins.reduce((s, b) => s + b.usd, 0);

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

t("score blends the main window with 24h and penalises negative PnL", () => {
  const rows = BP.scoreBins([mkBin(2, { mk: 1000, pnl: -400 })], [day(2, 500)], 0);
  assert.strictEqual(rows[0].score, 0.6 * 1000 + 0.4 * 500 + 0.25 * -400);
});

t("horizon picks the matching markout", () => {
  const b = [mkBin(2, { mk: 500, mk1m: 900, mk30m: 100 })];
  const s = (horizon) => BP.scoreBins(b, [mkBin(2, { swaps: 10, mk: 0, mk1m: 0, mk30m: 0 })], 0, { horizon })[0].score;
  assert.strictEqual(s("1m"), 0.6 * 900);
  assert.strictEqual(s("5m"), 0.6 * 500);
  assert.strictEqual(s("30m"), 0.6 * 100);
});

t("24h window scores on 24h alone and uses its own swap threshold", () => {
  const b = [mkBin(2, { mk: 700, swaps: 20 })];
  const r = BP.scoreBins(b, b, 0, { window: "24h" })[0];
  assert.ok(r.eligible); assert.strictEqual(r.score, 700);
  assert.ok(!BP.scoreBins(b, days([2]), 0, { window: "7d" })[0].eligible, "20 swaps is too few for 7d");
});

t("thin, stale and losing bins are not eligible", () => {
  const rows = BP.scoreBins(
    [mkBin(2, { swaps: 5 }), mkBin(3, { mk: -200 }), mkBin(4), mkBin(5, { liq: 300 }), mkBin(6)],
    [day(2, 500), day(3, -100), day(4, 0, 0), day(5, 500), day(6, 500)], 0);
  assert.deepStrictEqual(rows.map((r) => r.eligible), [false, false, false, false, true]);
  assert.match(rows[2].reasons.join(), /24h/);
  assert.match(rows[3].reasons.join(), /thin/);
});

t("a pool idle for 24h is ranked on the main window instead of being emptied", () => {
  const rows = BP.scoreBins([mkBin(2, { mk: 800 }), mkBin(3, { mk: 600 })], [day(2, 0, 0), day(3, 0, 0)], 0);
  assert.ok(rows.every((r) => r.eligible && r.poolIdle24h));
  assert.strictEqual(rows[0].score, 800);
});

// a symmetric book around bin 0, score falling with distance
const book = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const rowsBook = BP.scoreBins(book.map((i) => mkBin(i, { mk: 1200 - Math.abs(i) * 100, vol: 1e6 * (7 - Math.abs(i)) })), days(book), 0);

for (const strategy of Object.keys(BP.STRATEGIES)) {
  t(`${strategy}: sums to the amount, stays on the fundable side, skips the active bin and its neighbour`, () => {
    for (const have of ["token0", "token1", "both"]) {
      const p = BP.plan(rowsBook, { amountUsd: 1000, have, count: 3, strategy });
      assert.ok(Math.abs(sum(p) - 1000) < 1e-6, `${have}: ${sum(p)}`);
      assert.ok(p.bins.length >= 1 && p.bins.length <= 3);
      for (const b of p.bins) {
        assert.ok(Math.abs(b.distance) > 1, `#${b.bin} too close`);
        if (have !== "both") assert.strictEqual(b.side, have);
      }
    }
  });
}

t("spot/curve/bid-ask take the closest bins; curve weighs the nearest most, bid-ask the farthest", () => {
  const get = (strategy) => BP.plan(rowsBook, { amountUsd: 1000, have: "token0", count: 3, strategy }).bins;
  assert.deepStrictEqual(get("spot").map((b) => b.bin), [2, 3, 4]);
  const c = get("curve"), ba = get("bidask"), f = get("spot");
  assert.ok(c[0].usd > c[1].usd && c[1].usd > c[2].usd);
  assert.ok(ba[0].usd < ba[1].usd && ba[1].usd < ba[2].usd);
  assert.ok(f.every((b) => Math.abs(b.usd - 1000 / 3) < 1e-9));
});

t("volume pro-rata follows volume, flat splits evenly", () => {
  const v = BP.plan(rowsBook, { amountUsd: 1000, have: "token0", count: 3, strategy: "volume" }).bins;
  assert.ok(v[0].usd > v[1].usd && v[1].usd > v[2].usd, "nearer bins carried more volume here");
  const f = BP.plan(rowsBook, { amountUsd: 900, have: "token0", count: 3, strategy: "flat" }).bins;
  assert.ok(f.every((b) => Math.abs(b.usd - 300) < 1e-9));
});

t("dilution: a big deposit into a thin bin earns less than its score", () => {
  assert.strictEqual(BP.dilutedApr(1000, 100000, 0), 1000);
  assert.ok(Math.abs(BP.dilutedApr(1000, 100000, 100000) - 500) < 1e-9);
});

t("max mode spreads a large deposit away from a thin top bin", () => {
  const rows = BP.scoreBins([mkBin(2, { mk: 1000, liq: 30000 }), mkBin(3, { mk: 800, liq: 1e6 })], [day(2, 1000), day(3, 800)], 0);
  const p = BP.plan(rows, { amountUsd: 50000, have: "token0", count: 2, strategy: "max" });
  assert.ok(p.bins.find((b) => b.bin === 2).usd < 25000);
});

t("unknown strategy is an error, not a silent default", () => {
  assert.throws(() => BP.plan(rowsBook, { amountUsd: 1, have: "token0", strategy: "yolo" }), /unknown strategy/);
});

(async () => {
  if (process.argv.includes("--live")) {
    const pools = [[1, "0xaef2ad7aBB651945e6D24276715f25BDED0ad41e"]];
    const bsc = (await BP.api.pools(56)).slice(0, 2).map((p) => [56, p.poolAddress]);
    let combos = 0;
    for (const [chain, pool] of [...pools, ...bsc]) {
      for (const window of BP.WINDOWS) {
        for (const horizon of BP.HORIZONS) {
          const { meta, curBin, window: win, rows } = await BP.loadScored(chain, pool, { window, horizon });
          assert.strictEqual(win && typeof win.fromTs, "number", "window echoed");
          for (const strategy of Object.keys(BP.STRATEGIES)) {
            for (const have of ["token0", "token1"]) {
              const p = BP.plan(rows, { amountUsd: 1000, have, count: 3, strategy });
              if (!p.bins.length) continue;
              assert.ok(Math.abs(sum(p) - 1000) < 1e-6);
              for (const b of p.bins) {
                assert.ok(b.eligible && b.side === have && Math.abs(b.bin - curBin) > 1, `${meta.pair} ${window}/${horizon}/${strategy} #${b.bin}`);
                assert.ok(b.mkMain !== null && b.score > 0);
              }
              combos++;
            }
          }
          if (chain === 1 && horizon === "5m" && window === "7d") {
            const p = BP.plan(rows, { amountUsd: 617, have: "token0", count: 3, strategy: "score" });
            console.log(`  live ${meta.pair} 7d/5m: ` + p.bins.map((b) => `#${b.bin} $${b.usd.toFixed(0)} (${(b.effAprBps / 100).toFixed(1)}%)`).join(", ") + ` → ${(p.aprBps / 100).toFixed(2)}%`);
          }
        }
      }
    }
    console.log(`ok live: ${combos} non-empty plans across ${1 + bsc.length} pools × ${BP.WINDOWS.length} windows × ${BP.HORIZONS.length} horizons × ${Object.keys(BP.STRATEGIES).length} strategies`);
    n++;
  }
  console.log(`${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
