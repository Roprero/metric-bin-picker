// node bot/test/bot.test.js — alert rules, the alert state machine and whole bot rounds, offline with a fake API and Telegram.
"use strict";
const assert = require("assert");
const A = require("../alerts.js");
const { createBot } = require("../bot.js");
const { openStore } = require("../store.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const POOL = "0xaef2ad7aBB651945e6D24276715f25BDED0ad41e";
const NOW = 1794820000;
// The shape /positions returns (trimmed), with made-up numbers.
const position = (o = {}) => ({
  id: `1-${POOL.toLowerCase()}-${WALLET}-1`, chainId: "1", poolAddress: POOL,
  bins: [{ binIdx: "-2", token0Amount: "0", token1Amount: "209419337" }, { binIdx: "0", token0Amount: "0", token1Amount: "410599163" }],
  performance: {
    openedAtTimestamp: NOW - 3 * 86400, currentValueFiat: 619.65, feesEarnedFiat: 0.09,
    aprByPeriod: { "7d": { apr: 0.053, pnlApr: -0.013 } },
    markoutByPeriod: { "7d": { byHorizon: { "5m": { apr: o.mk ?? 0.016 } } } },
  },
  ...o.extra,
});
const meta = (o = {}) => ({
  pair: "USDC/USDT", poolAddress: POOL, curBinIdx: 1, token0Symbol: "USDC", token1Symbol: "USDT",
  spreadAdminFeeE6: 100000, spreadProtocolFeeE6: 100000, pauseLevel: 0, priceProviderStatus: "healthy",
  classificationSummary: { tierQualification: "yellow", reasonCodes: ["app_missing"] }, ...o,
});
const bins = (swaps) => ({ curBinIdx: 1, bins: [-2, -1, 0, 1, 2].map((i) => ({ bin: String(i), swapCount: String(swaps[i] ?? 10) })) });

let n = 0;
const failed = [];
const t = async (name, fn) => {
  try { await fn(); n++; console.log("ok", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n   ", e.message.split("\n")[0]); }
};
const cond = (list, key) => list.find((c) => c.key.endsWith(`:${key}`));

// A fake world the bot polls: mutate `world` between rounds.
function harness() {
  const world = { positions: [position()], meta: meta(), bins: bins({}), down: false };
  const sent = [];
  const metric = {
    chains: async () => [{ chainId: 1 }],
    positions: async (c, a) => { if (world.down) throw new Error("HTTP 503"); return a.toLowerCase() === WALLET ? world.positions : []; },
    pool: async () => world.meta,
    bins24h: async () => world.bins,
  };
  const tg = { send: async (chat, text) => { sent.push({ chat, text }); }, deleteMessage: async () => { sent.push({ deleted: true }); } };
  const store = openStore(null);
  let clock = NOW;
  const bot = createBot({ metric, tg, store, now: () => clock, log: () => {} });
  const say = (text, id = 42) => bot.handle({ chat: { id }, message_id: 7, text });
  const round = async (dt = 300) => { clock += dt; sent.length = 0; await bot.poll(); return sent.map((s) => s.text).join("\n"); };
  return { world, sent, store, bot, say, round };
}

(async () => {
  // --- rules ---
  await t("B01 healthy position: no condition is active", async () => {
    const c = A.positionConditions(position(), meta(), bins({}), NOW);
    assert.deepStrictEqual(c.map((x) => x.active), [false, false]);
  });
  await t("B02 idle: none of your bins swapped in 24h while the pool did", async () => {
    const c = A.positionConditions(position(), meta(), bins({ "-2": 0, 0: 0 }), NOW);
    assert.ok(cond(c, "idle").active);
    assert.ok(/#-2, #0 had no swaps/.test(cond(c, "idle").on));
  });
  await t("B03 idle is not raised when the whole pool is quiet (closed stock market)", async () => {
    const c = A.positionConditions(position(), meta(), bins({ "-2": 0, "-1": 0, 0: 0, 1: 0, 2: 0 }), NOW);
    assert.ok(!cond(c, "idle").active);
  });
  await t("B04 without per-bin analytics, idle falls back to distance from the price", async () => {
    assert.ok(!cond(A.positionConditions(position(), meta(), null, NOW), "idle").active);
    assert.ok(cond(A.positionConditions(position(), meta({ curBinIdx: 30 }), null, NOW), "idle").active);
  });
  await t("B05 negative markout alerts, but not on a position younger than a day", async () => {
    assert.ok(cond(A.positionConditions(position({ mk: -0.02 }), meta(), bins({}), NOW), "markout").active);
    const young = position({ mk: -0.02 }); young.performance.openedAtTimestamp = NOW - 3600;
    assert.ok(!cond(A.positionConditions(young, meta(), bins({}), NOW), "markout").active);
  });
  await t("B06 an emptied position has no conditions", async () => {
    const p = position(); p.bins = p.bins.map((b) => ({ ...b, token1Amount: "0" }));
    assert.deepStrictEqual(A.positionConditions(p, meta(), bins({}), NOW), []);
  });
  await t("B07 pool events: fee share up, tier down; nothing on first sight or an upgrade", async () => {
    const prev = A.poolSnapshot(meta());
    assert.deepStrictEqual(A.poolEvents(undefined, meta()), []);
    const ev = A.poolEvents(prev, meta({ spreadAdminFeeE6: 250000 }));
    assert.strictEqual(ev.length, 1); assert.ok(/curator 10% → <b>25%<\/b>/.test(ev[0].text) && /keep less/.test(ev[0].text));
    const red = A.poolEvents(prev, meta({ classificationSummary: { tierQualification: "red", reasonCodes: ["app_missing", "price_provider_mutable"] } }));
    assert.ok(red.length === 1 && /yellow → red/.test(red[0].text) && /price_provider_mutable/.test(red[0].text));
    assert.deepStrictEqual(A.poolEvents(prev, meta({ classificationSummary: { tierQualification: "green", reasonCodes: [] } })), []);
  });
  await t("B08 pool conditions: paused and feed down", async () => {
    const c = A.poolConditions(meta({ pauseLevel: 1, priceProviderStatus: "feed_down" }));
    assert.deepStrictEqual(c.map((x) => x.active), [true, true]);
    assert.ok(/feed_down/.test(c[1].on));
  });

  // --- state machine ---
  await t("B09 step: on once, off after two clear polls, cooldown blocks a quick repeat", async () => {
    let e, r;
    r = A.step(e, true, 1000); assert.strictEqual(r.send, "on"); e = r.entry;
    r = A.step(e, true, 1300); assert.strictEqual(r.send, null); e = r.entry;
    r = A.step(e, false, 1600); assert.strictEqual(r.send, null); e = r.entry;
    r = A.step(e, true, 1900); assert.strictEqual(r.send, null, "one clear poll is not recovery"); e = r.entry;
    r = A.step(e, false, 2200); e = r.entry; r = A.step(e, false, 2500); assert.strictEqual(r.send, "off"); e = r.entry;
    r = A.step(e, true, 2800); assert.strictEqual(r.send, null, "within cooldown"); e = r.entry;
    r = A.step(e, false, 3100); e = r.entry; r = A.step(e, false, 3400); assert.strictEqual(r.send, null, "no off for an unsent on"); e = r.entry;
    r = A.step(e, true, 1000 + A.COOLDOWN + 10); assert.strictEqual(r.send, "on");
  });
  await t("B10 step: silent records without sending, and the later recovery stays silent", async () => {
    let r = A.step(undefined, true, 1000, true); assert.strictEqual(r.send, null); assert.ok(r.entry.active);
    r = A.step(r.entry, false, 1300); r = A.step(r.entry, false, 1600); assert.strictEqual(r.send, null);
  });

  // --- input ---
  await t("B11 commands, bare addresses and @botname suffixes parse", async () => {
    assert.deepStrictEqual(A.parseCommand(WALLET), { cmd: "watch", arg: WALLET });
    assert.deepStrictEqual(A.parseCommand(`/watch@MetricAlertsBot ${WALLET}`), { cmd: "watch", arg: WALLET });
    assert.deepStrictEqual(A.parseCommand("/stop"), { cmd: "stop", arg: "" });
    assert.deepStrictEqual(A.parseCommand("hello"), { cmd: "", arg: "" });
  });
  await t("B12 private keys and seed phrases are recognised; addresses and commands are not", async () => {
    assert.ok(A.looksSecret("0x" + "ab".repeat(32)));
    assert.ok(A.looksSecret("ab".repeat(32)));
    assert.ok(A.looksSecret("abandon ability able about above absent absorb abstract absurd abuse access accident"));
    assert.ok(!A.looksSecret(WALLET));
    assert.ok(!A.looksSecret(`/watch ${WALLET}`));
    assert.ok(!A.looksSecret("please watch my wallet for me"));
  });

  // --- whole bot ---
  await t("B13 /watch replies with the position, and what is already wrong is not alerted again", async () => {
    const h = harness();
    h.world.meta = meta({ priceProviderStatus: "feed_down" });
    await h.say(`/watch ${WALLET}`);
    const reply = h.sent.map((s) => s.text).join("\n");
    assert.ok(/Watching/.test(reply) && /USDC\/USDT/.test(reply) && /bins #-2, #0 \(USDT\)/.test(reply) && /feed_down/.test(reply), reply);
    assert.strictEqual(await h.round(), "", "feed_down was already shown in the reply");
  });
  await t("B14 a round alerts on change, once, and sends the recovery after two clear rounds", async () => {
    const h = harness();
    await h.say(WALLET);
    assert.strictEqual(await h.round(), "");
    h.world.meta = meta({ pauseLevel: 1 });
    assert.ok(/paused/.test(await h.round()));
    assert.strictEqual(await h.round(), "");
    h.world.meta = meta();
    assert.strictEqual(await h.round(), "");
    assert.ok(/no longer paused/.test(await h.round()));
  });
  await t("B15 a fee change reaches the chat once", async () => {
    const h = harness();
    await h.say(WALLET);
    await h.round();
    h.world.meta = meta({ spreadAdminFeeE6: 300000 });
    assert.ok(/curator 10% → <b>30%<\/b>/.test(await h.round()));
    assert.strictEqual(await h.round(), "");
  });
  await t("B16 API down for a round: no alerts, states survive, nothing resent after", async () => {
    const h = harness();
    await h.say(WALLET);
    h.world.positions = [position({ mk: -0.05 })];
    assert.ok(/markout over 7d is <b>-5.0%/.test(await h.round()));
    h.world.down = true;
    assert.strictEqual(await h.round(), "");
    h.world.down = false;
    assert.strictEqual(await h.round(), "", "the markout alert must not repeat");
  });
  await t("B17 /stop forgets the chat; /unwatch of the last wallet too", async () => {
    const h = harness();
    await h.say(WALLET); await h.round();
    await h.say("/stop");
    assert.strictEqual(h.store.chat("42"), null); assert.strictEqual(h.store.data.conds["42"], undefined);
    await h.say(WALLET); await h.say(`/unwatch ${WALLET}`);
    assert.strictEqual(h.store.chat("42"), null);
  });
  await t("B18 a pasted private key is deleted, not stored, and answered with a warning", async () => {
    const h = harness();
    await h.say("0x" + "cd".repeat(32));
    assert.ok(h.sent.some((s) => s.deleted));
    assert.ok(/did not store it/.test(h.sent.find((s) => s.text).text));
    assert.ok(!JSON.stringify(h.store.data).includes("cd".repeat(32)));
  });
  await t("B19 wallet limit, bad address, duplicate watch", async () => {
    const h = harness();
    await h.say("/watch 0x123");
    assert.ok(/42 characters/.test(h.sent.pop().text));
    for (let k = 2; k < 7; k++) await h.say(`/watch 0x${String(k).repeat(40)}`);
    await h.say(`/watch ${WALLET}`);
    assert.ok(/already watch 5/.test(h.sent.pop().text));
    await h.say(`/watch 0x${"2".repeat(40)}`);
    assert.ok(/Already watching/.test(h.sent.pop().text));
  });
  await t("B20 watching a second wallet keeps the first wallet's alert states", async () => {
    const h = harness();
    await h.say(WALLET);
    h.world.positions = [position({ mk: -0.05 })];
    await h.round();
    await h.say(`/watch 0x${"2".repeat(40)}`);
    assert.strictEqual(await h.round(), "", "the first wallet's markout alert must not repeat");
  });
  await t("B21 a chat that blocked the bot is dropped", async () => {
    const h = harness();
    await h.say(WALLET);
    h.world.meta = meta({ pauseLevel: 1 });
    const tgSend = async () => { throw Object.assign(new Error("telegram sendMessage: 403 Forbidden: bot was blocked by the user"), { code: 403 }); };
    const bot = createBot({ metric: { chains: async () => [{ chainId: 1 }], positions: async () => h.world.positions, pool: async () => h.world.meta, bins24h: async () => h.world.bins },
      tg: { send: tgSend }, store: h.store, now: () => NOW + 600, log: () => {} });
    await bot.poll();
    assert.strictEqual(h.store.chat("42"), null);
  });

  console.log(`${n} passed${failed.length ? `, ${failed.length} failed` : ""}`);
  if (failed.length) process.exit(1);
})();
