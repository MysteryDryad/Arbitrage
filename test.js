globalThis.__TFP_TEST = true;
const { JSDOM } = require('jsdom');
const T = require('./torn-flip-profit-tracker.user.js');
let fail = 0;
const pending = []; // async tests
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


// Crime items: free stock at cost 0
{
  const by = { daffodil: 1, 'bunch of carnations': 2, candle: 3 };
  const c1 = T.crimeTx({ id: 'x1', timestamp: 10, data: { text: 'You used 2 nerve successfully searching the cemetery gaining 3x Bunch of Carnations, 1x Candle' } }, by);
  eq('crime parses two items', c1.tx.items.map(i => [i.id, i.qty]), [[2, 3], [3, 1]]);
  eq('crime money is ignored', T.crimeTx({ id: 'x2', timestamp: 10, data: { text: 'You used 2 nerve successfully searching the cemetery gaining $238' } }, by), null);
  eq('crime failure is ignored', T.crimeTx({ id: 'x3', timestamp: 10, data: { text: 'You used 2 nerve and failed searching the cemetery' } }, by), null);
  eq('crime unknown item reported', T.crimeTx({ id: 'x4', timestamp: 10, data: { text: 'You used 2 nerve successfully searching the cemetery gaining 2x Mystery' } }, by).unknown, ['Mystery']);
  const c3 = T.crimeTx({ id: 'x6', timestamp: 11, details: { title: 'Crime success item gain (new)' }, data: { items: [{ id: 1, uid: null, qty: 5 }, { id: 3, qty: 1 }] } }, by);
  eq('crime item gain parses structured items', c3.tx.items.map(i => [i.id, i.qty]), [[1, 5], [3, 1]]);
  eq('crime money gain title is ignored', T.crimeTx({ id: 'x7', timestamp: 11, details: { title: 'Crime success money gain (new)' }, data: { money: 238 } }, by), null);
  const c2 = T.crimeTx({ id: 'x5', timestamp: 10, data: { text: 'You used 2 nerve successfully searching the cemetery gaining 5x Daffodil' } }, by).tx;
  const rc = T.computeFlips({ [c2.id]: c2, s: { id: 's', ts: 20, dir: 'sell', channel: 'market', items: [{ id: 1, qty: 5, price: null }], amount: 1000 } });
  eq('crime item sells with cost 0', [rc.flips[0].profit, rc.flips[0].unmatched], [1000, 0]);
}

// Item abroad sell is read as a sale
{
  const e = { id: 'ab1', timestamp: 7, details: { title: 'Item abroad sell' }, data: { item: 200, quantity: 27, value_each: 29153, total_value: 787131, area: 'in South Africa' } };
  const rule = T.LOG_RULES.find(r => r.re.test('Item abroad sell'));
  const tx = T.parseLogEntry(e, rule, id => 'Item ' + id);
  eq('abroad sell parses as a sale with its total', [tx.channel, tx.dir, tx.items[0].qty, tx.amount], ['abroad', 'sell', 27, 787131]);
}

// Download speed slider helpers
eq('rate estimate at 60/min', T.rateEstimate(60), '1 min 40 s');
eq('rate estimate at 80/min', T.rateEstimate(80), '1 min 15 s');
eq('rate estimate at 20/min', T.rateEstimate(20), '5 min');
eq('rate is clamped to 20..80 in steps of 10', [T.clampRate(5), T.clampRate(100), T.clampRate(64), T.clampRate(undefined)], [20, 80, 60, 60]);
eq('pause between pages at 60/min', T.ratePause(60), 750);

