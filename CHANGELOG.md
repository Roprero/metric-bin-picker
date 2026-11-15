# Changelog

## 0.7.0

- Fix: expected APR was overstated. The API's markout APR is measured on a bin's average liquidity over the window, but a new
  deposit shares the flow with the liquidity in the bin today, which is often much higher in bins that earned well. Bins are
  now scored and diluted on today's liquidity (`reserveFiat`): on a snapshot of four large pools the expected APR fell by up
  to 40% where liquidity had grown (BNB Chain USDC/USDT, USDT side: 86% → 53%), and one plan moved by a bin.
- Bins that are empty right now are no longer offered; the thin-bin check uses today's liquidity.
- Volume pro-rata uses the volume the markout was measured on (token0 volume read a few percent low).
- New independent check: `npm run test:sql` recomputes edges, eligibility, scores and every plan in SQLite from a raw API
  snapshot and compares with the app to the cent; it also checks the premise that bin APR = markout dollars ÷ average
  liquidity. Runs daily in CI.

## 0.6.0

- Four steps instead of one crowded screen: pool, your side and amount, how to split, your plan. Every step shows its
  choice in the rail and can be reopened; a shared link opens straight on the plan.
- The ladder stays in view beside every step: your side lights up while you choose a token, and your orders pour into
  their bins when the plan changes. The plan's APR counts to its new value.
- Pools are cards with a tier dot, TVL and 24h volume, plus a search box.
- Share card: a picture of the plan for X, with Post on X, Download and Copy.
- A stalled request now fails after 20 seconds with a clear message and a Try again button, instead of loading forever
  (some networks freeze traffic to Cloudflare, which hosts the Metric API).
- Two more browser tests: the wizard opens on the plan from a shared link, and on the pool list on a first visit.

## 0.5.0

- Redesign as an order-book ladder: one row per bin by price, the current price as a line, your plan as yellow orders.
  Select a row for its numbers. Strategies are picked by their drawn shape.
- The plan panel comes first on phones; skip link, keyboard-reachable rows, reduced motion respected.
- Two more browser tests: the ladder matches the plan, the strategy in the link is selected.

## 0.4.0

- Faster: parallel first load, a one-minute response cache, background fetch of the other windows. Link to plan 1875 → 895 ms;
  horizon switch 349 → 27 ms; window switch 392 → 23 ms.
- The page shows how long the plan took to load.

## 0.3.0

- Approximate price range for every bin (tooltip, plan, table) and the pool's reference price. Asked for in #feedback.
- Pool filters: minimum TVL, minimum 24h volume, tier. Asked for in #feedback.
- The plan shows the part of each bin you would own after depositing.
- "How to read these numbers" explains markout APR vs trading PnL with a live example from the selected pool.
- A bin that lost money over the chosen window is never picked, even after a good last 24h.
- Ties break the same way every time, so the same data always gives the same plan.
- Tests: 24 scenario tests, 6 headless-browser tests, CI and GitHub Pages deploy.

## 0.2.0

- Markout window (24h, 7d, 30d, All) and horizon (1m, 5m, 30m), the same settings as the Metric app.
- Seven strategies: Top score, Max APR, Flat, Volume pro-rata, Spot, Curve, Bid-Ask.

## 0.1.0

- First version: per-bin scoring on 7d and 24h markout, side-aware picks, dilution, shareable links.
