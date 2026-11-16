// node test/degradation.test.js — what happens when the undocumented /analytics/bins breaks. No network: fetch is stubbed.
// Metric said (Nov 2026) the endpoint is for their frontend and may change without notice, so the page must survive without it.
const assert = require("assert");
const BP = require("../core.js");

const Q = (x) => (BigInt(Math.round(x * 1e9)) * 2n ** 64n / 1000000000n).toString(); // price → Q64.64 string
const POOL = "0xpool";
const meta = {
  pair: "AAA/BBB", poolAddress: POOL, curBinIdx: 1, token0Decimals: 6, token1Decimals: 18, token0FiatPrice: 2, token1FiatPrice: 1,
  priceProviderStatus: "healthy", pauseLevel: 0, spreadAdminFeeE6: 100000, spreadProtocolFeeE6: 100000,
};
// Bins 5 bps wide around a price of 1: asks take bins 1..3 (token0), bids bins 1..-1 (token1). Cumulative, as the API sends them.
const step = 0.0005;
const depth = {
  asks: [1, 2, 3].map((i, k) => ({ binIdx: i, price: Q(1 + i * step), cumulativeVolume: String((k + 1) * 1000 * 1e6) })),
  bids: [1, 0, -1].map((i, k) => ({ binIdx: i, price: Q(1 + (i - 1) * step), cumulativeVolume: (BigInt(k + 1) * 500n * 10n ** 18n).toString() })),
};
const bidAsk = { bidAdj: Q(0.9999), askAdj: Q(1.0001), priceProviderStatus: "healthy", depth };
const goodBins = (window) => ({
  window, curBinIdx: 1,
  bins: [-1, 0, 1, 2, 3].map((i) => ({
    bin: String(i), lengthE6: 500, swapCount: "500", pnlAprBps: 0,
    token0: { avgLiquidityFiat: 50000, reserveFiat: 50000, volumeFiat: 1e6 },
    token1: { avgLiquidityFiat: 50000, reserveFiat: 50000, volumeFiat: 1e6 },
    markoutByHorizon: { "1m": { aprBps: 900 }, "5m": { aprBps: 900 }, "30m": { aprBps: 900 } },
  })),
});

// Stub fetch: `bins` decides what /analytics/bins answers, `quote` what /bid_ask answers. Records every URL.
function stub({ bins, quote = () => bidAsk }) {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes("/metadata")) return reply(200, { data: [meta] });
    if (url.includes("/analytics/bins")) { const r = bins(url); return r instanceof Error ? reply(Number(r.message), { error: "x" }) : reply(200, r); }
    if (url.includes("/bid_ask")) { const r = quote(url); return r instanceof Error ? reply(Number(r.message), {}) : reply(200, r); }
    return reply(404, {});
  };
  BP.clearCache();
  return urls;
}