// Museum exchange and points market
{
  const names = ['Jaguar Plushie', 'Lion Plushie', 'Panda Plushie', 'Monkey Plushie', 'Chamois Plushie', 'Wolverine Plushie', 'Nessie Plushie', 'Red Fox Plushie', 'Camel Plushie', 'Kitten Plushie', 'Teddy Bear Plushie', 'Sheep Plushie', 'Stingray Plushie'];
  const by = {}; names.forEach((n, i) => { by[n.toLowerCase()] = 100 + i; });
  const ex = { id: 'M1', timestamp: 1795428718, details: { title: 'Museum exchange' }, data: { set: 'Plushie Set', quantity: 592, points_received: 5920 } };
  const m = T.museumTx(ex, by);
  eq('plushie set uses one of each of 13 items per set', [m.tx.items.length, m.tx.items[0].qty, m.tx.pointsOut, m.tx.sets], [13, 592, 5920, 592]);
  eq('unknown set is reported', T.museumTx({ id: 'M2', timestamp: 1, details: { title: 'Museum exchange' }, data: { set: 'Coin Set', quantity: 1, points_received: 10 } }, by).unknown, 'set: Coin Set');
  eq('missing item names are reported, not guessed', !!T.museumTx(ex, {}).unknown, true);
  const sell = T.pointsTx({ id: 'P1', timestamp: 1795441292, details: { title: 'Points market sell' }, data: { buyer: 2784250, quantity: 5000, cost_each: 33350, cost_total: 166750000, listing_id: 1 } });
  eq('points sale parses', [sell.dir, sell.channel, sell.items[0].qty, sell.amount], ['sell', 'points', 5000, 166750000]);
  const use = T.pointsTx({ id: 'P2', timestamp: 5, details: { title: 'Points energy refill use' }, data: { points_used: 30, energy_increased: 150 } });
  eq('refill use parses as points used', [use.dir, use.items[0].qty], ['use', 30]);
  eq('other points titles are ignored', T.pointsTx({ id: 'P3', timestamp: 5, details: { title: 'Points market add' }, data: { quantity: 5 } }), null);
  // cost carries from items to points, refills use points without profit, sale gets the carried cost
  const tx = {
    a: { id: 'a', ts: 1, dir: 'buy', items: [{ id: 1, qty: 2, price: null }], amount: 200 },
    b: { id: 'b', ts: 2, dir: 'buy', items: [{ id: 2, qty: 2, price: null }], amount: 400 },
    c: { id: 'c', ts: 3, dir: 'convert', channel: 'museum', items: [{ id: 1, qty: 2 }, { id: 2, qty: 2 }], pointsOut: 20, sets: 2, setName: 'x', amount: null },
    u: { id: 'u', ts: 4, dir: 'use', channel: 'points', items: [{ id: -1, qty: 5 }], amount: 0 },
    s: { id: 's', ts: 5, dir: 'sell', channel: 'points', items: [{ id: -1, qty: 15, price: null }], amount: 900 }
  };
  const r = T.computeFlips(tx);
  eq('exchange row carries the item cost', [r.converts[0].cost, r.converts[0].points], [600, 20]);
  eq('points sale profit uses the carried cost', r.flips[0].profit, 900 - 15 * 30);
  eq('refill use is not a pending item or a flip', [r.pending.length, r.flips.length], [0, 1]);
  const r2 = T.computeFlips({ c: tx.c, s: { id: 's', ts: 5, dir: 'sell', channel: 'points', items: [{ id: -1, qty: 10, price: null }], amount: 500 } });
  eq('exchange with no earlier buys has unknown cost and its sale is not counted', [r2.converts[0].cost, r2.flips[0].profit], [null, null]);
  // bought points join the same stock
  const r3 = T.computeFlips({ b: { id: 'b', ts: 1, dir: 'buy', channel: 'points', items: [{ id: -1, qty: 10, price: null }], amount: 300 }, s: { id: 's', ts: 2, dir: 'sell', channel: 'points', items: [{ id: -1, qty: 10, price: null }], amount: 500 } });
  eq('bought points sell at their cost', r3.flips[0].profit, 200);
}

// Watch list: real log types that the rules do not already read
{
  const lt = require('./fixtures/logtypes.json').logtypes;
  const bad = T.WATCH_IDS.filter(id => !lt.some(x => x.id === id));
  const modelled = T.WATCH_IDS.filter(id => T.LOG_RULES.some(r => r.re.test((lt.find(x => x.id === id) || {}).title || '')));
  eq('watch ids all exist in the log type list', bad, []);
  eq('watch ids are not types the main rules already read', modelled, []);
}
// The log request must never carry a log=<ids> filter: Torn accepts 10 ids at most and silently returns nothing for more
eq('a log page request has no id filter', [Object.keys(T.logParams(100, null)).sort(), Object.keys(T.logParams(100, 50)).sort()], [['from', 'limit'], ['from', 'limit', 'to']]);


