# Arbitrage (Torn flip profit tracker): handoff

Script: `torn-flip-profit-tracker.user.js` (see `@version`; `VERSION` must match, `test.js` checks it). Tests: `node test.js` (needs `npm i --no-save jsdom fake-indexeddb`).
Runs in Torn PDA (iOS) and Tampermonkey. Read-only: reads the Torn API, never acts in the game. Data stays on the device.

## How it works
- `user/log` (v2, newest first) is paged into `state.txs`: item market, bazaar, trade, item send/receive, abroad and NPC shop buys/sells. Trade direction comes from the log (`Trade items incoming` = buy).
- `computeFlips` does FIFO per item; sales without a matching buy are "not counted", buys/sends without an amount "need a value".
- Receipts override log amounts: Weaver/TornW3B (API, own key, matched by trade ID), TornExchange and PawnHub pages (auto-added when opened, picked up from the GM `inbox` by the Torn page), PawnHub Balance page (matched to sends by item, quantity and time).
- One Sync button does everything (log, inbox, Weaver import, one re-read of the log for receipts whose trade is missing). Details of the last sync are in the debug sample (`lastSyncDetail`).
- Storage: full state in IndexedDB (shared by Torn pages); compressed backup in script storage (`statez`); `mergeState` folds in values from a newer copy so a stale page cannot overwrite receipt values.

## UI (v0.1.131)
Full-screen panel (`#tfp-card`: header, scrolling `.tfp-body`, floating Sync, bottom nav). Tabs: Profit (range chips, running-profit graph you can touch, timeline newest first, 10 rows then "Show more", trade number/receipt link/player name only in a row's details, market rows show listing, Torn fee and received), Receipts (status, waiting list, add, recent), Items (by item/day/channel, item history opens under the item), Settings (Needs attention inbox with "Got it"/Dismissed, keys, backup, troubleshooting). `state.ack` holds dismissed ids (1 = dismissed, 0 = restored); `state.names` caches player names (looked up one at a time for visible rows). Market sale records gained `each`, `fee`, `anon` (older ones fill in after Re-sync from start).

## Known gaps / ideas
- RW weapons/armor (unique `uid` in log items), museum set exchanges and cache opening are not modelled: need log examples of each (use Settings > Backup & troubleshooting > Copy debug sample; entries with museum/cache/ranked/item use/points titles are kept).
- PawnHub Balance page lists only the newest ~100 payments; older sends need a value or can be left out of profit. A PawnHub API was requested from its owner.
- Stock tab and inventory check were removed on purpose.
- For sharing: pick a licence, check name on Greasy Fork, add the receipt sites to the disclosure if their rules require it.
