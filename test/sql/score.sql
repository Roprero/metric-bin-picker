-- Independent recomputation of core.js in SQL: bin edges, eligibility and the forward score (window 7d, horizon 5m).
-- Same rules as README "How bins are scored"; written from the rules, not from the code.

-- Bin edges in % from the reference: bins >= 0 stack up from 0, bins < 0 stack down from 0
DROP VIEW IF EXISTS sql_edges;
CREATE VIEW sql_edges AS
WITH w AS (SELECT pid, bin, length_e6 / 1e4 AS w FROM bin WHERE period = '7d')
SELECT pid, bin,
  CASE WHEN bin >= 0 THEN COALESCE(SUM(w) OVER (PARTITION BY pid, bin >= 0 ORDER BY bin ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
       ELSE -SUM(w) OVER (PARTITION BY pid, bin >= 0 ORDER BY bin DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) END AS e0,
  CASE WHEN bin >= 0 THEN SUM(w) OVER (PARTITION BY pid, bin >= 0 ORDER BY bin ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
       ELSE -COALESCE(SUM(w) OVER (PARTITION BY pid, bin >= 0 ORDER BY bin DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) END AS e1
FROM w;

-- Eligibility and score.
--   flow  = markout dollars a year: 0.6 × (7d APR × 7d average liquidity) + 0.4 × (24h APR × 24h average liquidity),
--           plus ¼ of a negative trading-PnL APR × 7d average liquidity
--   score = flow / liquidity in the bin now (reserve), in bps
DROP VIEW IF EXISTS sql_row;
CREATE VIEW sql_row AS
WITH m AS (SELECT * FROM bin WHERE period = '7d'),
d AS (SELECT * FROM bin WHERE period = '24h'),
pl AS (SELECT p.pid, p.cur_bin,
         MAX(1000.0, 0.02 * (SELECT MAX(res0 + res1) FROM m WHERE m.pid = p.pid)) AS min_liq,
         (SELECT COUNT(*) FROM d WHERE d.pid = p.pid AND d.swaps > 0) = 0 AS idle
       FROM pool p),
j AS (
  SELECT m.pid, m.bin, pl.cur_bin, pl.min_liq, pl.idle,
    m.swaps, COALESCE(d.swaps, 0) AS swaps24,
    m.liq0 + m.liq1 AS liq_avg, COALESCE(d.liq0 + d.liq1, 0) AS liq24, m.res0 + m.res1 AS liq_now,
    CASE WHEN m.mkvol5m > 0 THEN m.mkvol5m ELSE MAX(m.vol0, m.vol1) END AS volume,
    m.mk5m AS mk_main, CASE WHEN COALESCE(d.swaps, 0) > 0 THEN d.mk5m END AS mk_day, m.pnl
  FROM m JOIN pl USING (pid) LEFT JOIN d ON d.pid = m.pid AND d.bin = m.bin),
k AS (
  SELECT *,
    (swaps >= 100) AND NOT (NOT idle AND swaps24 = 0) AND mk_main IS NOT NULL AND mk_main > 0
      AND liq_avg > 0 AND liq_now > 0 AND liq_now >= min_liq AS pass
  FROM j),
f AS (
  SELECT *, CASE WHEN pass THEN
      (CASE WHEN mk_day IS NULL OR liq24 <= 0 THEN mk_main / 1e4 * liq_avg
            ELSE 0.6 * mk_main / 1e4 * liq_avg + 0.4 * mk_day / 1e4 * liq24 END)
      + (CASE WHEN pnl IS NOT NULL AND pnl < 0 THEN 0.25 * pnl / 1e4 * liq_avg ELSE 0 END) END AS flow
  FROM k)
SELECT pid, bin, cur_bin, bin - cur_bin AS distance,
  CASE WHEN bin > cur_bin THEN 'token0' WHEN bin < cur_bin THEN 'token1' ELSE 'both' END AS side,
  liq_now AS liq, liq_avg, volume, mk_main, mk_day, pnl,
  CASE WHEN pass AND flow > 0 THEN flow / liq_now * 1e4 END AS score,
  (pass AND flow > 0) AS eligible
FROM f;
