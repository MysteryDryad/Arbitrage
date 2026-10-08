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
console.log(fail ? fail + ' FAILED' : 'ALL PASSED');
process.exit(fail ? 1 : 0);
