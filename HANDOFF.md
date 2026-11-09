# Arbitrage (Torn flip profit tracker): handoff

Script: `torn-flip-profit-tracker.user.js` (see `@version`; `VERSION` must match, `test.js` checks it). Tests: `node test.js` (needs `npm i --no-save jsdom fake-indexeddb`).
Runs in Torn PDA (iOS) and Tampermonkey. Read-only: reads the Torn API, never acts in the game. Data stays on the device.

## Branch
All work and pushes go to `claude/torn-flip-tracker-handoff-0o79ga` (the main branch for this project). Do not use other branches; `claude/serene-fermi-3tusq7` was merged into it and is retired.

## How it works
- `user/log` (v2, newest first) is paged into `state.txs`: item market, bazaar, trade, item send/receive, abroad and NPC shop buys/sells. Trade direction comes from the log (`Trade items incoming` = buy).
- `computeFlips` does FIFO per item; sales without a matching buy are "not counted", buys/sends without an amount "need a value".
- Receipts override log amounts: Weaver/TornW3B (API, own key, matched by trade ID), TornExchange and PawnHub pages (auto-added when opened, picked up from the GM `inbox` by the Torn page), PawnHub Balance page (matched to sends by item, quantity and time).
- One Sync button does everything (log, inbox, Weaver import, one re-read of the log for receipts whose trade is missing). Details of the last sync are in the debug sample (`lastSyncDetail`).
- Storage: full state in IndexedDB (shared by Torn pages); compressed backup in script storage (`statez`); `mergeState` folds in values from a newer copy so a stale page cannot overwrite receipt values.

- Crimes (v0.1.172): the log title is "Crime success item gain (new)" (money is "Crime success money gain (new)"); items are read from the entry data like other item entries, with the "gaining Nx Name" sentence as a fallback. Successes that gain items ("...successfully searching the cemetery gaining 3x Candle") become `channel: 'crime'` buys at amount 0 with `free: true` (stock at cost 0, never a gift). Money gains and failures are ignored. The sentence is searched for in the log entry's data/details/title, and the raw shape is unverified: if crime items still show "no matching buy" after Re-sync, copy the debug sample (it keeps crime entries with items). Unmapped item names are counted in `state.crimeUnknown`.

- Sync speed and background sync (v0.1.173): the log read saves state every 10 pages (not every page) and pauses 500ms between pages; PawnHub and Weaver run in parallel after the log read; the Sync buttons show live progress. `autoSync` runs `syncAll({bg:true})` every 5 minutes while a Torn page is visible (panel can be closed): skipped before the first manual read, during a half-done read, while another sync runs, for 15 minutes after an error, and when another tab holds the `tfp_bglock` lock. Background syncs look at PawnHub only every 30 minutes. A userscript cannot run with no Torn page open.

## UI (v0.1.131)
Full-screen panel (`#tfp-card`: header, scrolling `.tfp-body`, floating Sync, bottom nav). Tabs: Profit (range chips, running-profit graph you can touch, timeline newest first, 10 rows then "Show more", trade number/receipt link/player name only in a row's details, market rows show listing, Torn fee and received), Receipts (status, waiting list, add, recent), Items (by item/day/channel, item history opens under the item), Settings (Needs attention inbox with "Got it"/Dismissed, keys, backup, troubleshooting). `state.ack` holds dismissed ids (1 = dismissed, 0 = restored); `state.names` caches player names (looked up one at a time for visible rows). Market sale records gained `each`, `fee`, `anon` (older ones fill in after Re-sync from start).

## First-run setup (v0.1.157)
New installs (no saved key and no data) see a gated setup popup instead of the tabs: welcome, Torn key (checked on the spot with a log call; on PDA you can use PDA's key or a custom one), "Do you use PawnHub?", PawnHub key (checked against the API, can be skipped), history length (30/90/365 days), optional Weaver key, then Sync now. Closing with X brings it back the next time the 💰 button is used until "Sync now" finishes it (`setupDone`). Existing users are migrated silently (`migrateSetup`). Settings has "Run setup again". Background inbox/PawnHub tasks wait for setup.

## Known gaps / ideas
- RW weapons/armor (unique `uid` in log items), museum set exchanges and cache opening are not modelled: need log examples of each (use Settings > Backup & troubleshooting > Copy debug sample; entries with museum/cache/ranked/item use/points titles are kept).
- PawnHub Balance page lists only the newest ~100 payments; older sends need a value or can be left out of profit. A PawnHub API was requested from its owner.
- Stock tab and inventory check were removed on purpose.
- For sharing: pick a licence, check name on Greasy Fork, add the receipt sites to the disclosure if their rules require it.
