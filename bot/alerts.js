// Alert rules for the Metric alerts bot. Pure functions over API payloads: no network, no Telegram, no clock of their own.
"use strict";

const CHAINS = { 1: "Ethereum", 56: "BNB Chain", 4663: "Robinhood" };
const FAR_BINS = 10;            // with no per-bin analytics, a position this many bins from the price counts as not trading
const MIN_AGE_MARKOUT = 86400;  // a position younger than a day has too few trades for its markout to mean anything
const COOLDOWN = 3600;          // after an alert ends, the same alert is not sent again within this many seconds
const OFF_POLLS = 2;            // an alert ends only after this many polls in a row without the condition (no flapping)
const TIER_RANK = { green: 0, yellow: 1, unclassified: 1, red: 2 };

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const usd = (x) => (Number.isFinite(x) ? `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "–");
const chainName = (id) => CHAINS[Number(id)] || `chain ${id}`;
const poolKey = (chainId, address) => `${Number(chainId)}:${String(address).toLowerCase()}`;
const poolLink = (chainId, address) => `https://app.metric.xyz/pool/${Number(chainId)}/${address}`;
const tierOf = (meta) => (meta && meta.classificationSummary && meta.classificationSummary.tierQualification) || "unclassified";

// Bins the position still holds something in, sorted.
function heldBins(pos) {
  return (pos.bins || [])
    .filter((b) => { try { return BigInt(b.token0Amount || 0) > 0n || BigInt(b.token1Amount || 0) > 0n; } catch { return false; } })
    .map((b) => Number(b.binIdx)).sort((a, b) => a - b);
}
const binList = (bins) => bins.map((b) => `#${b}`).join(", ");
const markout5m = (pos) => {
  const m = pos.performance && pos.performance.markoutByPeriod && pos.performance.markoutByPeriod["7d"];
  const v = m && m.byHorizon && m.byHorizon["5m"] && m.byHorizon["5m"].apr;
  return Number.isFinite(v) ? v : null;
};
const pnlApr = (pos) => {
  const v = pos.performance && pos.performance.aprByPeriod && pos.performance.aprByPeriod["7d"] && pos.performance.aprByPeriod["7d"].pnlApr;
  return Number.isFinite(v) ? v : null;
};

// Conditions on one position. `bins24h` is /analytics/bins?period=24h for the pool, or null when that endpoint is down.
// Each condition: { key, active, on, off } — `on` is sent when it starts, `off` when it ends.
function positionConditions(pos, meta, bins24h, now) {
  const held = heldBins(pos);
  if (!held.length || !meta) return [];
  const pair = esc(meta.pair);
  const cur = Number(meta.curBinIdx);
  const nearest = Math.min(...held.map((b) => Math.abs(b - cur)));
  const out = [];

  let idle;
  if (bins24h && Array.isArray(bins24h.bins)) {
    const swaps = new Map(bins24h.bins.map((b) => [Number(b.bin), Number(b.swapCount) || 0]));
    const poolTraded = [...swaps.values()].some((s) => s > 0);
    idle = poolTraded && held.every((b) => !(swaps.get(b) > 0)); // a quiet pool (closed stock market) is not your bins' fault
  } else {
    idle = nearest > FAR_BINS;
  }
  out.push({
    key: `pos:${pos.id}:idle`,
    active: idle,
    on: `<b>${pair}</b>: your bins ${binList(held)} had no swaps in the last 24h. The price is in bin #${cur}, ${nearest} bin${nearest === 1 ? "" : "s"} from your closest one. They earn nothing until the price comes back or you move them.`,
    off: `<b>${pair}</b>: your bins ${binList(held)} are trading again.`,
  });

  const mk = markout5m(pos);
  const opened = Number(pos.performance && pos.performance.openedAtTimestamp) || 0;
  out.push({
    key: `pos:${pos.id}:markout`,
    active: mk !== null && mk < 0 && now - opened >= MIN_AGE_MARKOUT,
    on: `<b>${pair}</b>: your position's 5m markout over 7d is <b>${pct(mk)}</b> APR. Trades through your bins are worth less 5 minutes later, so traders are picking them off. Bins further from the price usually do better.`,
    off: `<b>${pair}</b>: your 5m markout is back to ${pct(mk)} APR.`,
  });
  return out;
}

// What we remember about a pool between polls, to spot changes.
function poolSnapshot(meta) {
  const cs = meta.classificationSummary || {};
  return {
    adminFeeE6: Number(meta.spreadAdminFeeE6) || 0,
    protocolFeeE6: Number(meta.spreadProtocolFeeE6) || 0,
    tier: tierOf(meta),
    reasons: [...(cs.reasonCodes || [])].sort(),
  };
}

// One-off events: something about the pool changed since the last poll. No event on the first sight of a pool.
function poolEvents(prev, meta) {
  if (!prev) return [];
  const now = poolSnapshot(meta);
  const pair = esc(meta.pair);
  const ev = [];
  const share = (e6) => `${(e6 / 1e4).toFixed(e6 % 1e4 ? 1 : 0)}%`;
  if (now.adminFeeE6 !== prev.adminFeeE6 || now.protocolFeeE6 !== prev.protocolFeeE6) {
    const parts = [];
    if (now.adminFeeE6 !== prev.adminFeeE6) parts.push(`curator ${share(prev.adminFeeE6)} → <b>${share(now.adminFeeE6)}</b>`);
    if (now.protocolFeeE6 !== prev.protocolFeeE6) parts.push(`Metric ${share(prev.protocolFeeE6)} → <b>${share(now.protocolFeeE6)}</b>`);
    const more = now.adminFeeE6 + now.protocolFeeE6 > prev.adminFeeE6 + prev.protocolFeeE6;
    ev.push({ key: "fees", text: `<b>${pair}</b>: the share of the spread taken from LPs changed: ${parts.join(", ")}. ${more ? "You now keep less of what your bins earn." : "You now keep more of what your bins earn."} There is no timelock on this.` });
  }
  if ((TIER_RANK[now.tier] ?? 1) > (TIER_RANK[prev.tier] ?? 1)) {
    const added = now.reasons.filter((r) => !prev.reasons.includes(r));
    ev.push({ key: "tier", text: `<b>${pair}</b>: tier went <b>${esc(prev.tier)} → ${esc(now.tier)}</b>${added.length ? ` (${added.map(esc).join(", ")})` : ""}. Check the pool's risk before leaving liquidity in it.` });
  }
  return ev;
}

// Ongoing pool states that matter to anyone with liquidity in it.
function poolConditions(meta) {
  const pair = esc(meta.pair);
  const status = meta.priceProviderStatus;
  return [
    { key: "paused", active: !!meta.pauseLevel,
      on: `<b>${pair}</b> is <b>paused</b>. Your liquidity earns nothing until it reopens.`, off: `<b>${pair}</b> is no longer paused.` },
    { key: "feed", active: !!status && status !== "healthy",
      on: `<b>${pair}</b>: price feed is <b>${esc(status)}</b>. The pool stops quoting until the feed recovers.`, off: `<b>${pair}</b>: price feed is healthy again.` },
  ];
}

// The alert state machine. `entry` is what is stored for one chat and one condition key.
// Returns the new entry and what to send: "on", "off" or null. `silent` records the state without sending (first look).
function step(entry, active, now, silent = false) {
  const e = { active: false, offCount: 0, lastOn: null, notified: false, ...(entry || {}) };
  if (active) {
    e.offCount = 0;
    if (e.active) return { entry: e, send: null };
    e.active = true;
    if (silent || (e.lastOn !== null && now - e.lastOn < COOLDOWN)) { e.notified = false; return { entry: e, send: null }; }
    e.notified = true; e.lastOn = now;
    return { entry: e, send: "on" };
  }
  if (!e.active) return { entry: e, send: null };
  e.offCount += 1;
  if (e.offCount < OFF_POLLS) return { entry: e, send: null };
  const was = e.notified;
  e.active = false; e.offCount = 0; e.notified = false;
  return { entry: e, send: was && !silent ? "off" : null };
}

// A one-screen summary of a position, for /status and right after /watch.
function positionSummary(pos, meta) {
  const held = heldBins(pos);
  const p = pos.performance || {};
  const sides = new Set();
  for (const b of pos.bins || []) {
    try {
      if (BigInt(b.token0Amount || 0) > 0n) sides.add(meta.token0Symbol);
      if (BigInt(b.token1Amount || 0) > 0n) sides.add(meta.token1Symbol);
    } catch { /* skip junk */ }
  }
  return [
    `<b>${esc(meta.pair)}</b> on ${chainName(pos.chainId)}, ${esc(tierOf(meta))} tier`,
    `Value ${usd(p.currentValueFiat)}, bins ${binList(held) || "none"}${sides.size ? ` (${esc([...sides].join(" + "))})` : ""}, price in bin #${Number(meta.curBinIdx)}`,
    `Markout 5m, 7d: ${pct(markout5m(pos))} APR, trading PnL ${pct(pnlApr(pos))} APR, fees earned ${usd(p.feesEarnedFiat)}`,
    `<a href="${poolLink(pos.chainId, pos.poolAddress)}">Open in Metric</a>`,
  ].join("\n");
}

// What the user typed: a command and its argument, or a bare address. Also flags secrets pasted by mistake.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function looksSecret(text) {
  const t = String(text || "").trim();
  if (/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/.test(t)) return true; // private key
  const words = t.toLowerCase().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w)); // seed phrase
}
function parseCommand(text) {
  const t = String(text || "").trim();
  if (ADDRESS.test(t)) return { cmd: "watch", arg: t };
  const m = t.match(/^\/([a-z]+)(?:@\w+)?(?:\s+(\S+))?/i);
  return m ? { cmd: m[1].toLowerCase(), arg: m[2] || "" } : { cmd: "", arg: "" };
}

module.exports = {
  CHAINS, FAR_BINS, MIN_AGE_MARKOUT, COOLDOWN, OFF_POLLS, ADDRESS,
  esc, pct, usd, chainName, poolKey, poolLink, tierOf, heldBins, markout5m, pnlApr,
  positionConditions, poolSnapshot, poolEvents, poolConditions, step, positionSummary, looksSecret, parseCommand,
};