let n = 0;
const failed = [];
const t = async (name, fn) => {
  try { await fn(); n++; console.log("ok", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n   ", e.message.split("\n")[0]); }
};

(async () => {
  await t("D01 depthRows: a bin holds the step between cumulative levels, priced in USD", async () => {
    const rows = BP.depthRows(depth, meta, 1);
    const by = new Map(rows.map((r) => [r.bin, r]));
    assert.deepStrictEqual(rows.map((r) => r.bin), [-1, 0, 1, 2, 3]);
    assert.strictEqual(by.get(2).liquidity, 1000 * 2);          // 1000 token0 at $2
    assert.strictEqual(by.get(0).liquidity, 500);               // 500 token1 at $1, 18 decimals
    assert.strictEqual(by.get(1).liquidity, 1000 * 2 + 500);    // the active bin holds both tokens
  });
  await t("D02 depthRows: bin width from neighbouring prices gives the same edges as the analytics", async () => {
    const rows = BP.depthRows(depth, meta, 1);
    const ref = BP.binEdges(goodBins("7d").bins);
    for (const r of rows) {
      assert.ok(Math.abs(r.edges[0] - ref.get(r.bin)[0]) < 1e-9 && Math.abs(r.edges[1] - ref.get(r.bin)[1]) < 1e-9, `bin ${r.bin} edges ${r.edges}`);
    }
  });
  await t("D03 depthRows: sides follow the active bin; every row is ineligible with a reason", async () => {
    for (const r of BP.depthRows(depth, meta, 1)) {
      assert.strictEqual(r.side, r.bin > 1 ? "token0" : r.bin < 1 ? "token1" : "both");
      assert.strictEqual(r.eligible, false);
      assert.strictEqual(r.score, null);
      assert.deepStrictEqual(r.reasons, ["per-bin analytics unavailable"]);
    }
  });
  await t("D04 depthRows: no plan can be built from order-book rows", async () => {
    const rows = BP.depthRows(depth, meta, 1);
    for (const strategy of Object.keys(BP.STRATEGIES)) for (const have of ["token0", "token1", "both"]) {
      assert.strictEqual(BP.plan(rows, { amountUsd: 1000, have, strategy }).bins.length, 0);
    }
  });
  await t("D05 depthRows: junk levels are skipped, an empty book gives no rows", async () => {
    assert.deepStrictEqual(BP.depthRows({ asks: [], bids: [] }, meta, 1), []);
    assert.deepStrictEqual(BP.depthRows(null, meta, 1), []);
    const rows = BP.depthRows({ asks: [{ binIdx: 2, price: "x", cumulativeVolume: "oops" }, ...depth.asks], bids: depth.bids }, meta, 1);
    assert.strictEqual(rows.length, 5);
  });
  await t("D06 binsUsable: the current shape passes, renamed or missing fields fail", async () => {
    assert.ok(BP.binsUsable(goodBins("7d")));
    assert.ok(!BP.binsUsable(null));
    assert.ok(!BP.binsUsable({ curBinIdx: 1 }));
    assert.ok(!BP.binsUsable({ ...goodBins("7d"), curBinIdx: undefined }));
    const g = goodBins("7d"); g.bins[2] = { ...g.bins[2], token0: undefined };
    assert.ok(!BP.binsUsable(g));
    const h = goodBins("7d"); h.bins = h.bins.map(({ lengthE6, ...b }) => ({ ...b, widthE6: lengthE6 }));
    assert.ok(!BP.binsUsable(h));
  });
  await t("D07 loadScored: analytics up → scored rows, not degraded, one bid_ask call with depth", async () => {
    const urls = stub({ bins: (u) => goodBins(u.includes("24h") ? "24h" : "7d") });
    const r = await BP.loadScored(1, POOL, { window: "7d" });
    assert.strictEqual(r.degraded, null);
    assert.ok(r.rows.some((x) => x.eligible));
    assert.strictEqual(urls.filter((u) => u.includes("bid_ask")).length, 1);
    assert.ok(urls.some((u) => u.includes("bid_ask?depth=true")));
  });
  await t("D08 loadScored: analytics 500 → order-book rows, reason kept, prices and reference still there", async () => {
    stub({ bins: () => new Error("500") });
    const r = await BP.loadScored(1, POOL, { window: "7d" });
    assert.ok(r.degraded && r.degraded.includes("500"), `degraded: ${r.degraded}`);
    assert.strictEqual(r.curBin, 1);
    assert.strictEqual(r.rows.length, 5);
    assert.ok(r.reference > 0.99 && r.reference < 1.01, `reference ${r.reference}`);
    assert.ok(r.rows.every((x) => x.priceRange && x.priceRange[0] > 0));
  });
  await t("D09 loadScored: analytics answer with a new shape → degraded, not a crash", async () => {
    stub({ bins: () => ({ data: { bins: [] } }) });
    const r = await BP.loadScored(1, POOL, { window: "7d" });
    assert.strictEqual(r.degraded, "unexpected response shape");
    assert.ok(r.rows.length > 0);
  });
  await t("D10 loadScored: only the 24h check fails → still degraded (no half-scored plan)", async () => {
    stub({ bins: (u) => (u.includes("period=24h") ? new Error("502") : goodBins("7d")) });
    const r = await BP.loadScored(1, POOL, { window: "7d" });
    assert.ok(r.degraded && r.degraded.includes("502"));
  });
  await t("D11 loadScored: analytics and order book both down → the original analytics error is thrown", async () => {
    stub({ bins: () => new Error("503"), quote: () => new Error("500") });
    await assert.rejects(BP.loadScored(1, POOL, { window: "7d" }), /503/);
  });
  await t("D12 loadScored: 24h window makes a single analytics call and degrades the same way", async () => {
    const urls = stub({ bins: () => new Error("404") });
    const r = await BP.loadScored(1, POOL, { window: "24h" });
    assert.ok(r.degraded.includes("404"));
    assert.strictEqual(urls.filter((u) => u.includes("analytics/bins")).length, 1);
  });

  console.log(`${n} passed${failed.length ? `, ${failed.length} failed` : ""}`);
  if (failed.length) process.exit(1);
})();
