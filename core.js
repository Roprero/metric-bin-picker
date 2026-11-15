// Bin Picker core: scoring and allocation over Metric per-bin analytics.
// Pure functions, no DOM. Works in the browser (window.BinPicker) and in Node (module.exports).
(function (root) {
  "use strict";

  const API = "https://api.metric.xyz/public/v1";
  const WINDOWS = ["24h", "7d", "30d", "all"]; // what /analytics/bins accepts, same as the Metric app
  const HORIZONS = ["1m", "5m", "30m"];        // markout horizons, same as the Metric app

  const DEFAULTS = {
    window: "7d",        // main window the score is built on
    horizon: "5m",       // markout horizon
    wMain: 0.6,          // weight of the main-window markout APR in the score
    wDay: 0.4,           // weight of the 24h markout APR (recency); unused when the main window is 24h
    pnlPenalty: 0.25,    // share of a negative trading-PnL APR subtracted from the score
    minSwaps: { "24h": 15, "7d": 100, "30d": 300, all: 300 }, // swaps a bin needs in the main window
    requireRecent: true, // the bin must also have traded in the last 24h, unless the whole pool was idle
    minLiquidityUsd: 1000,   // below this a bin's APR is noise (a few swaps over a tiny base)
    minLiquidityShare: 0.02, // ...and it must hold at least this share of the pool's largest bin
    skipNearCurrent: 1,  // skip bins this close to the active one: the pool moves while you click, and they flip sides
  };

  // How each strategy picks bins and weighs them. `rank` is 1 for the bin closest to the price.
  const STRATEGIES = {
    score:  { pick: "best",    label: "Top score",       hint: "Best recent markout, weighted by score." },
    max:    { pick: "best",    label: "Max APR",         hint: "Water-fills by APR after your own dilution. Matters for large deposits." },
    flat:   { pick: "best",    label: "Flat",            hint: "Best bins, equal amounts." },
    volume: { pick: "best",    label: "Volume pro-rata", hint: "Best bins, weighted by the volume that crossed them." },
    spot:   { pick: "nearest", label: "Spot",            hint: "Closest earning bins to the price, equal amounts. Trades most, flips side most." },
    curve:  { pick: "nearest", label: "Curve",           hint: "Closest earning bins, most weight next to the price." },
    bidask: { pick: "nearest", label: "Bid-Ask",         hint: "Closest earning bins, most weight on the far ones. Catches bigger moves." },
  };

  // Bin edges in percent deviation from the reference. Bin 0 starts at 0%, bins above stack up, bins below stack down.
  function binEdges(bins) {
    const byIdx = new Map(bins.map((b) => [Number(b.bin), Number(b.lengthE6) / 1e4])); // lengthE6 → percent
    const idx = [...byIdx.keys()].sort((a, b) => a - b);
    const edges = new Map();
    let up = 0;
    for (const i of idx.filter((i) => i >= 0)) { const w = byIdx.get(i); edges.set(i, [up, up + w]); up += w; }
    let down = 0;
    for (const i of idx.filter((i) => i < 0).reverse()) { const w = byIdx.get(i); edges.set(i, [down - w, down]); down -= w; }
    return edges;
  }

  // Which token a bin takes on deposit: above the active bin → token0, below → token1, the active bin → both.
  function sideOf(bin, curBin) {
    return bin > curBin ? "token0" : bin < curBin ? "token1" : "both";
  }

  const liqFiat = (b) => (b.token0.avgLiquidityFiat || 0) + (b.token1.avgLiquidityFiat || 0);
  const mkApr = (b, h) => (b && b.markoutByHorizon && b.markoutByHorizon[h] ? b.markoutByHorizon[h].aprBps : null);

  // One row per bin, scored on the main window with the last 24h as a recency check. Score is in bps of APR.
  //   binsMain: /analytics/bins for opts.window;  bins24h: the same for 24h (pass binsMain again when the window is 24h)
  function scoreBins(binsMain, bins24h, curBin, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const single = o.window === "24h";
    const day = new Map((bins24h || []).map((b) => [Number(b.bin), b]));
    const edges = binEdges(binsMain);
    const minLiq = Math.max(o.minLiquidityUsd, o.minLiquidityShare * Math.max(0, ...binsMain.map(liqFiat)));
    const minSwaps = typeof o.minSwaps === "number" ? o.minSwaps : o.minSwaps[o.window];
    // A pool with no swaps at all in 24h (a closed stock market, a quiet weekend) is ranked on the main window alone.
    const poolIdle24h = !(bins24h || []).some((b) => Number(b.swapCount) > 0);
    const needRecent = o.requireRecent && !poolIdle24h && !single;
    return binsMain.map((b) => {
      const i = Number(b.bin);
      const b24 = day.get(i);
      const mkMain = mkApr(b, o.horizon);
      const swaps24 = b24 ? Number(b24.swapCount) : 0;
      const mkDay = swaps24 > 0 ? mkApr(b24, o.horizon) : null; // a bin with no swaps has no 24h markout, not a zero one
      const pnl = b.pnlAprBps;
      const swaps = Number(b.swapCount);
      const liq = liqFiat(b);
      const reasons = [];
      let score = null;
      if (swaps < minSwaps) reasons.push(`fewer than ${minSwaps} swaps in ${o.window}`);
      if (needRecent && swaps24 === 0) reasons.push("no swaps in the last 24h");
      if (mkMain === null) reasons.push(`no ${o.window} markout`);
      else if (mkMain <= 0) reasons.push(`losing over ${o.window}`); // one good day does not rescue a losing week
      if (!(liq > 0)) reasons.push("no liquidity");
      else if (liq < minLiq) reasons.push(`too thin to trust its APR (< $${Math.round(minLiq)})`);
      if (!reasons.length) {
        score = single || mkDay === null ? mkMain : o.wMain * mkMain + o.wDay * mkDay;
        if (pnl !== null && pnl !== undefined && pnl < 0) score += o.pnlPenalty * pnl;
        if (score <= 0) reasons.push("score ≤ 0");
      }
      return {
        bin: i,
        edges: edges.get(i),
        side: sideOf(i, curBin),
        distance: i - curBin,
        swaps, swaps24,
        volume: b.token0.volumeFiat || 0,
        liquidity: liq,
        mkMain, mkDay, pnl,
        cooling: mkDay !== null && mkDay < 0,
        poolIdle24h,
        score,
        eligible: !reasons.length,
        reasons,
      };
    });
  }

  // APR you would earn on `x` dollars added to a bin that holds `liq` dollars: the bin's flow is shared with you.
  const dilutedApr = (score, liq, x) => (x > 0 ? (score * liq) / (liq + x) : score);

  // Reference price estimate (token1 per token0) from the pool's executable mid and the active bin.
  // bid/ask already include the pool's deviation, so divide it back out at the middle of the active bin.
  // Accurate to about half a bin width, which is what a "≈ price range" needs.
  function estimateReference({ bid, ask, curEdges }) {
    if (!(bid > 0) || !(ask > 0) || !curEdges) return null;
    const mid = (bid + ask) / 2;
    const dev = (curEdges[0] + curEdges[1]) / 2 / 100;
    return mid / (1 + dev);
  }

  // Approximate price range a bin covers, in token1 per token0, before the spread.
  const binPriceRange = (edges, reference) =>
    reference && edges ? [reference * (1 + edges[0] / 100), reference * (1 + edges[1] / 100)] : null;

  // Pool list filters people asked for in #feedback: minimum TVL, minimum 24h volume, tiers.
  function filterPools(pools, { minTvl = 0, minVolume24h = 0, tiers = null } = {}) {
    return pools.filter((p) =>
      (p.tvlFiat || 0) >= minTvl &&
      ((p.volumeByWindow && p.volumeByWindow["24h"]) || 0) >= minVolume24h &&
      (!tiers || tiers.includes((p.classificationSummary && p.classificationSummary.tierQualification) || "unclassified")));
  }

  // Pick bins on the side the user can fund and split `amountUsd` across them with a strategy from STRATEGIES.
  //   have: "token0" | "token1" | "both"
  function plan(rows, { amountUsd, have, count = 3, strategy = "score", skipNearCurrent = DEFAULTS.skipNearCurrent }) {
    const s = STRATEGIES[strategy];
    if (!s) throw new Error(`unknown strategy ${strategy}`);
    const n = Math.max(1, count);
    const fundable = rows.filter((r) =>
      r.eligible &&
      (have === "both" || r.side === have) &&
      Math.abs(r.distance) > skipNearCurrent);
    // ties break toward the price, then by bin index, so the same data always gives the same plan
    const top = s.pick === "nearest"
      ? [...fundable].sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance) || b.score - a.score || a.bin - b.bin).slice(0, n)
      : [...fundable].sort((a, b) => b.score - a.score || Math.abs(a.distance) - Math.abs(b.distance) || a.bin - b.bin).slice(0, n);
    if (!top.length || !(amountUsd > 0)) return { bins: [], aprBps: null, weeklyUsd: 0, strategy };

    // rank 1 = closest to the price; with "both", bins on each side are ranked by their own distance
    const rank = new Map([...top].sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance)).map((r, k) => [r.bin, k + 1]));
    const weight = {
      score: (r) => r.score,
      flat: () => 1,
      volume: (r) => Math.max(r.volume, 1e-9),
      spot: () => 1,
      curve: (r) => 1 / rank.get(r.bin),
      bidask: (r) => rank.get(r.bin),
    };

    const alloc = new Map(top.map((r) => [r.bin, 0]));
    if (strategy === "max") {
      const steps = 400, dx = amountUsd / steps;
      for (let k = 0; k < steps; k++) {
        let best = null, bestGain = -Infinity;
        for (const r of top) {
          const a = alloc.get(r.bin);
          const gain = r.score * r.liquidity * r.liquidity / ((r.liquidity + a) * (r.liquidity + a));
          if (gain > bestGain) { bestGain = gain; best = r; }
        }
        alloc.set(best.bin, alloc.get(best.bin) + dx);
      }
    } else {
      const w = weight[strategy];
      const total = top.reduce((sum, r) => sum + w(r), 0);
      for (const r of top) alloc.set(r.bin, (amountUsd * w(r)) / total);
    }

    const bins = top
      .map((r) => {
        const usd = alloc.get(r.bin);
        // binShare: the part of the bin you would own after depositing
        return { ...r, usd, share: usd / amountUsd, binShare: usd / (r.liquidity + usd), effAprBps: dilutedApr(r.score, r.liquidity, usd) };
      })
      .filter((r) => r.usd > 0)
      .sort((a, b) => a.bin - b.bin);
    const yearly = bins.reduce((sum, r) => sum + (r.usd * r.effAprBps) / 1e4, 0);
    return { bins, aprBps: (yearly / amountUsd) * 1e4, weeklyUsd: yearly / 52, strategy };
  }

  // Warnings about the pool itself, from /metadata.
  function poolWarnings(meta) {
    const w = [];
    const tier = meta.classificationSummary && meta.classificationSummary.tierQualification;
    const codes = (meta.classificationSummary && meta.classificationSummary.reasonCodes) || [];
    if (tier === "red") w.push({ level: "bad", text: "High Risk tier: one transaction may drain a bin. Read the reasons before depositing." });
    if (tier === "unclassified") w.push({ level: "warn", text: "Pool is not classified yet." });
    if (codes.includes("app_missing")) w.push({ level: "warn", text: "Custom pricing, not anchored to Chainlink/Pyth: you trust the curator's code." });
    if (codes.includes("curator_unverified")) w.push({ level: "warn", text: "Curator is not verified by Metric." });
    if (codes.includes("price_provider_mutable")) w.push({ level: "bad", text: "Price provider can be replaced after you deposit." });
    if (codes.includes("remove_liquidity_extension_present")) w.push({ level: "bad", text: "A withdrawal extension can block your exit." });
    if (meta.priceProviderStatus && meta.priceProviderStatus !== "healthy") w.push({ level: "bad", text: `Price provider status: ${meta.priceProviderStatus}. The pool is not trading right now.` });
    if (meta.pauseLevel) w.push({ level: "bad", text: "Pool is paused." });
    if (meta.spreadAdminFeeE6 > 200000) w.push({ level: "warn", text: `Curator keeps ${(meta.spreadAdminFeeE6 / 1e4).toFixed(0)}% of the spread.` });
    return w;
  }

  // Every call to the API costs ~0.3 s (the backend is in Tokyo and Cloudflare does not cache it), so keep responses for a
  // minute and share requests already in flight: switching the horizon or strategy then costs no network at all.
  const CACHE_TTL_MS = 60000;
  const FETCH_TIMEOUT_MS = 20000;
  const cache = new Map();
  function getJson(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
    // A stalled response (some networks freeze Cloudflare traffic mid-body) must fail loudly, not spin forever.
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
    const promise = fetch(url, { headers: { Accept: "application/json" }, signal: ctl?.signal }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    }).catch((e) => {
      throw e && e.name === "AbortError" ? Object.assign(new Error("timeout"), { timeout: true }) : e;
    }).finally(() => clearTimeout(timer));
    cache.set(url, { at: Date.now(), promise });
    promise.catch(() => cache.delete(url)); // never cache a failure
    return promise;
  }
  const clearCache = () => cache.clear();

  const api = {
    chains: () => getJson(`${API}/chains`).then((d) => d.chains),
    pools: (chainId) =>
      getJson(`${API}/evm/${chainId}/metadata?count=500&sortBy=tvl&include24h=true&minTvlFiat=1000`).then((d) => d.data),
    pool: (chainId, address) =>
      getJson(`${API}/evm/${chainId}/metadata?include24h=true&addresses=${address}`).then((d) => d.data[0] || null),
    bins: (chainId, address, period) =>
      getJson(`${API}/evm/${chainId}/${address}/analytics/bins?period=${period}&fiat=USD`),
    bidAsk: (chainId, address) =>
      getJson(`${API}/evm/${chainId}/${address}/bid_ask?depth=false`).then((d) => ({
        bid: Number(BigInt(d.bidAdj)) / 2 ** 64,
        ask: Number(BigInt(d.askAdj)) / 2 ** 64,
        status: d.priceProviderStatus,
      })),
  };
  // The API marks a side the pool refuses with bid 0 or ask 2^128 − 1, i.e. about 2^64 once divided by 2^64.
  const quoteUsable = (q) => !!q && q.bid > 0 && q.ask > 0 && q.ask < 2 ** 63;

  // Fetch the main window and the 24h check (once when they are the same) and score the pool.
  async function loadScored(chainId, address, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const [meta, main, day, quote] = await Promise.all([
      api.pool(chainId, address),
      api.bins(chainId, address, o.window),
      o.window === "24h" ? null : api.bins(chainId, address, "24h"),
      api.bidAsk(chainId, address).catch(() => null), // prices are a nice-to-have; the plan works without them
    ]);
    const dayBins = (day || main).bins;
    const rows = scoreBins(main.bins, dayBins, main.curBinIdx, o);
    const cur = rows.find((r) => r.bin === main.curBinIdx);
    const reference = quoteUsable(quote) ? estimateReference({ bid: quote.bid, ask: quote.ask, curEdges: cur && cur.edges }) : null;
    for (const r of rows) r.priceRange = binPriceRange(r.edges, reference);
    return { meta, curBin: main.curBinIdx, window: main.window, reference, rows };
  }

  const BinPicker = {
    API, WINDOWS, HORIZONS, DEFAULTS, STRATEGIES,
    binEdges, sideOf, scoreBins, dilutedApr, plan, poolWarnings,
    estimateReference, binPriceRange, filterPools, quoteUsable, api, loadScored, clearCache,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = BinPicker;
  else root.BinPicker = BinPicker;
})(typeof window !== "undefined" ? window : globalThis);
