globalThis.__TFP_TEST = true;
const { JSDOM } = require('jsdom');
const T = require('./torn-flip-profit-tracker.user.js');
let fail = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(a) + ' != ' + JSON.stringify(b)); };

// FIFO
const tx = {
  a: { id: 'a', ts: 1, dir: 'buy', items: [{ id: 267, qty: 10, price: null }], amount: 300000 },
  b: { id: 'b', ts: 2, dir: 'buy', items: [{ id: 267, qty: 5, price: null }], amount: 160000 },
  c: { id: 'c', ts: 3, dir: 'sell', channel: 'market', items: [{ id: 267, qty: 12, price: null, name: 'Heather' }], amount: 420000 },
  d: { id: 'd', ts: 4, dir: 'sell', channel: 'send', items: [{ id: 267, qty: 3 }], amount: null },
  e: { id: 'e', ts: 5, dir: 'sell', channel: 'bazaar', items: [{ id: 999, qty: 2 }], amount: 1000 },
  f: { id: 'f', ts: 6, dir: null, channel: 'trade', items: [{ id: 267, qty: 1 }], amount: null }
};
const r = T.computeFlips(tx);
eq('FIFO profit', r.flips.find(f => f.tx.id === 'c').profit, 420000 - (10 * 30000 + 2 * 32000));
eq('pending count (send + dir-less trade)', r.pending.map(p => p.id).sort(), ['d', 'f']);
eq('unmatched sale has no profit and is flagged', [r.flips.find(f => f.tx.id === 'e').profit, r.flips.find(f => f.tx.id === 'e').unmatched], [null, 2]);

// multi-item sell with receipt prices, per-item lines
const tx2 = {
  a: { id: 'a', ts: 1, dir: 'buy', items: [{ id: 384, qty: 13, price: null }, { id: 215, qty: 191, price: null }], amount: 13 * 60000 + 191 * 400 },
  b: { id: 'b', ts: 2, dir: 'sell', items: [{ id: 384, qty: 13, price: 70700 }, { id: 215, qty: 191, price: 600 }], amount: 919100 + 114600 }
};
const r2 = T.computeFlips(tx2);
eq('multi-item total proceeds', Math.round(r2.flips[0].lines.reduce((s, l) => s + l.proceeds, 0)), 1033700);
eq('per-item lines exist', r2.flips[0].lines.length, 2);

// TornExchange parser
const teHtml = `<body><h6>Buyer: Coralie</h6><h6>Seller: Rosiestarfish</h6><div>Oct. 8, 2026, 2:41 a.m.</div>
<table><tr><th>Image</th><th>Name</th></tr><tr><td><img src="https://www.torn.com/images/items/267/large.png"></td><td>Heather</td><td>$34,900</td><td>28</td><td>$977,200</td></tr></table>
<p><b>Total: $977,200</b></p></body>`;
const te = T.parseTornExchange(new JSDOM(teHtml).window.document, 'https://tornexchange.com/receipt/X');
eq('TE parse', [te.buyer, te.seller, te.total, te.items], ['Coralie', 'Rosiestarfish', 977200, [{ id: 267, name: 'Heather', qty: 28, price: 34900 }]]);
eq('TE time parsed', typeof te.ts, 'number');

// Weaver parser (structure taken from the screenshot)
const wvHtml = `<body><h1>Rosiestarfish → Coralie</h1><div>Trade ID 13481500 · Oct 8, 2026, 02:43 AM · Seller [4458309] · Buyer [4500811]</div>
<table><tr><th>ITEM</th></tr>
<tr><td><span>Camel Plushie</span><span>ID: 384</span></td><td>13</td><td>$70,700* (101%)</td><td>$70,127</td><td>$919,100</td></tr>
<tr><td><span>Kitten Plushie</span><span>ID: 215</span></td><td>191</td><td>$600* (120%)</td><td>$501</td><td>$114,600</td></tr>
<tr><td>TOTAL</td><td>204</td><td>102.6% of market</td><td>$1,007,342</td><td>$1,033,700</td></tr></table></body>`;
const wv = T.parseWeaver(new JSDOM(wvHtml).window.document, 'https://weav3r.dev/receipt/Y');
eq('Weaver parse', [wv.tradeId, wv.seller, wv.buyer, wv.sellerId, wv.buyerId, wv.total, wv.items.length], [13481500, 'Rosiestarfish', 'Coralie', 4458309, 4500811, 1033700, 2]);
eq('Weaver item', wv.items[0], { id: 384, name: 'Camel Plushie', qty: 13, price: 70700 });
eq('role seller', T.roleFor(wv, { id: 4458309, name: 'x' }), 'sell');
eq('role buyer by name', T.roleFor(te, { id: 1, name: 'coralie' }), 'buy');

