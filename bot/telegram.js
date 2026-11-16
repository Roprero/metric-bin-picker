// Minimal Telegram Bot API client over fetch. Long polling only: the bot needs no open port.
// The token is part of every URL, so errors are rebuilt without the URL and never carry it into logs.
"use strict";

function telegram(token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  async function call(method, params = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(`telegram ${method}: ${e.name === "AbortError" ? "timeout" : "network error"}`);
    } finally { clearTimeout(timer); }
    let j;
    try { j = await res.json(); } catch { throw new Error(`telegram ${method}: HTTP ${res.status}`); }
    if (!j.ok) {
      const err = new Error(`telegram ${method}: ${j.error_code} ${String(j.description || "").replace(token, "***")}`);
      err.code = j.error_code;
      err.retryAfter = j.parameters && j.parameters.retry_after;
      throw err;
    }
    return j.result;
  }
  return {
    call,
    getMe: () => call("getMe"),
    getUpdates: (offset, timeout = 50) => call("getUpdates", { offset, timeout, allowed_updates: ["message"] }, (timeout + 10) * 1000),
    send: (chatId, text) => call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    deleteMessage: (chatId, messageId) => call("deleteMessage", { chat_id: chatId, message_id: messageId }),
    setMyCommands: (commands) => call("setMyCommands", { commands }),
  };
}

module.exports = { telegram };
