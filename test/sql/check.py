#!/usr/bin/env python3
"""python3 test/sql/check.py [snapshot.json] — recompute Bin Picker in SQLite from raw Metric data and compare with core.js.

Run after test/sql/snapshot.js. Exits 1 on any mismatch. Also checks the data means what the model assumes:
a bin's markout APR is its markout dollars over its average liquidity, and the bins add up to the pool's own markout APR.
"""
import json, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
snap = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "snapshot.json")))
db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE pool(pid INTEGER PRIMARY KEY, chain INT, addr TEXT, pair TEXT, cur_bin INT, pool_mk5m_7d REAL);
CREATE TABLE bin(pid INT, period TEXT, bin INT, swaps INT, length_e6 INT, liq0 REAL, liq1 REAL, res0 REAL, res1 REAL,
  vol0 REAL, vol1 REAL, mk5m REAL, mkfiat5m REAL, mkvol5m REAL, pnl REAL);
CREATE TABLE app_row(pid INT, bin INT, e0 REAL, e1 REAL, side TEXT, liquidity REAL, volume REAL, score REAL, eligible INT);
CREATE TABLE app_plan(planid INTEGER PRIMARY KEY, pid INT, strategy TEXT, have TEXT, amt REAL, apr_bps REAL, weekly REAL);
CREATE TABLE app_plan_bin(planid INT, bin INT, usd REAL, eff_apr REAL, bin_share REAL);
""")
for pid, p in enumerate(snap):
    mk = (((p["meta"].get("markoutByWindow") or {}).get("7d") or {}).get("byHorizon") or {}).get("5m", {}).get("aprBps")
    db.execute("INSERT INTO pool VALUES(?,?,?,?,?,?)", (pid, p["chain"], p["addr"], p["pair"], p["curBin"], mk))
    for period, src in (("7d", p["main"]), ("24h", p["day"])):
        for b in src["bins"]:
            h = b["markoutByHorizon"]["5m"]
            t0, t1 = b["token0"], b["token1"]
            db.execute("INSERT INTO bin VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (pid, period, int(b["bin"]), int(b["swapCount"]), b["lengthE6"],
                t0["avgLiquidityFiat"] or 0, t1["avgLiquidityFiat"] or 0, t0["reserveFiat"] or 0, t1["reserveFiat"] or 0,
                t0["volumeFiat"] or 0, t1["volumeFiat"] or 0, h["aprBps"], h["markoutFiat"], h["volumeFiat"], b["pnlAprBps"]))
    for r in p["app"]["rows"]:
        db.execute("INSERT INTO app_row VALUES(?,?,?,?,?,?,?,?,?)", (pid, r["bin"], r["e0"], r["e1"], r["side"], r["liquidity"], r["volume"], r["score"], int(r["eligible"])))
    for pl in p["app"]["plans"]:
        c = db.execute("INSERT INTO app_plan(pid,strategy,have,amt,apr_bps,weekly) VALUES(?,?,?,?,?,?)",
                       (pid, pl["strategy"], pl["have"], pl["amt"], pl["aprBps"], pl["weeklyUsd"]))
        for b in pl["bins"]:
            db.execute("INSERT INTO app_plan_bin VALUES(?,?,?,?,?)", (c.lastrowid, b["bin"], b["usd"], b["effAprBps"], b["binShare"]))
for f in ("score.sql", "plan.sql"):
    db.executescript(open(os.path.join(HERE, f)).read())

fails = []
def check(name, sql, expect_zero):
    row = db.execute(sql).fetchone()
    cols = [d[0] for d in db.execute(sql).description]
    vals = dict(zip(cols, row))
    bad = {k: v for k, v in vals.items() if k in expect_zero and v}
    print(("FAIL " if bad else "ok   ") + name + ": " + ", ".join(f"{k}={v}" for k, v in vals.items()))
    if bad: fails.append(name)

check("bins: edges, side, liquidity now, volume, eligibility, score", """
SELECT COUNT(*) AS bins, SUM(s.eligible) AS eligible,
  SUM(ABS(e.e0 - a.e0) > 1e-9 OR ABS(e.e1 - a.e1) > 1e-9) AS edge_diff, SUM(s.side <> a.side) AS side_diff,
  SUM(ABS(s.liq - a.liquidity) > 1e-6) AS liq_diff, SUM(ABS(s.volume - a.volume) > 1e-6) AS vol_diff,
  SUM(s.eligible <> a.eligible) AS elig_diff, SUM(s.eligible AND ABS(s.score - a.score) > 1e-6) AS score_diff
