// The bot: commands from Telegram and a poll over watched wallets. Everything it talks to is passed in, so tests run offline.
//   metric: { chains(), positions(chainId, address), pool(chainId, address), bins24h(chainId, address) }
//   tg:     { send(chatId, html), deleteMessage(chatId, messageId) }
"use strict";
const A = require("./alerts.js");

const MAX_ADDRESSES = 5;
const MAX_CHATS = 5000;
const SITE = "https://roprero.github.io/metric-bin-picker/";

const HELP = [
  "<b>Metric alerts</b> watches your liquidity on Metric and writes when something needs a look:",
  "• your bins stopped trading (no swaps in 24h, or the price moved far away);",
  "• your position's 5m markout went negative;",
  "• the pool's curator or Metric changed their share of the spread, the tier got worse, the pool paused or its price feed went down.",
  "",
  "Send a wallet address, or:",
  "/watch 0x… — watch a wallet (up to 5)",
  "/unwatch 0x… — stop watching it",
  "/list — wallets you watch",
  "/status — your positions right now",
  "/stop — forget everything about this chat",
  "",
  "Only public addresses. Never send a private key or seed phrase, to this bot or anyone.",
  `Which bins to pick: <a href="${SITE}">Bin Picker</a>. Data: Metric public API, checked every 5 minutes.`,
].join("\n");