// Selling items to a shop for points is not a cash sale
{
  const cash = T.LOG_RULES.find(r => r.re.test('Item shop sell'));
  eq('item shop sell is still a cash sale', [cash.channel, cash.dir], ['shop', 'sell']);
  eq('item shop sell points is not read as a cash sale', T.LOG_RULES.some(r => r.re.test('Item shop sell points')), false);
}
// Background tick: a first or half-done read continues by itself, even while hidden
{
  const base = { setup: true, key: true, running: false, busy: false, lastSync: 100, resume: null, hidden: false, now: 10000, syncedAt: 9000, failAt: 0 };
  eq('normal refresh when due and visible', T.autoSyncMode(base), 'normal');
  eq('normal refresh waits while hidden', T.autoSyncMode(Object.assign({}, base, { hidden: true })), null);
  eq('first read continues by itself', T.autoSyncMode(Object.assign({}, base, { lastSync: 0 })), 'catchup');
  eq('half-done read continues by itself, even hidden', T.autoSyncMode(Object.assign({}, base, { resume: { to: 5 }, hidden: true })), 'catchup');
  eq('a read that just failed waits two minutes', T.autoSyncMode(Object.assign({}, base, { resume: { to: 5 }, failAt: 9950 })), null);
  eq('nothing starts while a sync is running', T.autoSyncMode(Object.assign({}, base, { resume: { to: 5 }, running: true })), null);
  eq('nothing starts before setup or without a key', [T.autoSyncMode(Object.assign({}, base, { lastSync: 0, setup: false })), T.autoSyncMode(Object.assign({}, base, { lastSync: 0, key: false }))], [null, null]);
}

// Items used up take stock oldest-first, free finds and drops included
{
  const r = T.computeFlips({
    f: { id: 'f', ts: 1, dir: 'buy', channel: 'find', free: true, amount: 0, items: [{ id: 7, qty: 5, price: 0 }] },
    u: { id: 'u', ts: 3, dir: 'use', channel: 'use', items: [{ id: 7, qty: 3 }], amount: 0 },
    s: { id: 's', ts: 4, dir: 'sell', channel: 'market', items: [{ id: 7, qty: 2, price: null }], amount: 1000 },
    t: { id: 't', ts: 5, dir: 'sell', channel: 'market', items: [{ id: 7, qty: 3, price: null }], amount: 900 }
  });
  eq('a use takes 3 of the 5 free finds, so 2 are left to sell', [r.flips[0].profit, r.flips[0].unmatched], [1000, 0]);
  eq('selling more than is left shows the shortfall', [r.flips[1].profit, r.flips[1].unmatched], [null, 3]);
}
// Free item gains from the game: recognised shapes only
{
  const mk = (title, data) => T.useGainTx({ id: 'g', timestamp: 1, details: { title }, data });
  eq('city find with a single item id', mk('City item find', { item: 530, quantity: 2 }).items.map(i => [i.id, i.qty]), [[530, 2]]);
  eq('event find with an item list', mk('Christmas town find item', { items: [{ id: 5, qty: 1 }, { id: 6, qty: 2 }] }).items.map(i => [i.id, i.qty]), [[5, 1], [6, 2]]);
  eq('prize with an items_gained map', mk('Choose your prize item', { items_gained: { '77': 3 } }).items.map(i => [i.id, i.qty]), [[77, 3]]);
  eq('a shape we do not recognise adds nothing', mk('City item find', { found: 'a thing' }), null);
  eq('gain types are free stock', [mk('Stock special item', { item: 9 }).free, mk('Stock special item', { item: 9 }).amount], [true, 0]);
}
// A refused key stops background retries
{
  const base = { setup: true, key: true, running: false, busy: false, lastSync: 0, resume: null, hidden: false, now: 10000, syncedAt: 0, failAt: 0 };
  eq('background read retries normally', T.autoSyncMode(base), 'catchup');
  eq('background read stops after the key was refused', T.autoSyncMode(Object.assign({}, base, { keyBad: true })), null);
}

