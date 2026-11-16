# Metric alerts bot

A Telegram bot that watches liquidity positions on [Metric](https://metric.xyz) and writes when something needs a look.
It reuses `core.js` from Bin Picker and has no dependencies besides Node 20+.

## Alerts

| Alert | When |
|---|---|
| Bins not trading | none of your bins had a swap in 24h while the pool traded; if per-bin analytics are down, your closest bin is more than 10 bins from the price |
| Negative markout | your position's 5m markout over 7d is below zero (positions older than a day) |
| Fee share changed | the curator's or Metric's share of the spread changed (there is no timelock on it) |
| Tier downgrade | the pool's tier got worse, with the new reason codes |
| Paused / feed down | the pool is paused, or its price provider is not `healthy` |

An alert is sent once when its condition starts. The all-clear goes out after two clean checks in a row, so a flapping
condition doesn't spam the chat, and the same alert isn't repeated within an hour. Whatever is already wrong when you
start watching shows up in the first reply instead of as an alert.

## Commands

`/watch 0x…` (or just send an address), `/unwatch 0x…`, `/list`, `/status`, `/stop`, `/help`. Up to 5 wallets per chat.

## What it stores

Chat id, the public wallet addresses you watch, alert states, and a snapshot of each watched pool's fees and tier, in one
JSON file. `/stop` deletes everything about the chat. It never asks for keys or signatures. A message that looks like a
private key or seed phrase is deleted and never stored.

## Data

Every 5 minutes, through Metric's public API: `/positions/{wallet}` per chain, then `/metadata` and
`/analytics/bins?period=24h` once per pool, shared by everyone watching that pool. Per-bin analytics are an undocumented
endpoint; without them, the bot falls back to distance from the price.

## Run

```bash
TELEGRAM_BOT_TOKEN=... node bot/main.js   # state in bot/data/state.json
node bot/test/bot.test.js                 # offline tests
```

As a service: copy `core.js` and `bot/` to `/opt/metric-alerts-bot/`, put `TELEGRAM_BOT_TOKEN=...` in a root-only file
(`chmod 600`), point `EnvironmentFile=` in [deploy/metric-alerts-bot.service](../deploy/metric-alerts-bot.service) at it, then

```bash
cp deploy/metric-alerts-bot.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now metric-alerts-bot
journalctl -u metric-alerts-bot -f
```

The unit runs as a throwaway user with a read-only system and outbound network only; Telegram is reached by long polling,
so no port is opened.