// receipt matching
const cand = T.rankCandidates(wv, { t1: { id: 't1', channel: 'trade', ts: wv.ts, tradeId: 13481500, items: [{ id: 384, qty: 13 }, { id: 215, qty: 191 }], amount: null } });
eq('match by trade id scores high', cand[0].score >= 10, true);

// log parser smoke test
const le = T.parseLogEntry({ id: 'L1', timestamp: 100, details: { title: 'Item market buy' }, data: { items: [{ id: 267, qty: 5 }], total_cost: 160000 } }, { channel: 'market', dir: 'buy' }, id => 'Heather');
eq('log entry parse', [le.amount, le.items[0].name, le.src], [160000, 'Heather', 'log']);
// market fee: only log-sourced item-market sales are reduced
const fx = { a: { id: 'a', ts: 1, dir: 'buy', items: [{ id: 1, qty: 1 }], amount: 900 },
  b: { id: 'b', ts: 2, dir: 'sell', channel: 'market', src: 'log', items: [{ id: 1, qty: 1 }], amount: 1000 },
  c: { id: 'c', ts: 3, dir: 'buy', items: [{ id: 2, qty: 1 }], amount: 900 },
  d: { id: 'd', ts: 4, dir: 'sell', channel: 'bazaar', src: 'log', items: [{ id: 2, qty: 1 }], amount: 1000 } };
const fr = T.computeFlips(fx, { marketFee: 0.05 });
eq('market fee applied', fr.flips.find(f => f.tx.id === 'b').profit, 50);
eq('bazaar no fee', fr.flips.find(f => f.tx.id === 'd').profit, 100);
// trades from real log shapes (money/items-outgoing field names are assumed until seen live)
const mk = (id, title, data) => [id, { title, ts: 100, data }];
const tp = { '13481192': { parts: Object.fromEntries([
  mk('a', 'Trade accepted', { user: 1, parsed_trade_id: 13481192 }),
  mk('b', 'Trade items incoming', { user: 1, parsed_trade_id: 13481192, items: [{ id: 269, uid: null, qty: 1000 }] }),
  mk('c', 'Trade money outgoing', { user: 1, parsed_trade_id: 13481192, money: 5000000 }),
  mk('d', 'Trade completed', { user: 1, parsed_trade_id: 13481192 })]) },
  '2': { parts: Object.fromEntries([mk('e', 'Trade items incoming', { items: [{ id: 5, qty: 1 }] })]) } };
const bt = T.buildTradeTxs(tp, id => 'N' + id);
eq('trade built only when completed', Object.keys(bt), ['trade:13481192']);
eq('trade buy parsed', [bt['trade:13481192'].dir, bt['trade:13481192'].amount, bt['trade:13481192'].items[0].qty, bt['trade:13481192'].items[0].name], ['buy', 5000000, 1000, 'N269']);
eq('trade id from link', T.tradeIdOf({ data: { trade_id: '[<a href = "/trade.php#step=view&ID=13481952">view</a>]' } }), '13481952');
eq('open lots exposed', T.computeFlips({ a: tx.a, b: tx.b, c: tx.c }).open[267].map(l => l.qty), [3]);
// PawnHub (layout inferred from a screenshot)
const phHtml = `<body><div>PAWNHUB RECEIPT</div><h1>Trade #13481517</h1><div>Saved 2026-10-08 05:04:31 UTC for trade #13481517.</div>
<div class="card"><h2>Summary</h2><div><div><span>Rosiestarfish</span><span>$1,767,500</span></div><div><span>Camel Plushie</span><small>25 x $70,700</small></div><b>$1,767,500</b></div></div></body>`;
const ph = T.parsePawnHub(new JSDOM(phHtml).window.document, 'https://z0cl.eu/PawnHub/trade_receipt.php?r=x');
eq('PawnHub parse', [ph.tradeId, ph.total, ph.items, ph.party], [13481517, 1767500, [{ id: null, name: 'Camel Plushie', qty: 25, price: 70700 }], 'Rosiestarfish']);
eq('PawnHub rejects total mismatch', T.parsePawnHub(new JSDOM(phHtml.replace('<b>$1,767,500</b>', '').replace('<span>$1,767,500</span>', '<span>$1</span>')).window.document, 'u'), null);
// direct sends are batched per player within 30 minutes
const sp = { s1: { ts: 1000, kind: 'send', cp: 7, items: [{ id: 385, qty: 10 }] }, s2: { ts: 1500, kind: 'send', cp: 7, items: [{ id: 385, qty: 5 }, { id: 276, qty: 2 }] },
  s3: { ts: 9000, kind: 'send', cp: 7, items: [{ id: 385, qty: 1 }] }, s4: { ts: 1200, kind: 'send', cp: 8, items: [{ id: 385, qty: 3 }] }, r1: { ts: 1100, kind: 'recv', cp: 7, items: [{ id: 5, qty: 4 }] } };