// Moving data between devices: copy, check, merge
pending.push((async () => {
  const mkTx = (id, extra) => Object.assign({ id, ts: 1790000000, dir: 'buy', channel: 'market', items: [{ id: 5, qty: 2, name: 'X', price: null }], amount: 100, src: 'log', locked: false }, extra || {});
  const phone = { me: { id: 7, name: 'Me' }, lastSync: 1790000500, txs: { a: mkTx('a'), b: mkTx('b', { dir: 'sell', amount: null }), c: mkTx('c', { amount: 300, src: 'manual', locked: true }) }, ack: { b: 1 }, names: { 5: 'Bob' } };
  const text = await T.packData(phone);
  eq('copied data starts with the Arbitrage marker', text.indexOf('TFPD1.'), 0);
  const pkg = T.sanitizePackage(await T.unpackData(text));
  eq('copy then paste keeps every record', Object.keys(pkg.txs).sort(), ['a', 'b', 'c']);
  // cut off, damaged, wrong kind of text
  let msgs = [];
  for (const bad of [text.slice(0, Math.floor(text.length / 2)), text.slice(0, 60) + 'AAAA' + text.slice(64), 'hello world', '']) { try { await T.unpackData(bad); msgs.push('accepted'); } catch (e) { msgs.push('refused'); } }
  eq('cut off, damaged or foreign text is refused', msgs, ['refused', 'refused', 'refused', 'refused']);
  eq('line breaks added by a messenger are tolerated', Object.keys(T.sanitizePackage(await T.unpackData(text.replace(/(.{60})/g, '$1\n')))).length > 0, true);
  // bad records are skipped, not trusted
  const dirty = T.sanitizePackage({ app: 'arbitrage', fmt: 1, txs: { good: mkTx('good'), noitems: { id: 'x', ts: 1790000000, items: [] }, badts: mkTx('badts', { ts: 5 }), proto: mkTx('__proto__'), strAmt: mkTx('strAmt', { amount: 'lots' }), negq: mkTx('negq', { items: [{ id: 1, qty: -4 }] }) } });
  eq('invalid records are skipped', [Object.keys(dirty.txs), dirty.skipped], [['good'], 5]);
  eq('data from a newer format is refused', (() => { try { T.sanitizePackage({ app: 'arbitrage', fmt: 9, txs: { a: mkTx('a') } }); return 'accepted'; } catch (e) { return 'refused'; } })(), 'refused');
  eq('a different Torn account is refused', [T.sameAccount({ id: 7 }, { id: '7', name: 'Me' }), T.sameAccount({ id: 7 }, { id: 8, name: 'Other' }) !== null], [null, true]);
  // merge: add what is missing, keep own values, fill gaps, never delete
  const pc = { me: { id: 7 }, lastSync: 1790009000, txs: { a: mkTx('a'), b: mkTx('b', { dir: 'sell', amount: null }), z: mkTx('z') }, ack: {}, names: {} };
  const dry = T.mergeDevice(pc, pkg, true);
  eq('preview counts without changing anything', [dry, Object.keys(pc.txs).sort()], [{ added: 1, filled: 0, same: 2, conflicts: 0 }, ['a', 'b', 'z']]);
  const r = T.mergeDevice(pc, pkg);
  eq('merge adds the missing record and keeps the extra one', Object.keys(pc.txs).sort(), ['a', 'b', 'c', 'z']);
  eq('merge keeps this device\'s own sync position', pc.lastSync, 1790009000);
  eq('merge unions the dismissed list and names', [pc.ack.b, pc.names[5]], [1, 'Bob']);
  const pc2 = { me: { id: 7 }, txs: { c: mkTx('c', { amount: 999, src: 'manual', locked: true }) }, ack: {}, names: {} };
  eq('a value on both devices stays as this device has it', [T.mergeDevice(pc2, pkg).conflicts, pc2.txs.c.amount], [1, 999]);
  const pc3 = { me: { id: 7 }, txs: { b: mkTx('b', { dir: 'sell', amount: null }) }, ack: {}, names: {} };
  const pkg3 = T.sanitizePackage({ app: 'arbitrage', fmt: 1, me: { id: 7 }, txs: { b: mkTx('b', { dir: 'sell', amount: 777, src: 'manual', locked: true }) } });
  T.mergeDevice(pc3, pkg3);
  eq('an amount entered on the other device fills this device\'s gap', [pc3.txs.b.amount, pc3.txs.b.src], [777, 'manual']);
})());

