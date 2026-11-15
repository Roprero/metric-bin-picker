# Changelog

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
