# Bin Picker for Metric

Pick the [Metric](https://app.metric.xyz) bins that actually earn. Choose a pool, the token you hold and how much,
and Bin Picker ranks every bin on your side by its recent markout and tells you which bins to click and how to split.

Static site: two files (`index.html`, `core.js`), no build step, no backend. The browser calls the Metric API directly.

## How bins are scored

For each bin, from the last 7 days and the last 24 hours:

- **score** = 0.6 × 7d markout APR + 0.4 × 24h markout APR (5-minute horizon), minus ¼ of a negative 7d trading-PnL APR;
- a bin is skipped when it had under 100 swaps in 7d, no swaps in the last 24h (unless the whole pool was idle,
  e.g. a closed stock market), or too little liquidity for its APR to mean anything (under $1,000 or 2% of the largest bin);
- only bins you can fund are offered: above the active bin they take token0, below it token1. The active bin and the bin
  right next to it are skipped, because the pool moves while you click and they flip sides;
- your own deposit dilutes a bin: you get `score × L / (L + x)` on `x` dollars added to a bin holding `L`.

**Spread** splits the amount across the top bins in proportion to their score. **Max** water-fills it by marginal
APR after dilution, which matters only for deposits that are large next to a bin's liquidity.

Markout is a past measurement, not a forecast. Read the pool's tier and warnings before depositing.

## Data

| Endpoint | Used for |
|---|---|
| `GET /public/v1/chains` | chain list |
| `GET /public/v1/evm/{chain}/metadata` | pools, tier, curator, fees, pool markout |
| `GET /public/v1/evm/{chain}/{pool}/analytics/bins?period=7d\|24h&fiat=USD` | per-bin swaps, volume, liquidity, markout, trading PnL |

The per-bin endpoint is the one the Metric app itself uses. It is public (no key, CORS `*`) but not in the API docs,
so it may change without notice.

## Run

```bash
python3 -m http.server 8765   # then open http://127.0.0.1:8765
node test/core.test.js         # unit tests on synthetic bins
node test/core.test.js --live  # plus a check against a live pool
```

Deploy anywhere that serves static files: GitHub Pages, Cloudflare Pages, Vercel.

## URL parameters

`?chain=1&pool=0x…&amt=1000&have=token0|token1|both&n=3&mode=spread|max` — every plan is a shareable link.

Not affiliated with Metric.