// Settings pieces render without errors
{
  const sum = T.dataSummaryHtml(), mv = T.moveDataHtml();
  eq('data summary line shows version and records', [/v0\.1\.\d+-beta/.test(sum), /records/.test(sum)], [true, true]);
  eq('move data section has copy, paste, check and no replace button', [/data-act="mvcopy"/.test(mv), /id="tfp-mv"/.test(mv), /data-act="mvcheck"/.test(mv), /data-act="import"/.test(mv)], [true, true, true, false]);
}
// A TornW3B key that was refused is treated as off until it changes
eq('refused key is off, a new key is on again', [T.isW3bDenied('abc', 'abc'), T.isW3bDenied('abc', 'def'), T.isW3bDenied('', 'abc'), T.isW3bDenied('abc', '')], [true, false, false, false]);
// Cost typed in for one sale
{
  const buys = { a: { id: 'a', ts: 1, dir: 'buy', channel: 'market', items: [{ id: 7, qty: 2, price: null }], amount: 200 }, b: { id: 'b', ts: 2, dir: 'buy', channel: 'market', items: [{ id: 7, qty: 1, price: null }], amount: 300 } };
  const sale = over => Object.assign({ id: 's', ts: 3, dir: 'sell', channel: 'send', items: [{ id: 7, qty: 1, price: null }], amount: 350, src: 'receipt' }, over);
  const auto = T.computeFlips(Object.assign({}, buys, { s: sale() }));
  eq('without a typed cost the oldest buy is used', [auto.flips[0].profit, auto.flips[0].costManual], [350 - 100, false]);
  const man = T.computeFlips(Object.assign({}, buys, { s: sale({ costOverride: 300 }) }));
  eq('a typed cost replaces the matched cost', [man.flips[0].profit, man.flips[0].costManual, man.flips[0].lines[0].cost], [50, true, 300]);
  const zero = T.computeFlips(Object.assign({}, buys, { s: sale({ costOverride: 0 }) }));
  eq('a typed cost of zero is allowed', zero.flips[0].profit, 350);
  // the stock is still used up: the next sale takes the next buy, not the same one again
  const two = T.computeFlips(Object.assign({}, buys, { s: sale({ costOverride: 300 }), t: sale({ id: 't', ts: 4 }) }));
  eq('stock is still used up by a sale with a typed cost', two.flips.find(f => f.tx.id === 't').profit, 350 - 100);
  // a sale with no matching buy becomes counted once a cost is typed in
  const none = T.computeFlips({ s: sale({ costOverride: 120 }) });
  const none0 = T.computeFlips({ s: sale() });
  eq('a sale with no matching buy is counted once a cost is typed in', [none.flips[0].profit, none.flips[0].unmatched, none0.flips[0].profit], [230, 0, null]);
  // two items share the typed cost by their weight
  const multi = T.computeFlips({ s: { id: 's', ts: 3, dir: 'sell', channel: 'send', items: [{ id: 1, qty: 1, price: 100 }, { id: 2, qty: 1, price: 300 }], amount: 400, costOverride: 200 } });
  eq('the typed cost is shared across the items of a sale', [multi.flips[0].profit, multi.flips[0].lines.map(l => Math.round(l.cost))], [200, [50, 150]]);
}
// A typed cost survives moving data between devices
pending.push((async () => {
  const mk = extra => Object.assign({ id: 's', ts: 1790000000, dir: 'sell', channel: 'send', items: [{ id: 7, qty: 1, name: 'X', price: null }], amount: 350, src: 'receipt', locked: true }, extra || {});
  const pkg = T.sanitizePackage(await T.unpackData(await T.packData({ me: { id: 7 }, txs: { s: mk({ costOverride: 300 }) } })));
  eq('a typed cost is kept in copied data', pkg.txs.s.costOverride, 300);
  const mine = { me: { id: 7 }, txs: { s: mk() }, ack: {}, names: {} };
  eq('preview counts it as a fill', T.mergeDevice(mine, pkg, true), { added: 0, filled: 1, same: 0, conflicts: 0 });
  T.mergeDevice(mine, pkg);
  eq('merge brings the typed cost over', mine.txs.s.costOverride, 300);
  const mine2 = { me: { id: 7 }, txs: { s: mk({ costOverride: 111 }) }, ack: {}, names: {} };
  T.mergeDevice(mine2, pkg);
  eq('this device keeps its own typed cost', mine2.txs.s.costOverride, 111);
})().catch(e => { fail++; console.log('FAIL typed cost merge test', e.message); }));

