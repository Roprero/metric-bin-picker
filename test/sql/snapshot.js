// node test/sql/snapshot.js [out.json] — one snapshot of the Metric API (raw per-bin data for a few pools) plus what core.js
// computes from that same snapshot. test/sql/check.py then recomputes everything in SQLite and compares.
const fs = require("fs");
const path = require("path");
const BP = require("../../core.js");

const OUT = process.argv[2] || path.join(__dirname, "snapshot.json");
const API = BP.API;
const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); });

(async () => {
  // the two largest pools by TVL on Ethereum and on BNB Chain
  const pools = [];
  for (const chain of [1, 56]) {
    const list = (await j(`${API}/evm/${chain}/metadata?count=2&sortBy=tvl&include24h=true&minTvlFiat=1000`)).data;
    for (const p of list) pools.push([chain, p.poolAddress]);
  }
  const out = [];
  for (const [chain, addr] of pools) {
    const [meta, main, day] = await Promise.all([
      j(`${API}/evm/${chain}/metadata?include24h=true&addresses=${addr}`).then((d) => d.data[0]),
      j(`${API}/evm/${chain}/${addr}/analytics/bins?period=7d&fiat=USD`),
      j(`${API}/evm/${chain}/${addr}/analytics/bins?period=24h&fiat=USD`),
    ]);
    const rows = BP.scoreBins(main.bins, day.bins, main.curBinIdx, { window: "7d", horizon: "5m" });
    const plans = [];
    for (const strategy of Object.keys(BP.STRATEGIES))
      for (const have of ["token0", "token1", "both"])
        for (const amt of [617, 50000]) {
          const p = BP.plan(rows, { amountUsd: amt, have, count: 3, strategy });
          plans.push({ strategy, have, amt, aprBps: p.aprBps, weeklyUsd: p.weeklyUsd,
            bins: p.bins.map((b) => ({ bin: b.bin, usd: b.usd, effAprBps: b.effAprBps, binShare: b.binShare })) });
        }
    out.push({ chain, addr, pair: meta.pair, curBin: main.curBinIdx, meta, main, day,
      app: {
        rows: rows.map((r) => ({ bin: r.bin, e0: r.edges && r.edges[0], e1: r.edges && r.edges[1], side: r.side, liquidity: r.liquidity,
          volume: r.volume, mkMain: r.mkMain, mkDay: r.mkDay, pnl: r.pnl, score: r.score, eligible: r.eligible })),
        plans,
      } });
    console.log(`snapshot ${chain} ${meta.pair}: ${main.bins.length} bins, active #${main.curBinIdx}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
