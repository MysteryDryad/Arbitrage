# Torn Flip Profit Tracker: handoff

Script: `torn-flip-profit-tracker.user.js` (v0.1.4-beta). Tests: `node test.js` (needs `npm i jsdom`).

## Next steps
1. Get the Settings > "Copy debug sample" output from a real sync; fix `LOG_RULES`, `pickItems`, `pickMoney`.
2. Check the Weaver parser against the real receipt DOM.
3. Dock the button in the header row using the header HTML from the debug sample.
4. Decide how to handle item-market fees.
5. Pick a name (shortlist: Deltamancer, Deltasigil, Gildwyrm, Orrery, Ouroboros).
6. For sharing: settings screen, key removal, @updateURL/@downloadURL, friendlier errors, review Torn script/API rules.

## PDA notes
- PDA replaces the API-key placeholder string in the source; never repeat it elsewhere.
- PDA draws a bottom toolbar (~50px reserved); keyboard shrinks the webview (use % heights).
- Button must stay `position:absolute` at page top; don't use fixed or insert it into Torn's header row.