// Sends with no value are listed for people who do not use PawnHub, and still leave stock
{
  const txs = { b: { id: 'b', ts: 1, dir: 'buy', channel: 'market', items: [{ id: 3, qty: 5, price: null }], amount: 500 }, s: { id: 's', ts: 2, dir: 'sell', channel: 'send', items: [{ id: 3, qty: 2 }], amount: null }, g: { id: 'g', ts: 3, dir: 'sell', channel: 'send', items: [{ id: 3, qty: 1 }], amount: 0, gift: true, src: 'manual', locked: true } };
  const plain = T.computeFlips(txs, { skipUnvaluedSends: true }), ph = T.computeFlips(txs, { skipUnvaluedSends: false });
  eq('a plain send with no value is listed, not nagged about', [plain.unvalued.map(t => t.id), plain.pending.length], [['s'], 0]);
  eq('PawnHub users keep these sends in Needs attention', [ph.unvalued.length, ph.pending.map(t => t.id)], [0, ['s']]);
  eq('both kinds of send still leave stock', [plain.open[3].reduce((a, l) => a + l.qty, 0), ph.open[3].reduce((a, l) => a + l.qty, 0)], [2, 2]);
}
// Delete my data: every stored key goes, and a page that still holds old data cannot write it back
pending.push((async () => {
  const store = { tfp_state: '{"txs":{"a":1}}', tfp_apikey: '"KEY"', tfp_phkey: '"PH"', tfp_w3bkey: '"W3"', tfp_startDays: '30', tfp_inbox: '[1]', tfp_bglock: '123', other_site_key: 'keep' };
  globalThis.localStorage = { get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i] || null, getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  await T.deleteAllData();
  await new Promise(r => setTimeout(r, 20)); // let the page's own start-up saves run: they may write an EMPTY record, never the old data
  const left = Object.keys(store).filter(k => k.indexOf('tfp_') === 0).sort(), st = store.tfp_state ? JSON.parse(store.tfp_state) : { txs: {} };
  eq('deleting my data removes every key and saved record, and leaves other sites alone', [left.filter(k => k !== 'tfp_state' && k !== 'tfp_wipedAt'), Object.keys(st.txs || {}).length, store.other_site_key], [[], 0, 'keep']);
  eq('the in-memory data is empty after a delete', Object.keys(T.getStateForTest().txs).length, 0);
  delete globalThis.localStorage;
})());
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
{ const e = { id: 'a1', timestamp: 5, details: { title: 'Item abroad buy' }, data: { item: 385, amount: 100, cost_each: 600 } }; const rule = T.LOG_RULES.find(r => r.re.test('Item abroad buy')); const tx = T.parseLogEntry(e, rule, id => 'N' + id); eq('abroad buy becomes a stock buy', [tx.dir, tx.channel, tx.items[0].qty, tx.amount], ['buy', 'abroad', 100, 60000]); }
{ const stale = { txs: { s1: { id: 's1', amount: null, src: null, items: [{ id: 1, qty: 1 }] } }, receipts: {}, w3b: { done: {} } }, fresh = { txs: { s1: { id: 's1', amount: 500, src: 'receipt', locked: true, items: [{ id: 1, qty: 1, price: 500 }] }, s2: { id: 's2', amount: 7, src: 'manual', locked: true, items: [{ id: 2, qty: 1 }] } }, receipts: {}, w3b: { done: { x: 1 } }, lastSync: 9 };
  const m = T.mergeState(stale, fresh); eq('stale copy keeps values from the newer copy', [m.txs.s1.amount, m.txs.s1.locked, !!m.txs.s2, m.w3b.done.x, m.lastSync], [500, true, true, 1, 9]); }
{ const e = { id: 's1', timestamp: 5, details: { title: 'Item shop sell' }, data: { item: 8, quantity: 1, value_each: 3000, total_value: 3000, area: "to Big Al's Gun Shop" } }; const rule = T.LOG_RULES.find(r => r.re.test('Item shop sell')); const tx = T.parseLogEntry(e, rule, id => 'N' + id); eq('shop sell is read with its real fields', [tx.dir, tx.channel, tx.items[0].id, tx.items[0].qty, tx.amount], ['sell', 'shop', 8, 1, 3000]); }
Promise.all(pending).then(() => { console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0); }).catch(e => { console.log('FAIL async test error', e && e.message); process.exit(1); });