FROM sql_row s JOIN app_row a USING (pid, bin) JOIN sql_edges e USING (pid, bin)""",
      {"edge_diff", "side_diff", "liq_diff", "vol_diff", "elig_diff", "score_diff"})

check("plans: APR, weekly dollars, bins, amount adds up", """
SELECT COUNT(*) AS plans, SUM(s.nbins = 0) AS empty,
  SUM(CASE WHEN s.apr_bps IS NULL AND a.apr_bps IS NULL THEN 0 WHEN s.apr_bps IS NULL OR a.apr_bps IS NULL THEN 1
           ELSE ABS(s.apr_bps - a.apr_bps) > 1e-6 END) AS apr_diff,
  SUM(ABS(COALESCE(s.weekly, 0) - a.weekly) > 1e-6) AS weekly_diff,
  SUM(s.nbins <> (SELECT COUNT(*) FROM app_plan_bin x WHERE x.planid = a.planid)) AS nbins_diff,
  SUM(s.nbins > 0 AND ABS(s.total - a.amt) > 1e-6) AS sum_ne_amount
FROM sql_plan s JOIN app_plan a USING (planid)""", {"apr_diff", "weekly_diff", "nbins_diff", "sum_ne_amount"})

check("plan bins: dollars, diluted APR, share of the bin", """
SELECT COUNT(*) AS bins, SUM(sb.bin IS NULL) AS missing,
  SUM(ABS(sb.usd - ab.usd) > 1e-6) AS usd_diff, SUM(ABS(sb.eff_apr - ab.eff_apr) > 1e-6) AS eff_diff,
  SUM(ABS(sb.bin_share - ab.bin_share) > 1e-12) AS share_diff
FROM app_plan_bin ab LEFT JOIN sql_plan_bin sb USING (planid, bin)""", {"missing", "usd_diff", "eff_diff", "share_diff"})

# The model's premise: APR = markout dollars, annualised, over average liquidity (ratio ≈ 1 for every pool)
check("premise: bin APR is markout $ over average liquidity", """
SELECT COUNT(*) AS bins, ROUND(MIN(r), 3) AS ratio_min, ROUND(MAX(r), 3) AS ratio_max,
  SUM(ABS(r - 1) > 0.1) AS off_by_10pct
FROM (SELECT mk5m / (mkfiat5m / (liq0 + liq1) * 365.0 / 7 * 1e4) AS r FROM bin
      WHERE period = '7d' AND mkfiat5m <> 0 AND liq0 + liq1 > 1000 AND mk5m IS NOT NULL)""", {"off_by_10pct"})

for (pair, metric, ours) in db.execute("""
  SELECT p.pair, p.pool_mk5m_7d / 100.0, SUM(b.mkfiat5m) / SUM(b.liq0 + b.liq1) * 365.0 / 7 * 100
  FROM bin b JOIN pool p USING (pid) WHERE b.period = '7d' GROUP BY p.pid"""):
    print(f"info pool markout 7d/5m {pair}: Metric {metric:.2f}%, sum of bins {ours:.2f}%")

print(f"{'FAILED: ' + ', '.join(fails) if fails else 'SQL check passed'}")
sys.exit(1 if fails else 0)
