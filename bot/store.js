// State of the bot in one JSON file, written atomically (temp file + rename). Small by design: chat ids, public wallet
// addresses, alert states and a snapshot per pool. Nothing secret is ever stored here.
"use strict";
const fs = require("fs");
const path = require("path");

const EMPTY = () => ({ version: 1, offset: 0, chats: {}, conds: {}, pools: {} });

function openStore(file) {
  let data = EMPTY();
  if (file && fs.existsSync(file)) {
    try { data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch (e) { fs.renameSync(file, `${file}.broken-${Date.now()}`); } // keep the bad file for a look, start clean
  }
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 500); };

  return {
    data,
    save, flush,
    chat(id) { return data.chats[id] || null; },
    ensureChat(id, now) { return (data.chats[id] ||= { addresses: [], since: now }); },
    // /stop: everything about the chat goes, alert states included
    dropChat(id) { delete data.chats[id]; delete data.conds[id]; save(); },
    cond(chatId, key) { return (data.conds[chatId] || {})[key]; },
    setCond(chatId, key, entry) { (data.conds[chatId] ||= {})[key] = entry; save(); },
    // forget states of positions and pools the chat no longer has
    pruneConds(chatId, keep) {
      const c = data.conds[chatId]; if (!c) return;
      for (const k of Object.keys(c)) if (!keep.has(k)) delete c[k];
      save();
    },
  };
}

module.exports = { openStore };
