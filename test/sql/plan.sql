-- Plans in SQL: pick bins per strategy, split the amount, dilute each bin by your own deposit. Max APR replays the greedy fill.
-- 3. Отбор бинов в план: своя сторона, не ближе 1 к активному, топ-3 по правилу стратегии
DROP TABLE IF EXISTS sql_top;
CREATE TABLE sql_top AS
WITH f AS (
  SELECT ap.planid, ap.strategy, ap.amt, r.*,
    ROW_NUMBER() OVER (PARTITION BY ap.planid ORDER BY
      CASE WHEN ap.strategy IN ('spot','curve','bidask') THEN ABS(r.distance) ELSE -r.score END,
      CASE WHEN ap.strategy IN ('spot','curve','bidask') THEN -r.score ELSE ABS(r.distance) END,
      r.bin) AS pos
  FROM app_plan ap JOIN sql_row r ON r.pid = ap.pid
  WHERE r.eligible AND (ap.have = 'both' OR r.side = ap.have) AND ABS(r.distance) > 1)
SELECT *, ROW_NUMBER() OVER (PARTITION BY planid ORDER BY ABS(distance), pos) AS rnk FROM f WHERE pos <= 3;

-- 4a. Распределение по весам (все стратегии, кроме max)
DROP TABLE IF EXISTS sql_alloc;
CREATE TABLE sql_alloc AS
WITH w AS (
  SELECT *, CASE strategy WHEN 'score' THEN score WHEN 'flat' THEN 1.0 WHEN 'spot' THEN 1.0
             WHEN 'volume' THEN MAX(volume, 1e-9) WHEN 'curve' THEN 1.0 / rnk WHEN 'bidask' THEN 1.0 * rnk END AS wt
  FROM sql_top WHERE strategy <> 'max')
SELECT planid, bin, score, liq, amt * wt / SUM(wt) OVER (PARTITION BY planid) AS usd FROM w;

-- 4b. Max APR: жадный налив 400 шагов, каждый шаг в бин с наибольшим предельным доходом s·L²/(L+a)²
--     (при равенстве — бин, стоящий раньше в топе, как в приложении)
DROP TABLE IF EXISTS piv;
CREATE TABLE piv AS
SELECT planid, MAX(amt) AS amt,
  MAX(CASE pos WHEN 1 THEN score END) s1, MAX(CASE pos WHEN 1 THEN liq END) l1,
  MAX(CASE pos WHEN 2 THEN score END) s2, MAX(CASE pos WHEN 2 THEN liq END) l2,
  MAX(CASE pos WHEN 3 THEN score END) s3, MAX(CASE pos WHEN 3 THEN liq END) l3
FROM sql_top WHERE strategy = 'max' GROUP BY planid;
WITH RECURSIVE g(planid, k, a1, a2, a3) AS (
  SELECT planid, 0, 0.0, 0.0, 0.0 FROM piv
  UNION ALL
  SELECT g.planid, g.k + 1,
    g.a1 + CASE WHEN (CASE WHEN (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))), -1e300) AND (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 1
               WHEN (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) IS NOT NULL AND (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 2 ELSE 3 END) = 1 THEN p.amt / 400.0 ELSE 0 END,
    g.a2 + CASE WHEN (CASE WHEN (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))), -1e300) AND (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 1
               WHEN (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) IS NOT NULL AND (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 2 ELSE 3 END) = 2 THEN p.amt / 400.0 ELSE 0 END,
    g.a3 + CASE WHEN (CASE WHEN (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))), -1e300) AND (p.s1 * p.l1 * p.l1 / ((p.l1 + g.a1) * (p.l1 + g.a1))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 1
               WHEN (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) IS NOT NULL AND (p.s2 * p.l2 * p.l2 / ((p.l2 + g.a2) * (p.l2 + g.a2))) >= COALESCE((p.s3 * p.l3 * p.l3 / ((p.l3 + g.a3) * (p.l3 + g.a3))), -1e300) THEN 2 ELSE 3 END) = 3 THEN p.amt / 400.0 ELSE 0 END
  FROM g JOIN piv p ON p.planid = g.planid
  WHERE g.k < 400)
INSERT INTO sql_alloc
SELECT t.planid, t.bin, t.score, t.liq, CASE t.pos WHEN 1 THEN g.a1 WHEN 2 THEN g.a2 ELSE g.a3 END
FROM sql_top t JOIN g ON g.planid = t.planid AND g.k = 400 WHERE t.strategy = 'max';

-- 5. APR с учётом размытия и итог плана
DROP VIEW IF EXISTS sql_plan_bin;
CREATE VIEW sql_plan_bin AS
SELECT planid, bin, usd, score * liq / (liq + usd) AS eff_apr, usd / (liq + usd) AS bin_share FROM sql_alloc WHERE usd > 0;
DROP VIEW IF EXISTS sql_plan;
CREATE VIEW sql_plan AS
SELECT ap.planid, SUM(b.usd * b.eff_apr / 1e4) / ap.amt * 1e4 AS apr_bps, SUM(b.usd * b.eff_apr / 1e4) / 52 AS weekly, SUM(b.usd) AS total, COUNT(b.bin) AS nbins
FROM app_plan ap LEFT JOIN sql_plan_bin b USING (planid) GROUP BY ap.planid;