const sb = Object.values(T.buildSendTxs(sp, id => 'N' + id)).sort((a, b) => a.ts - b.ts);
eq('each send is its own record', sb.length, 5);
eq('send keeps its own items', sb.filter(b => b.channel === 'send' && b.cp === 7).map(b => b.items.map(i => i.id + ':' + i.qty).join()).sort(), ['276:2,385:5', '385:1', '385:10']);
// PawnHub balance page
const balHtml = `<body><table><tr><th>TIME</th><th>ITEM</th><th>ROLE</th><th>QTY</th><th>UNIT</th><th>TOTAL</th></tr>
<tr><td>2026-10-08 06:21 UTC</td><td>Tribulus Omanense</td><td>Trader</td><td>224</td><td>$60,450</td><td>$13,540,800</td></tr>
<tr><td>2026-10-08 06:16 UTC</td><td>Kitten Plushie</td><td>Trader</td><td>1,678</td><td>$650</td><td>$1,090,700</td></tr>
<tr><td>2026-10-08 06:53 UTC</td><td>Trader payout credit #1702</td><td>Trader_payout_credit</td><td>1</td><td>$112,000,000</td><td>$112,000,000</td></tr></table></body>`;
const bal = T.parsePawnHubBalance(new JSDOM(balHtml).window.document, 'u');
eq('PawnHub balance parse', [bal.events.length, bal.events[0].ts, bal.events[0].qty, bal.events[0].total], [3, Date.UTC(2026, 9, 8, 6, 21) / 1000, 224, 13540800]);
const dbl = T.parsePawnHubBalance(new JSDOM(balHtml.replace('</table>', '</table>') + balHtml).window.document, 'u');
eq('doubled balance page is counted once', [dbl.events.length, dbl.halved], [3, true]);
eq('single balance page is not halved', !!bal.halved, false);
const balTxs = { s1: { id: 's1', channel: 'send', dir: 'sell', ts: Date.UTC(2026, 9, 8, 6, 20, 49) / 1000, items: [{ id: 385, qty: 224 }] },
  s2: { id: 's2', channel: 'send', dir: 'sell', ts: Date.UTC(2026, 9, 8, 6, 16, 5) / 1000, items: [{ id: 215, qty: 1678 }] },
  s3: { id: 's3', channel: 'send', dir: 'sell', ts: Date.UTC(2026, 9, 7, 6, 16, 5) / 1000, items: [{ id: 215, qty: 1678 }] } };
const hits = T.matchPawnHubEvents(bal.events, balTxs, { 'tribulus omanense': 385, 'kitten plushie': 215 });
eq('balance events match sends by item, qty and time', hits.map(h => [h.txId, h.event.total]).sort(), [['s1', 13540800], ['s2', 1090700]]);
{ const src = require('fs').readFileSync(__dirname + '/torn-flip-profit-tracker.user.js', 'utf8'); const h = (src.match(/@version\s+(\S+)/) || [])[1], c = (src.match(/const VERSION = '([^']+)'/) || [])[1]; eq('VERSION matches header', c, h); }
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
