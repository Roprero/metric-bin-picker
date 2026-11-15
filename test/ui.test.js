// node test/ui.test.js — opens the page in headless Chrome for several shareable links and checks what renders.
// Needs network (the page calls the Metric API) and Chrome/Chromium; skips cleanly when Chrome is missing.
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CHROME = [process.env.CHROME, "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((p) => p && fs.existsSync(p));
if (!CHROME) { console.log("skip: no Chrome found (set CHROME=/path/to/chrome)"); process.exit(0); }

const USDC_USDT = "0xaef2ad7aBB651945e6D24276715f25BDED0ad41e";
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : req.url.split("?")[0]);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// Async on purpose: a sync spawn would block the event loop and the server above could not answer Chrome.
function dom(url) {
  return new Promise((resolve, reject) => {
    const p = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=25000", "--dump-dom", url],
      { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Chrome timed out")); }, 90000);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => { clearTimeout(timer); resolve(out); });
    p.on("error", reject);
  });
}

const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const planBins = (html) => {
  const m = html.match(/Click bins <b>([^<]*)<\/b>/);
  return m ? m[1].split(",").map((s) => Number(s.trim().replace("#", ""))) : [];
};

const SCENARIOS = [
  {
    name: "default link: USDC/USDT, USDC side, 3 bins → a plan, all bins above the active one",
    q: `?chain=1&pool=${USDC_USDT}&amt=617&have=token0&n=3`,
    check: (h, txt) => {
      const bins = planBins(h), cur = Number((txt.match(/active bin #(-?\d+)/) || [])[1]);
      if (bins.length < 1 || bins.length > 3) throw new Error(`plan bins: ${bins}`);
      if (!bins.every((b) => b > cur + 1)) throw new Error(`bins ${bins} not above active #${cur}`);
      for (const s of ["Your plan", "expected APR", "≈ Price", "you'd own", "Reference"]) if (!txt.includes(s)) throw new Error(`missing "${s}"`);
    },
  },
  {
    name: "USDT side → every planned bin is below the active one",
    q: `?chain=1&pool=${USDC_USDT}&amt=1000&have=token1&n=3`,
    check: (h, txt) => {
      const bins = planBins(h), cur = Number((txt.match(/active bin #(-?\d+)/) || [])[1]);
      if (bins.length && !bins.every((b) => b < cur - 1)) throw new Error(`bins ${bins} not below active #${cur}`);
    },
  },
  {
    name: "Curve 30d/1m: labels follow the window and horizon, hint names the strategy",
    q: `?chain=1&pool=${USDC_USDT}&amt=617&have=token0&n=4&s=curve&w=30d&h=1m`,
    check: (h, txt) => {
      for (const s of ["Markout 1m · 30d", "Volume 30d", "most weight next to the price", "drag each bar"]) if (!txt.includes(s)) throw new Error(`missing "${s}"`);
    },
  },
  {
    name: "24h window and 30m horizon load",
    q: `?chain=1&pool=${USDC_USDT}&amt=617&have=token0&n=2&w=24h&h=30m`,
    check: (h, txt) => { if (!txt.includes("Markout 30m · 24h")) throw new Error("24h/30m labels missing"); },
  },
  {
    name: "pool filter green only on BSC: every listed pool is green",
    q: `?chain=56&fr=green`,
    check: (h, txt) => {
      const opts = [...h.matchAll(/<option value="0x[^"]+">([^<]+)<\/option>/g)].map((m) => m[1]);
      if (!opts.length && !txt.includes("No pool matches")) throw new Error("no pools and no empty-state message");
      const bad = opts.filter((o) => !o.includes("· green ·"));
      if (bad.length) throw new Error(`non-green pools listed: ${bad.slice(0, 2)}`);
    },
  },
  {
    name: "explainer is on the page",
    q: `?chain=1&pool=${USDC_USDT}`,
    check: (h, txt) => { if (!txt.includes("How to read these numbers")) throw new Error("explainer missing"); },
  },
];

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  let ok = 0; const failed = [];
  for (const s of SCENARIOS) {
    try {
      const h = await dom(base + s.q);
      const txt = text(h);
      if (/Error:/.test((txt.match(/Updated[^·]*|Error:[^.]*/) || [""])[0])) throw new Error(txt.match(/Error:[^.]*/)[0]);
      s.check(h, txt);
      ok++; console.log("ok", s.name);
    } catch (e) { failed.push(s.name); console.log("FAIL", s.name, "\n   ", e.message); }
  }
  srv.close();
  console.log(`${ok} passed${failed.length ? `, ${failed.length} failed` : ""}`);
  process.exit(failed.length ? 1 : 0);
})();
