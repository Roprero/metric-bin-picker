// Bin Picker core: scoring and allocation over Metric per-bin analytics.
// Pure functions, no DOM. Works in the browser (window.BinPicker) and in Node (module.exports).
(function (root) {
  "use strict";

  const API = "https://api.metric.xyz/public/v1";

  const DEFAULTS = {
    horizon: "5m",       // markout horizon: 1m | 5m | 30m
    minSwaps: 100,       // 7d swaps a bin needs to be considered at all
    requireRecent: true, // the bin must also have traded in the last 24h: old flow says little about tomorrow
    minLiquidityUsd: 1000,   // below this a bin's APR is noise (a few swaps over a tiny base)
    minLiquidityShare: 0.02, // ...and it must hold at least this share of the pool's largest bin
    w7d: 0.6,            // weight of the 7d markout APR in the score
    w24h: 0.4,           // weight of the 24h markout APR (recency)
    pnlPenalty: 0.25,    // share of a negative trading-PnL APR subtracted from the score
    skipNearCurrent: 1,  // skip bins this close to the active one: the pool moves while you click, and they flip sides
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

  // Merge the 7d and 24h snapshots into one row per bin with a score in bps.
  function scoreBins(bins7d, bins24h, curBin, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const day = new Map((bins24h || []).map((b) => [Number(b.bin), b]));
    const edges = binEdges(bins7d);
    const minLiq = Math.max(o.minLiquidityUsd, o.minLiquidityShare * Math.max(0, ...bins7d.map(liqFiat)));
    // A pool with no swaps at all in 24h (a closed stock market, a quiet weekend) is ranked on 7d alone.
    const poolIdle24h = !(bins24h || []).some((b) => Number(b.swapCount) > 0);
    const needRecent = o.requireRecent && !poolIdle24h;
    return bins7d.map((b) => {
      const i = Number(b.bin);
      const b24 = day.get(i);
      const mk7 = mkApr(b, o.horizon);
      const mk24 = mkApr(b24, o.horizon);
      const pnl7 = b.pnlAprBps;
      const swaps7 = Number(b.swapCount);
      const liq = liqFiat(b);
      const reasons = [];
      let score = null;
      const swaps24 = b24 ? Number(b24.swapCount) : 0;
      if (swaps7 < o.minSwaps) reasons.push(`fewer than ${o.minSwaps} swaps in 7d`);
      if (needRecent && swaps24 === 0) reasons.push("no swaps in the last 24h");
      if (mk7 === null) reasons.push("no 7d markout");
      if (!(liq > 0)) reasons.push("no liquidity");
      else if (liq < minLiq) reasons.push(`too thin to trust its APR (< ${Math.round(minLiq)} $)`);
      if (!reasons.length) {
        score = o.w7d * mk7 + o.w24h * (mk24 === null || swaps24 === 0 ? mk7 : mk24);
        if (pnl7 !== null && pnl7 < 0) score += o.pnlPenalty * pnl7;
        if (score <= 0) reasons.push("score ≤ 0");
      }
      return {
        bin: i,
        edges: edges.get(i),
        side: sideOf(i, curBin),
        distance: i - curBin,
        swaps7,
        swaps24,
        volume7: b.token0.volumeFiat || 0,
        liquidity: liq,
        reserve: (b.token0.reserveFiat || 0) + (b.token1.reserveFiat || 0),
        mk7, mk24, pnl7,
        cooling: mk24 !== null && mk24 < 0,
        poolIdle24h,
        score,
        eligible: !reasons.length,
        reasons,
      };
    });
  }

  // APR you would earn on `x` dollars added to a bin that holds `liq` dollars: the bin's flow is shared with you.
  const dilutedApr = (score, liq, x) => (x > 0 ? (score * liq) / (liq + x) : score);

  // Pick bins on the side the user can fund and split `amountUsd` across them.
  //   have:  "token0" | "token1" | "both"
  //   mode:  "spread" — top `count` bins, weights ∝ score; "max" — water-fill by marginal diluted APR
  function plan(rows, { amountUsd, have, count = 3, mode = "spread", skipNearCurrent = DEFAULTS.skipNearCurrent }) {
    const fundable = rows.filter((r) =>
      r.eligible &&
      (have === "both" || r.side === have) &&
      Math.abs(r.distance) > skipNearCurrent);
    const top = [...fundable].sort((a, b) => b.score - a.score).slice(0, Math.max(1, count));
    if (!top.length || !(amountUsd > 0)) return { bins: [], aprBps: null, weeklyUsd: 0 };

    const alloc = new Map(top.map((r) => [r.bin, 0]));
    if (mode === "max") {
      const steps = 400, dx = amountUsd / steps;
      for (let s = 0; s < steps; s++) {
        let best = null, bestGain = -Infinity;
        for (const r of top) {
          const a = alloc.get(r.bin);
          const gain = r.score * r.liquidity * r.liquidity / ((r.liquidity + a) * (r.liquidity + a));
          if (gain > bestGain) { bestGain = gain; best = r; }
        }
        alloc.set(best.bin, alloc.get(best.bin) + dx);
      }
    } else {
      const total = top.reduce((s, r) => s + r.score, 0);
      for (const r of top) alloc.set(r.bin, (amountUsd * r.score) / total);
    }

    const bins = top
      .map((r) => {
        const usd = alloc.get(r.bin);
        return { ...r, usd, share: usd / amountUsd, effAprBps: dilutedApr(r.score, r.liquidity, usd) };
      })
      .filter((r) => r.usd > 0)
      .sort((a, b) => a.bin - b.bin);
    const yearly = bins.reduce((s, r) => s + (r.usd * r.effAprBps) / 1e4, 0);
    return { bins, aprBps: (yearly / amountUsd) * 1e4, weeklyUsd: yearly / 52 };
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

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  const api = {
    chains: () => getJson(`${API}/chains`).then((d) => d.chains),
    pools: (chainId) =>
      getJson(`${API}/evm/${chainId}/metadata?count=500&sortBy=tvl&include24h=true&minTvlFiat=1000`).then((d) => d.data),
    pool: (chainId, address) =>
      getJson(`${API}/evm/${chainId}/metadata?include24h=true&addresses=${address}`).then((d) => d.data[0] || null),
    bins: (chainId, address, period) =>
      getJson(`${API}/evm/${chainId}/${address}/analytics/bins?period=${period}&fiat=USD`),
  };

  const BinPicker = { API, DEFAULTS, binEdges, sideOf, scoreBins, dilutedApr, plan, poolWarnings, api };
  if (typeof module !== "undefined" && module.exports) module.exports = BinPicker;
  else root.BinPicker = BinPicker;
})(typeof window !== "undefined" ? window : globalThis);