function createBot({ metric, tg, store, now = () => Math.floor(Date.now() / 1000), log = console.log, concurrency = 4 }) {
  let chainIds = Object.keys(A.CHAINS).map(Number);
  let chainsAt = 0;

  // run async jobs with at most `concurrency` in flight
  async function pool(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  async function refreshChains() {
    if (now() - chainsAt < 3600) return;
    try { const c = await metric.chains(); if (Array.isArray(c) && c.length) chainIds = c.map((x) => Number(x.chainId)).filter(Number.isFinite); chainsAt = now(); }
    catch (e) { log(`chains: ${e.message}`); }
  }

  // All positions of a set of addresses across chains, plus pool data for every pool they touch.
  // A failed call leaves that address or pool out of this round; their stored states stay as they are.
  async function snapshot(addresses) {
    await refreshChains();
    const jobs = addresses.flatMap((a) => chainIds.map((c) => [a, c]));
    const failedAddr = new Set();
    const res = await pool(jobs, async ([a, c]) => {
      try { const p = await metric.positions(c, a); return Array.isArray(p) ? p.map((x) => ({ ...x, chainId: Number(x.chainId || c), owner: a.toLowerCase() })) : []; }
      catch (e) { failedAddr.add(a.toLowerCase()); log(`positions ${c} ${a.slice(0, 8)}: ${e.message}`); return []; }
    });
    const positions = res.flat().filter((p) => A.heldBins(p).length);
    const poolIds = [...new Map(positions.map((p) => [A.poolKey(p.chainId, p.poolAddress), [p.chainId, p.poolAddress]])).entries()];
    const pools = new Map();
    await pool(poolIds, async ([key, [c, addr]]) => {
      try {
        const [meta, bins] = await Promise.all([metric.pool(c, addr), metric.bins24h(c, addr).catch(() => null)]);
        if (meta) pools.set(key, { meta, bins: bins && Array.isArray(bins.bins) ? bins : null });
      } catch (e) { log(`pool ${key}: ${e.message}`); }
    });
    return { positions, pools, failedAddr };
  }

  async function sendAll(chatId, texts) {
    if (!texts.length) return;
    // one message per poll per chat, split only if Telegram's 4096-character limit needs it
    let buf = "";
    const chunks = [];
    for (const t of texts) { if (buf && buf.length + t.length + 2 > 3800) { chunks.push(buf); buf = ""; } buf += (buf ? "\n\n" : "") + t; }
    if (buf) chunks.push(buf);
    for (const c of chunks) {
      try { await tg.send(chatId, c); }
      catch (e) {
        if (e.code === 403 || e.code === 400 && /chat not found/i.test(e.message)) { store.dropChat(chatId); log(`chat ${chatId} gone, dropped`); return; }
        log(`send ${chatId}: ${e.message}`);
      }
    }
  }

  // Evaluate every condition for one chat. `silent` records states without alerting (right after /watch).
  function evaluate(chatId, snap, { silent = false, prune = true } = {}) {
    const chat = store.chat(chatId);
    if (!chat) return [];
    const mine = new Set(chat.addresses.map((a) => a.toLowerCase()));
    const t = now();
    const texts = [];
    const keep = new Set();
    const touchedPools = new Set();
    for (const pos of snap.positions.filter((p) => mine.has(p.owner))) {
      const pk = A.poolKey(pos.chainId, pos.poolAddress);
      const pd = snap.pools.get(pk);
      if (!pd) continue;
      touchedPools.add(pk);
      for (const c of A.positionConditions(pos, pd.meta, pd.bins, t)) {
        keep.add(c.key);
        const r = A.step(store.cond(chatId, c.key), c.active, t, silent);
        store.setCond(chatId, c.key, r.entry);
        if (r.send) texts.push(r.send === "on" ? c.on : c.off);
      }
    }
    for (const pk of touchedPools) {
      const { meta } = snap.pools.get(pk);
      for (const c of A.poolConditions(meta)) {
        const key = `pool:${pk}:${c.key}`;
        keep.add(key);
        const r = A.step(store.cond(chatId, key), c.active, t, silent);
        store.setCond(chatId, key, r.entry);
        if (r.send) texts.push(r.send === "on" ? c.on : c.off);
      }
    }
    // keep states of addresses whose call failed this round, so a flaky API does not reset them
    // and never prune from a partial snapshot (/status of one wallet), or the other wallets' states would be lost
    if (prune && ![...mine].some((a) => snap.failedAddr.has(a))) store.pruneConds(chatId, keep);
    return { texts, touchedPools };
  }

  // The 5-minute job.
  let running = false;
  async function poll() {
    if (running) return; // a slow round must not overlap the next one
    running = true;
    try {
      const chats = Object.keys(store.data.chats);
      const addresses = [...new Set(chats.flatMap((id) => store.data.chats[id].addresses.map((a) => a.toLowerCase())))];
      if (!addresses.length) return;
      const snap = await snapshot(addresses);
      // pool changes since the last round: the same event goes to every chat with liquidity in that pool
      const events = new Map();
      for (const [pk, { meta }] of snap.pools) {
        const ev = A.poolEvents(store.data.pools[pk], meta);
        if (ev.length) events.set(pk, ev);
        store.data.pools[pk] = A.poolSnapshot(meta);
      }
      store.save();
      for (const id of chats) {
        const { texts, touchedPools } = evaluate(id, snap);
        for (const pk of touchedPools) for (const e of events.get(pk) || []) texts.push(e.text);
        await sendAll(id, texts);
      }
      log(`poll: ${chats.length} chats, ${addresses.length} wallets, ${snap.positions.length} positions, ${snap.pools.size} pools`);
    } catch (e) { log(`poll failed: ${e.stack || e.message}`); }
    finally { running = false; }
  }

  async function status(chatId, addresses) {
    const snap = await snapshot(addresses);
    for (const [pk, { meta }] of snap.pools) if (!store.data.pools[pk]) store.data.pools[pk] = A.poolSnapshot(meta);
    evaluate(chatId, snap, { silent: true, prune: false }); // remember what is already wrong, so it is not alerted again
    const mine = new Set(addresses.map((a) => a.toLowerCase()));
    const lines = snap.positions.filter((p) => mine.has(p.owner)).map((p) => {
      const pd = snap.pools.get(A.poolKey(p.chainId, p.poolAddress));
      if (!pd) return null;
      const active = A.positionConditions(p, pd.meta, pd.bins, now()).filter((c) => c.active).map((c) => `⚠️ ${c.on}`);
      const poolBad = A.poolConditions(pd.meta).filter((c) => c.active).map((c) => `⚠️ ${c.on}`);
      return [A.positionSummary(p, pd.meta), ...active, ...poolBad].join("\n");
    }).filter(Boolean);
    const failed = addresses.filter((a) => snap.failedAddr.has(a.toLowerCase()));
    if (!lines.length) {
      return failed.length
        ? "Metric's API did not answer for this wallet. I'll keep checking every 5 minutes."
        : `No open Metric positions on ${addresses.length === 1 ? "this wallet" : "these wallets"} yet. I'll keep watching and write when one needs a look.`;
    }
    return lines.join("\n\n") + (failed.length ? "\n\nSome chains did not answer; the list may be incomplete." : "");
  }

  // One incoming Telegram message.
  async function handle(msg) {
    if (!msg || !msg.chat || typeof msg.text !== "string") return;
    const chatId = String(msg.chat.id);
    if (A.looksSecret(msg.text)) {
      try { await tg.deleteMessage(chatId, msg.message_id); } catch { /* may be too old or not allowed */ }
      return sendAll(chatId, ["⚠️ That looked like a private key or seed phrase. I did not store it and tried to delete the message. Never send it to anyone, this bot included. If it belongs to a real wallet, move the funds to a new one."]);
    }
    const { cmd, arg } = A.parseCommand(msg.text);
    const chat = store.chat(chatId);
    switch (cmd) {
      case "start": case "help": return sendAll(chatId, [HELP]);
      case "watch": {
        if (!A.ADDRESS.test(arg)) return sendAll(chatId, ["Send a wallet address like <code>/watch 0x1234…abcd</code> (42 characters, starts with 0x)."]);
        if (!chat && Object.keys(store.data.chats).length >= MAX_CHATS) return sendAll(chatId, ["The bot is full right now, sorry. Try again later."]);
        const c = store.ensureChat(chatId, now());
        if (c.addresses.some((a) => a.toLowerCase() === arg.toLowerCase())) return sendAll(chatId, [`Already watching <code>${arg}</code>.\n\n${await status(chatId, [arg])}`]);
        if (c.addresses.length >= MAX_ADDRESSES) return sendAll(chatId, [`You already watch ${MAX_ADDRESSES} wallets. /unwatch one first.`]);
        c.addresses.push(arg);
        store.save();
        return sendAll(chatId, [`Watching <code>${arg}</code>. I check every 5 minutes and write only when something changes.\n\n${await status(chatId, [arg])}`]);
      }
      case "unwatch": {
        if (!chat) return sendAll(chatId, ["You don't watch any wallet."]);
        const before = chat.addresses.length;
        chat.addresses = chat.addresses.filter((a) => a.toLowerCase() !== arg.toLowerCase());
        if (chat.addresses.length === before) return sendAll(chatId, [`Not watching <code>${A.esc(arg)}</code>. /list shows what I watch.`]);
        if (!chat.addresses.length) store.dropChat(chatId); else store.save();
        return sendAll(chatId, [`Stopped watching <code>${arg}</code>.`]);
      }
      case "list":
        return sendAll(chatId, [chat && chat.addresses.length ? `Watching:\n${chat.addresses.map((a) => `<code>${a}</code>`).join("\n")}` : "You don't watch any wallet. Send an address to start."]);
      case "status":
        if (!chat || !chat.addresses.length) return sendAll(chatId, ["You don't watch any wallet. Send an address to start."]);
        return sendAll(chatId, [await status(chatId, chat.addresses)]);
      case "stop":
        store.dropChat(chatId);
        return sendAll(chatId, ["Done: I forgot your wallets and alert history. /start to begin again."]);
      default:
        return sendAll(chatId, ["I didn't get that. Send a wallet address or /help."]);
    }
  }

  return { handle, poll, status, evaluate, snapshot, HELP };
}

module.exports = { createBot, MAX_ADDRESSES };
