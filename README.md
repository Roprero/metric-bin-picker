# Bin Picker for Metric

Pick the [Metric](https://app.metric.xyz) bins that actually earn. Choose a pool, the token you hold and how much,
and Bin Picker ranks every bin on your side by its recent markout and tells you which bins to click and how to split.

Static site: two files (`index.html`, `core.js`), no build step, no backend. The browser calls the Metric API directly.

## How bins are scored

Pick a **markout window** (24h, 7d, 30d, All) and **horizon** (1m, 5m, 30m), the same settings as the Metric app.
For each bin:

- **score** = 0.6 × markout APR over the window + 0.4 × markout APR over the last 24h, minus ¼ of a negative trading-PnL APR
  over the window. With the 24h window the score is the 24h markout alone;
- a bin is skipped when it had too few swaps in the window (15 for 24h, 100 for 7d, 300 for 30d and All), no swaps in the
  last 24h (unless the whole pool was idle, e.g. a closed stock market), or too little liquidity for its APR to mean
  anything (under $1,000 or 2% of the largest bin);
- only bins you can fund are offered: above the active bin they take token0, below it token1. The active bin and the bin
  right next to it are skipped, because the pool moves while you click and they flip sides;
- your own deposit dilutes a bin: you get `score × L / (L + x)` on `x` dollars added to a bin holding `L`.

## Strategies

| Strategy | Picks | Splits |
|---|---|---|
| Top score | best-scoring bins | in proportion to score |
| Max APR | best-scoring bins | water-fill by APR after your own dilution (matters for large deposits) |
| Flat | best-scoring bins | equally |
| Volume pro-rata | best-scoring bins | in proportion to the volume that crossed them |
| Spot | closest earning bins to the price | equally |
| Curve | closest earning bins | most weight next to the price (1/rank) |
| Bid-Ask | closest earning bins | most weight on the far bins (rank) |

Losing, stale and thin bins are never picked, whatever the strategy. Markout is a past measurement, not a forecast.
Read the pool's tier and warnings before depositing.

## Data

| Endpoint | Used for |
|---|---|
| `GET /public/v1/chains` | chain list |
| `GET /public/v1/evm/{chain}/metadata` | pools, tier, curator, fees, pool markout |
| `GET /public/v1/evm/{chain}/{pool}/analytics/bins?period=24h\|7d\|30d\|all&fiat=USD` | per-bin swaps, volume, liquidity, markout, trading PnL |

The per-bin endpoint is the one the Metric app itself uses. It is public (no key, CORS `*`) but not in the API docs,
so it may change without notice.

## Run

```bash
python3 -m http.server 8765   # then open http://127.0.0.1:8765
node test/core.test.js         # unit tests on synthetic bins
node test/core.test.js --live  # plus every window × horizon × strategy on live pools
```

Deploy anywhere that serves static files: GitHub Pages, Cloudflare Pages, Vercel.

## URL parameters

`?chain=1&pool=0x…&amt=1000&have=token0|token1|both&n=3&s=score|max|flat|volume|spot|curve|bidask&w=24h|7d|30d|all&h=1m|5m|30m` — every plan is a shareable link.

Not affiliated with Metric.
