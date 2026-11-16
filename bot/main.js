#!/usr/bin/env node
// Entry point: node bot/main.js. Needs TELEGRAM_BOT_TOKEN in the environment (systemd reads it from an EnvironmentFile).
// State goes to $STATE_DIRECTORY/state.json (systemd StateDirectory=) or ./data/state.json.
"use strict";
const path = require("path");
const BP = require("../core.js");
const { telegram } = require("./telegram.js");
const { openStore } = require("./store.js");
const { createBot } = require("./bot.js");

const POLL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20000;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

// Positions are not in core.js (the page has no wallet); same API, same timeout rule.
async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { throw e.name === "AbortError" ? new Error("timeout") : e; }
  finally { clearTimeout(timer); }
}

const metric = {
  chains: () => BP.api.chains(),
  positions: (chainId, address) => getJson(`${BP.API}/evm/${chainId}/positions/${address}?contract_version=v1&periods=7d&fiat=USD`),
  pool: (chainId, address) => BP.api.pool(chainId, address),
  bins24h: (chainId, address) => BP.api.bins(chainId, address, "24h").then((d) => (BP.binsUsable(d) ? d : null)),
};

async function main() {
  const tg = telegram(process.env.TELEGRAM_BOT_TOKEN);
  const file = path.join(process.env.STATE_DIRECTORY || path.join(__dirname, "data"), "state.json");
  const store = openStore(file);
  const bot = createBot({ metric, tg, store, log });

  const me = await tg.getMe();
  log(`started as @${me.username}, ${Object.keys(store.data.chats).length} chats`);
  await tg.setMyCommands([
    { command: "watch", description: "Watch a wallet: /watch 0x…" },
    { command: "status", description: "Your positions right now" },
    { command: "list", description: "Wallets you watch" },
    { command: "unwatch", description: "Stop watching a wallet" },
    { command: "stop", description: "Forget everything about this chat" },
    { command: "help", description: "What the bot does" },
  ]).catch((e) => log(e.message));

  const shutdown = () => { store.flush(); log("stopped"); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  bot.poll();
  setInterval(() => bot.poll(), POLL_MS);

  // Long polling: Telegram holds the request up to 50 s and answers as soon as a message arrives.
  for (;;) {
    try {
      const updates = await tg.getUpdates(store.data.offset);
      for (const u of updates) {
        store.data.offset = u.update_id + 1;
        store.save();
        await bot.handle(u.message).catch((e) => log(`handle: ${e.message}`));
      }
    } catch (e) {
      log(e.message);
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
    }
  }
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
