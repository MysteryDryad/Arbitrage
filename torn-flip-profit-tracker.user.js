// ==UserScript==
// @name         Arbitrage
// @namespace    torn-flip-profit-tracker
// @version      0.1.32-beta
// @description  Tracks bazaar, market and trade flip profit (FIFO) from the Torn API, with Weaver and TornExchange receipts.
// @match        https://www.torn.com/*
// @match        https://tornexchange.com/receipt/*
// @match        https://weav3r.dev/receipt/*
// @match        https://z0cl.eu/PawnHub/trade_receipt.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      tornexchange.com
// @connect      weav3r.dev
// @connect      z0cl.eu
// @updateURL    https://update.greasyfork.org/scripts/599222/Arbitrage.user.js
// @downloadURL  https://update.greasyfork.org/scripts/599222/Arbitrage.user.js
// @run-at       document-idle
// ==/UserScript==

/*
 * BETA NOTES
 * - Works in Torn PDA and in Tampermonkey/Violentmonkey.
 * - Read-only: it only reads the Torn API and never performs game actions.
 * - The log parsing (LOG_RULES, pickItems, pickMoney) is written from the documented
 *   structure of the v2 log and has NOT been tested against live data yet.
 *   Use Settings > "Copy debug sample" and send the result back so the parser can be fixed.
 * - Item-market sale amounts are used exactly as the log records them (fees not adjusted).
 */
(function () {
  'use strict';

  /* ===================== environment helpers ===================== */
  const NS = 'tfp_';
  const PDA_KEY = '###PDA-APIKEY###';
  const IN_PDA = PDA_KEY[0] !== '#';
  const IS_PDA_ENV = IN_PDA || typeof PDA_httpGet === 'function' || (typeof window !== 'undefined' && !!window.flutter_inappwebview);
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  // Values are written to both script storage (GM) and the page's localStorage. Reads try GM first and fall back
  // to localStorage when GM has nothing usable (PDA may return odd placeholders after an update).
  let lastSaveOk = true;
  const bootInfo = {};
  function readStore(k, which) {
    try {
      const r = which === 'gm' ? GM_getValue(NS + k) : localStorage.getItem(NS + k);
      if (r == null || r === '' || r === 'undefined' || r === 'null') return undefined;
      return typeof r === 'string' ? JSON.parse(r) : r;
    } catch (e) { return undefined; }
  }
  function sget(k, d) {
    let v = hasGM ? readStore(k, 'gm') : undefined;
    if (k === 'state') bootInfo.fromGM = v !== undefined;
    if (v === undefined) v = readStore(k, 'ls');
    if (k === 'state') bootInfo.fromLS = !bootInfo.fromGM && v !== undefined;
    return v === undefined ? d : v;
  }
  function sset(k, v) {
    const raw = JSON.stringify(v);
    let ok = false;
    if (hasGM) { try { GM_setValue(NS + k, raw); ok = true; } catch (e) { console.warn('[TFP] GM storage failed', e); } }
    try { localStorage.setItem(NS + k, raw); ok = true; } catch (e) { console.warn('[TFP] localStorage failed', e); }
    return ok;
  }

  // IndexedDB holds the big data (state, item names): GM/localStorage silently fail for large values on some setups.
  const idb = {
    dbp: null,
    open() { return new Promise((res, rej) => { try { const r = indexedDB.open('tfp', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    db() { return this.dbp || (this.dbp = this.open()); },
    async get(k) { const db = await this.db(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const db = await this.db(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
  };
  const hasIDB = typeof indexedDB !== 'undefined';
  let idbErr = null;


  function http(url) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url, {}).then(r => resolve({ status: r.status || r.statusCode, text: r.responseText })).catch(reject);
        return;
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url,
          onload: r => resolve({ status: r.status, text: r.responseText }),
          onerror: reject, ontimeout: reject
        });
        return;
      }
      fetch(url).then(async r => resolve({ status: r.status, text: await r.text() })).catch(reject);
    });
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove(); return ok;
    } catch (e) { return false; }
  }

  /* ===================== formatting ===================== */
  const fmt = n => n == null ? '?' : (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function firstNumber(s) {
    const m = String(s || '').match(/\$?\s*([\d,]+(?:\.\d+)?)/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }
  function parseTimeText(t) {
    if (!t) return null;
    const norm = String(t).replace(/a\.m\./i, 'AM').replace(/p\.m\./i, 'PM')
      .replace(/^([A-Za-z]{3,4})\./, '$1').replace(/,\s*(\d)/g, ', $1');
    const ms = Date.parse(norm);
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }

  /* ===================== receipt parsers (work on any Document) ===================== */
  function leafTexts(doc) {
    const out = [];
    doc.querySelectorAll('body *').forEach(el => {
      if (el.children.length === 0) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      }
    });
    return out;
  }

  function parseTornExchange(doc, url) {
    const leaves = leafTexts(doc);
    let buyer = null, seller = null, total = null;
    leaves.forEach(t => {
      let m;
      if ((m = t.match(/^Buyer:\s*(.+)$/i))) buyer = m[1].trim();
      if ((m = t.match(/^Seller:\s*(.+)$/i))) seller = m[1].trim();
      if ((m = t.match(/^Total:\s*(.+)$/i))) total = firstNumber(m[1]);
    });
    const items = [];
    doc.querySelectorAll('table tr').forEach(tr => {
      const td = tr.querySelectorAll('td');
      if (td.length < 5) return;
      const img = td[0].querySelector('img');
      const idm = img && (img.getAttribute('src') || '').match(/items\/(\d+)\//);
      const qty = firstNumber(td[3].textContent), price = firstNumber(td[2].textContent);
      if (!idm || !qty) return;
      items.push({ id: Number(idm[1]), name: td[1].textContent.trim(), qty, price });
    });
    if (!items.length) return null;
    if (total == null) total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const body = leafTexts(doc).join(' ');
    const tm = body.match(/(\b[A-Z][a-z]{2,4}\.? \d{1,2}, \d{4},? \d{1,2}(?::\d{2})? ?[ap]\.?m\.?)/i);
    return { source: 'tornexchange', url, tradeId: null, buyer, seller, buyerId: null, sellerId: null, items, total, timeText: tm ? tm[1] : null, ts: tm ? parseTimeText(tm[1]) : null };
  }

  function parseWeaver(doc, url) {
    const body = leafTexts(doc).join(' ');
    const tid = body.match(/Trade ID\s*(\d+)/i);
    const sid = body.match(/Seller\s*\[(\d+)\]/i), bid = body.match(/Buyer\s*\[(\d+)\]/i);
    let seller = null, buyer = null;
    leafTexts(doc).forEach(t => {
      const m = t.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
      if (m && !seller && t.length < 80) { seller = m[1].trim(); buyer = m[2].trim(); }
    });
    const items = [];
    doc.querySelectorAll('table tr').forEach(tr => {
      const td = tr.querySelectorAll('td');
      if (td.length < 5) return;
      const first = td[0].textContent.replace(/\s+/g, ' ').trim();
      const m = first.match(/^(.*?)\s*ID:\s*(\d+)/i);
      if (!m) return;
      const qty = firstNumber(td[1].textContent), price = firstNumber(td[2].textContent);
      if (!qty || price == null) return;
      items.push({ id: Number(m[2]), name: m[1].trim(), qty, price });
    });
    if (!items.length) return null;
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const tm = body.match(/Trade ID\s*\d+\s*·?\s*([A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2} ?[AP]M)/i);
    return {
      source: 'weaver', url, tradeId: tid ? Number(tid[1]) : null, buyer, seller,
      buyerId: bid ? Number(bid[1]) : null, sellerId: sid ? Number(sid[1]) : null,
      items, total, timeText: tm ? tm[1] : null, ts: tm ? parseTimeText(tm[1]) : null
    };
  }


  // PawnHub receipts show one party card: name, total, then "Item  qty x $price" rows. No item IDs, no buyer/seller labels:
  // ids are resolved from item names when the receipt is added in Torn. The party shown is always the seller.
  function parsePawnHub(doc, url) {
    const leaves = leafTexts(doc);
    const tid = leaves.join(' ').match(/Trade\s*#(\d+)/i);
    const items = [];
    leaves.forEach((t, i) => {
      let m = t.match(/^(\d[\d,]*)\s*[x×]\s*\$?\s*([\d,]+)$/i), name = null;
      if (m) name = leaves[i - 1];
      else if ((m = t.match(/^(.+?)\s+(\d[\d,]*)\s*[x×]\s*\$?\s*([\d,]+)$/i))) { name = m[1]; m = [null, m[2], m[3]]; }
      if (!m || !name) return;
      items.push({ id: null, name: name.trim(), qty: Number(m[1].replace(/,/g, '')), price: Number(m[2].replace(/,/g, '')) });
    });
    if (!tid || !items.length) return null;
    const total = items.reduce((a, i) => a + i.qty * i.price, 0);
    // Safety check: the page must show a total equal to what we computed, otherwise we may have misread it.
    const idx = leaves.findIndex(t => /^\$[\d,]+$/.test(t) && firstNumber(t) === total);
    const inline = leaves.some(t => /^.+\s\$[\d,]+$/.test(t) && firstNumber(t.replace(/^.*\s(\$[\d,]+)$/, '$1')) === total);
    if (idx < 0 && !inline) return null;
    return { source: 'pawnhub', url, tradeId: Number(tid[1]), buyer: null, seller: null, buyerId: null, sellerId: null, party: idx > 0 ? leaves[idx - 1] : null, items, total, timeText: null, ts: null };
  }

  function parseReceiptDoc(doc, url) {
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();
    if (/tornexchange/i.test(host)) return parseTornExchange(doc, url);
    if (/weav3r/i.test(host)) return parseWeaver(doc, url);
    if (/z0cl/i.test(host)) return parsePawnHub(doc, url);
    return null;
  }

  async function fetchReceipt(url) {
    const r = await http(url);
    if (!r || r.status >= 400) throw new Error('Could not load receipt (HTTP ' + (r && r.status) + ')');
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    return parseReceiptDoc(doc, url);
  }

  /* ===================== ledger engine (pure) ===================== */
  function computeFlips(txsObj, opts) {
    const fee = (opts && opts.marketFee) || 0;
    // Fee applies only to item-market sales whose amount came from the log (receipt/manual values are used as entered).
    const net = tx => (tx.channel === 'market' && tx.dir === 'sell' && tx.src === 'log') ? tx.amount * (1 - fee) : tx.amount;
    const txs = Object.values(txsObj).sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
    const lots = {};
    const flips = [], pending = [];

    function addLots(tx) {
      const totalQty = tx.items.reduce((s, i) => s + i.qty, 0) || 1;
      const allPriced = tx.items.every(i => i.price != null);
      tx.items.forEach(i => {
        let unit = null;
        if (allPriced) unit = i.price;
        else if (tx.amount != null) unit = tx.amount / totalQty;
        (lots[i.id] = lots[i.id] || []).push({ qty: i.qty, unit, ts: tx.ts });
      });
    }
    function consume(itemId, qty) {
      const q = lots[itemId] || [];
      let need = qty, cost = 0, unknown = false, matched = 0;
      while (need > 0 && q.length) {
        const lot = q[0];
        const take = Math.min(lot.qty, need);
        if (lot.unit == null) unknown = true; else cost += take * lot.unit;
        lot.qty -= take; need -= take; matched += take;
        if (lot.qty <= 0) q.shift();
      }
      return { cost: unknown ? null : cost, matched, unmatched: need };
    }

    for (const tx of txs) {
      if (!tx.items || !tx.items.length) continue;
      if (tx.dir === 'buy') { addLots(tx); if (tx.amount == null) pending.push(tx); continue; }
      if (tx.dir !== 'sell') { pending.push(tx); continue; }

      const consumed = tx.items.map(it => Object.assign({ it }, consume(it.id, it.qty)));
      if (tx.amount == null) { pending.push(tx); continue; }

      const allPriced = tx.items.every(i => i.price != null);
      let weights = allPriced ? tx.items.map(i => i.price * i.qty) : consumed.map(c => c.cost || 0);
      if (!weights.some(w => w > 0)) weights = tx.items.map(i => i.qty);
      const wsum = weights.reduce((s, w) => s + w, 0) || 1;

      const lines = consumed.map((c, idx) => {
        const share = net(tx) * weights[idx] / wsum;
        const matchedFrac = c.it.qty ? c.matched / c.it.qty : 0;
        const proceeds = share * matchedFrac;
        return {
          itemId: c.it.id, name: c.it.name, qty: c.it.qty, matched: c.matched, unmatched: c.unmatched,
          proceeds, cost: c.cost, profit: c.cost == null ? null : proceeds - c.cost
        };
      });
      const costUnknown = lines.some(l => l.profit == null && l.matched > 0);
      const unmatched = lines.reduce((s, l) => s + l.unmatched, 0);
      const profit = lines.some(l => l.matched > 0) && !costUnknown
        ? lines.reduce((s, l) => s + (l.profit || 0), 0) : null;
      flips.push({ tx, lines, profit, costUnknown, unmatched });
    }
    const total = flips.reduce((s, f) => s + (f.profit || 0), 0);
    return { flips, pending, total, open: lots };
  }

  /* ===================== receipt <-> trade matching (pure) ===================== */
  function roleFor(rc, me) {
    if (rc.role) return rc.role;
    if (!me) return null;
    const n = (me.name || '').toLowerCase();
    if (rc.seller && rc.seller.toLowerCase() === n) return 'sell';
    if (rc.buyer && rc.buyer.toLowerCase() === n) return 'buy';
    if (rc.sellerId && String(rc.sellerId) === String(me.id)) return 'sell';
    if (rc.buyerId && String(rc.buyerId) === String(me.id)) return 'buy';
    return null;
  }
  function itemKey(items) { return items.map(i => i.id + ':' + i.qty).sort().join(','); }
  function scoreTx(rc, tx) {
    if (!tx.items || !tx.items.length) return -1;
    let s = 0;
    if (rc.tradeId && tx.tradeId && String(rc.tradeId) === String(tx.tradeId)) s += 10;
    if (itemKey(tx.items) === itemKey(rc.items)) s += 4;
    else if (tx.items.map(i => i.id).sort().join() === rc.items.map(i => i.id).sort().join()) s += 2;
    if (tx.amount != null && tx.amount === rc.total) s += 2;
    if (rc.ts && Math.abs(tx.ts - rc.ts) < 6 * 3600) s += 1;
    if (tx.receiptUrl) s -= 5;
    return s;
  }
  function rankCandidates(rc, txsObj) {
    return Object.values(txsObj)
      .filter(tx => ['trade', 'send', 'recv'].includes(tx.channel))
      .map(tx => ({ tx, score: scoreTx(rc, tx) }))
      .filter(c => c.score >= 2)
      .sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /* ===================== log parsing (UNVERIFIED against live data) ===================== */
  const LOG_RULES = [
    { re: /bazaar.*(buy|bought|purchase)/i, channel: 'bazaar', dir: 'buy' },
    { re: /bazaar.*(sell|sold|sale)/i, channel: 'bazaar', dir: 'sell' },
    { re: /item ?market.*(buy|bought|purchase)/i, channel: 'market', dir: 'buy' },
    { re: /item ?market.*(sell|sold|sale)/i, channel: 'market', dir: 'sell' }
  ];

  function pickItems(d) {
    const out = [];
    const push = (id, qty, name) => { id = Number(id); if (id) out.push({ id, qty: Number(qty) || 1, name: name || null, price: null }); };
    if (Array.isArray(d.items)) d.items.forEach(i => push(i.id != null ? i.id : (i.item_id != null ? i.item_id : i.item), i.qty != null ? i.qty : (i.quantity != null ? i.quantity : i.amount), i.name));
    else if (d.items && typeof d.items === 'object') Object.entries(d.items).forEach(([id, q]) => push(id, typeof q === 'object' ? (q.qty || q.quantity || q.amount) : q));
    else if (d.item != null || d.item_id != null) push(d.item != null ? d.item : d.item_id, d.quantity != null ? d.quantity : (d.amount != null ? d.amount : d.qty), d.name);
    return out;
  }
  function pickMoney(d, items) {
    for (const k of ['total_cost', 'total', 'total_price', 'money', 'cost_total', 'cost', 'price', 'value']) {
      if (typeof d[k] === 'number') return d[k];
    }
    const qty = items.reduce((s, i) => s + i.qty, 0) || 1;
    for (const k of ['cost_each', 'price_each', 'cost_per', 'unit_price']) {
      if (typeof d[k] === 'number') return d[k] * qty;
    }
    return null;
  }
  function pickCounterparty(d) {
    for (const k of ['seller', 'buyer', 'user', 'target', 'sender', 'receiver', 'trader']) {
      if (d[k] != null) return typeof d[k] === 'object' ? (d[k].name || d[k].id) : d[k];
    }
    return null;
  }
  function parseLogEntry(e, rule, nameOf) {
    const d = e.data || {};
    const items = pickItems(d).map(i => Object.assign(i, { name: i.name || nameOf(i.id) }));
    const amount = rule.noMoney ? null : pickMoney(d, items);
    return {
      id: 'log:' + e.id, ts: e.timestamp, dir: rule.dir, channel: rule.channel,
      cp: pickCounterparty(d),
      tradeId: d.trade_id != null ? d.trade_id : (e.params && e.params.trade_id != null ? e.params.trade_id : null),
      items, amount, src: amount != null ? 'log' : null, locked: false,
      title: (e.details && e.details.title) || e.title || ''
    };
  }
  function normalizeLog(log) {
    if (!log) return [];
    if (Array.isArray(log)) return log;
    return Object.entries(log).map(([id, e]) => Object.assign({ id }, e));
  }


  /* ===================== trades: several log entries share parsed_trade_id ===================== */
  function tradeIdOf(e) {
    const d = e.data || {};
    if (d.parsed_trade_id != null) return String(d.parsed_trade_id);
    const m = String(d.trade_id || '').match(/ID=(\d+)/);
    return m ? m[1] : null;
  }
  function compactTradeData(d) {
    const o = {};
    ['user', 'items', 'money'].forEach(k => { if (d[k] !== undefined) o[k] = d[k]; });
    return o;
  }
  function tradeMoney(d) {
    for (const k of ['money', 'amount', 'money_gained', 'money_spent', 'cost', 'value', 'total']) {
      if (typeof d[k] === 'number') return d[k];
    }
    for (const k of Object.keys(d)) {
      if (['user', 'trade_id', 'parsed_trade_id', 'uid'].includes(k)) continue;
      if (typeof d[k] === 'number') return d[k];
    }
    return null;
  }
  // parts: { entryId: { title, ts, data } } per trade. Returns tx objects for completed trades.
  function buildTradeTxs(tradeParts, nameOf) {
    const out = {};
    Object.entries(tradeParts || {}).forEach(([tid, tp]) => {
      const parts = Object.values(tp.parts || {});
      const done = parts.find(p => /^Trade completed/i.test(p.title));
      if (!done) return;
      const of = re => parts.filter(p => re.test(p.title));
      const itemsOf = re => of(re).reduce((a, p) => a.concat(pickItems(p.data || {})), []);
      const moneyOf = re => { let found = false, sum = 0; of(re).forEach(p => { const m = tradeMoney(p.data || {}); if (m != null) { found = true; sum += m; } }); return found ? sum : null; };
      const inItems = itemsOf(/^Trade items incoming/i), outItems = itemsOf(/^Trade items outgoing/i);
      let dir = null, items = inItems.concat(outItems), amount = null;
      if (inItems.length && !outItems.length) { dir = 'buy'; items = inItems; amount = moneyOf(/^Trade money outgoing/i); }
      else if (outItems.length && !inItems.length) { dir = 'sell'; items = outItems; amount = moneyOf(/^Trade money incoming/i); }
      if (!items.length) return;
      items.forEach(i => { i.name = i.name || nameOf(i.id); });
      out['trade:' + tid] = {
        id: 'trade:' + tid, ts: done.ts, dir, channel: 'trade', cp: (done.data || {}).user != null ? (done.data || {}).user : null,
        tradeId: Number(tid), items, amount, src: amount != null ? 'log' : null, locked: false,
        title: 'Trade completed'
      };
    });
    return out;
  }


  /* ===================== direct item sends/receives: batch them per player ===================== */
  // parts: { entryId: { ts, kind: 'send'|'recv', cp, items:[{id,qty}], msg } }. Entries to the same player within
  // 30 minutes become one record, so a burst of sends is one value to enter instead of dozens.
  function buildSendTxs(parts, nameOf) {
    const list = Object.entries(parts || {}).map(([id, p]) => Object.assign({ id }, p))
      .sort((a, b) => (a.kind + a.cp).localeCompare(b.kind + b.cp) || a.ts - b.ts);
    const groups = [];
    list.forEach(p => {
      const g = groups[groups.length - 1];
      if (g && g.kind === p.kind && String(g.cp) === String(p.cp) && p.ts - g.last <= 1800) { g.entries.push(p); g.last = p.ts; }
      else groups.push({ kind: p.kind, cp: p.cp, entries: [p], last: p.ts });
    });
    const out = {};
    groups.forEach(g => {
      const byId = {};
      g.entries.forEach(e => (e.items || []).forEach(i => { byId[i.id] = (byId[i.id] || 0) + i.qty; }));
      const items = Object.entries(byId).map(([id, qty]) => ({ id: Number(id), qty, name: nameOf(Number(id)), price: null }));
      if (!items.length) return;
      const first = g.entries[0];
      const id = 'send:' + first.id;
      out[id] = { id, ts: g.last, dir: g.kind === 'send' ? 'sell' : 'buy', channel: g.kind, cp: g.cp, tradeId: null, items, amount: null, src: null, locked: false,
        count: g.entries.length, msg: g.entries.map(e => e.msg).filter(Boolean)[0] || '', title: g.kind === 'send' ? 'Item send' : 'Item receive' };
    });
    return out;
  }

  /* ===================== state ===================== */
  let state = Object.assign({ v: 1, me: null, lastSync: 0, txs: {}, receipts: {}, seenTitles: {}, seenExamples: {}, tradeParts: {}, sendParts: {}, moneyEvents: {} }, sget('state', null) || {});
  let itemNames = sget('items', null) || {};
  let lastRaw = [];
  let lastSyncInfo = null;
  const ui = { open: false, tab: 'profit', items: false, breakdown: false, more: false, showPending: false, range: 30, editing: null, msg: '', pendingReceipt: null, candidates: [], busy: false };
  const save = () => {
    state.savedAt = Date.now();
    const smallOk = sset('state', state);
    if (!hasIDB) { lastSaveOk = smallOk; return; }
    idb.set('state', state).then(() => { lastSaveOk = true; idbErr = null; }).catch(e => { idbErr = String(e && e.message || e); lastSaveOk = smallOk; });
  };
  const STATE_DEFAULTS = () => ({ v: 1, me: null, lastSync: 0, txs: {}, receipts: {}, seenTitles: {}, seenExamples: {}, tradeParts: {}, sendParts: {}, moneyEvents: {} });
  // Load the saved state from IndexedDB when it is newer than what script storage gave us.
  const bootP = !hasIDB ? Promise.resolve() : Promise.all([idb.get('state').catch(() => null), idb.get('items').catch(() => null)]).then(([v, it]) => {
    if (v && v.txs && (v.savedAt || 0) >= (state.savedAt || 0)) state = Object.assign(STATE_DEFAULTS(), v);
    if (it && Object.keys(it).length >= Object.keys(itemNames).length) itemNames = it;
  }).catch(() => {});
  // Read the saved copy back and compare, so a silently failing save shows up as a warning.
  function verifySaved() {
    if (hasIDB) return;
    try { const back = sget('state', null); lastSaveOk = !!back && Object.keys(back.txs || {}).length === Object.keys(state.txs || {}).length; }
    catch (e) { lastSaveOk = false; }
  }
  const netAmt = tx => tx.amount;
  const flipOpts = () => ({ marketFee: 0 }); // Torn's market-sale log amount is already after the fee
  const nameOf = id => itemNames[id] || ('Item ' + id);

  /* ===================== Torn API ===================== */
  function getKey() { return (sget('apikey', '') || '') || (IN_PDA ? PDA_KEY : ''); }
  async function apiUrl(url) {
    const key = getKey();
    if (!key) throw new Error('No API key set (Settings tab).');
    const u = url + (url.includes('?') ? '&' : '?') + (/[?&]key=/.test(url) ? '' : 'key=' + encodeURIComponent(key));
    const r = await http(u);
    let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('Bad API response (HTTP ' + r.status + ')'); }
    if (j && j.error && j.error.code === 16) throw new Error('Your API key does not have enough access. The log needs a Limited Access key or higher (Torn > Settings > API Key). Add your own key in Settings.');
    if (j && j.error && j.error.code === 2) throw new Error('Torn rejected the API key as incorrect. Check it in Settings.');
    if (j && j.error && j.error.code === 5) { const er = new Error('Torn is limiting requests (too many in one minute). Progress is saved and will continue on the next sync.'); er.rate = true; throw er; }
    if (j && j.error) throw new Error('Torn API: ' + (j.error.error || j.error.code) + ' (code ' + j.error.code + ')');
    return j;
  }
  function api(path, params) {
    const qs = Object.entries(params || {}).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    return apiUrl('https://api.torn.com/v2/' + path + (qs ? '?' + qs : ''));
  }
  async function ensureMe() {
    if (state.me) return state.me;
    const j = await api('user/basic');
    const p = j.profile || j;
    state.me = { id: p.id || p.player_id, name: p.name };
    save(); return state.me;
  }
  async function ensureItems() {
    if (Object.keys(itemNames).length) return;
    try {
      const j = await api('torn/items');
      const list = Array.isArray(j.items) ? j.items : Object.entries(j.items || {}).map(([id, v]) => Object.assign({ id }, v));
      list.forEach(i => { itemNames[i.id] = i.name; });
      sset('items', itemNames); if (hasIDB) idb.set('items', itemNames).catch(() => {});
    } catch (e) { console.warn('[TFP] item names failed', e); }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function syncLog() {
    await ensureMe(); await ensureItems();
    const startDays = Number(sget('startDays', 30)) || 30;
    const resume = state.resume || null;
    const from = resume ? resume.from : (state.lastSync ? state.lastSync + 1 : Math.floor(Date.now() / 1000) - startDays * 86400);
    let curTo = resume ? resume.to : null;
    // Torn allows about 100 requests a minute: pause between pages and wait out a rate-limit reply a few times.
    const fetchPage = async to => {
      for (let t = 0; ; t++) {
        try { return await api('user/log', Object.assign({ from, limit: 100 }, to ? { to } : {})); }
        catch (e) { if (e.rate && t < 3) { await sleep(15000); continue; } throw e; }
      }
    };
    let j = await fetchPage(curTo);
    const seenIds = new Set();
    let prevTo = null, pages = 0, added = 0, newest = Math.max(state.lastSync || 0, resume ? resume.newest : 0);
    lastRaw = [];
    lastSyncInfo = { from, topKeys: Object.keys(j || {}), logType: Array.isArray(j && j.log) ? 'array' : typeof (j && j.log), entries: 0, pages: 0, firstRaw: [], pageInfo: [] };
    try {
    while (j && pages++ < 100) {
      if (ui.busy) { ui.msg = 'Syncing… page ' + pages; render(); }
      const arr = normalizeLog(j.log);
      lastSyncInfo.pages = pages; lastSyncInfo.entries += arr.length;
      { const ts = arr.map(x => x.timestamp).filter(Number); const md = j._metadata || {};
        lastSyncInfo.pageInfo.push({ count: arr.length, newest: ts.length ? Math.max.apply(null, ts) : null, oldest: ts.length ? Math.min.apply(null, ts) : null,
          meta: JSON.stringify(md).replace(/key=[A-Za-z0-9]+/g, 'key=HIDDEN').slice(0, 400) }); }
      arr.slice(0, 8 - lastSyncInfo.firstRaw.length).forEach(e => lastSyncInfo.firstRaw.push(e));
      arr.forEach(e => {
        const title = (e.details && e.details.title) || e.title || '';
        if (title) state.seenTitles[title] = (state.seenTitles[title] || 0) + 1;
        if (e.timestamp > newest) newest = e.timestamp;
        state.seenExamples = state.seenExamples || {};
        if (title && !state.seenExamples[title] && Object.keys(state.seenExamples).length < 80 && !/^(Crime|Forums|Message|Faction newsletter)/i.test(title)) state.seenExamples[title] = e;
        if (/^Money (receive|send)/i.test(title) && e.data && typeof e.data.money === 'number') {
          state.moneyEvents = state.moneyEvents || {};
          state.moneyEvents[e.id] = { ts: e.timestamp, dir: /receive/i.test(title) ? 'in' : 'out', cp: e.data.sender != null ? e.data.sender : (e.data.receiver != null ? e.data.receiver : (e.data.user != null ? e.data.user : null)), amount: e.data.money };
        }
        if (/^Trade /i.test(title)) {
          const tid = /^Trade (completed|items (incoming|outgoing)|money (incoming|outgoing))/i.test(title) ? tradeIdOf(e) : null;
          if (tid) {
            state.tradeParts = state.tradeParts || {};
            const tp = state.tradeParts[tid] = state.tradeParts[tid] || { parts: {} };
            tp.parts[e.id] = { title, ts: e.timestamp, data: compactTradeData(e.data || {}) };
          }
          return;
        }
        if (/^Item (send|receive)$/i.test(title) && e.data) {
          state.sendParts = state.sendParts || {};
          state.sendParts[e.id] = { ts: e.timestamp, kind: /send/i.test(title) ? 'send' : 'recv', cp: e.data.receiver != null ? e.data.receiver : (e.data.sender != null ? e.data.sender : null), items: pickItems(e.data).map(i => ({ id: i.id, qty: i.qty })), msg: String(e.data.message || '').slice(0, 80) };
          return;
        }
        const rule = LOG_RULES.find(r => r.re.test(title));
        if (!rule) return;
        if (lastRaw.length < 6) lastRaw.push(e);
        const tx = parseLogEntry(e, rule, nameOf);
        if (!tx.items.length || state.txs[tx.id]) return;
        state.txs[tx.id] = tx; added++;
      });
      // Page backwards with our own "to" cursor (newest-first) instead of trusting Torn's next link.
      const ts = arr.map(x => x.timestamp).filter(Number);
      const fresh = arr.filter(x => !seenIds.has(x.id));
      arr.forEach(x => seenIds.add(x.id));
      if (!ts.length || !fresh.length) break;
      const oldest = Math.min.apply(null, ts);
      if (oldest <= from) break;
      const to = oldest === prevTo ? oldest - 1 : oldest;
      prevTo = oldest; curTo = to;
      state.resume = { from, to, newest }; save(); // checkpoint: an interrupted import continues from here
      await sleep(650);
      j = await fetchPage(to);
    }
    } catch (e) { state.resume = { from, to: curTo, newest }; state.lastError = { at: Math.floor(Date.now() / 1000), msg: String(e.message || e), page: pages }; save(); throw e; }
    const capped = pages > 100;
    const built = buildTradeTxs(state.tradeParts, nameOf);
    Object.entries(built).forEach(([id, tx]) => {
      delete state.tradeParts[String(tx.tradeId)]; // parts are only needed until the trade is built
      const old = state.txs[id];
      if (old && old.locked) return;
      if (!old) added++;
      state.txs[id] = tx;
    });
    const sends = buildSendTxs(state.sendParts, nameOf);
    Object.keys(state.txs).forEach(id => { // drop earlier per-entry send/receive records and stale batches; keep ones you valued
      const t = state.txs[id];
      if ((t.channel === 'send' || t.channel === 'recv') && !t.locked && (id.indexOf('log:') === 0 || (id.indexOf('send:') === 0 && !sends[id]))) delete state.txs[id];
    });
    Object.entries(sends).forEach(([id, tx]) => {
      const old = state.txs[id];
      if (!old) added++;
      state.txs[id] = old && old.locked ? Object.assign({}, tx, { amount: old.amount, src: old.src, locked: true }) : tx;
    });
    // The log arrives newest-first, so if we stopped at the page cap, older entries were not read: keep the old cursor.
    if (!capped) { state.lastSync = newest; state.syncedAt = Math.floor(Date.now() / 1000); state.resume = null; }
    else state.resume = { from, to: curTo, newest };
    save(); verifySaved();
    if (capped) throw new Error('Imported part of your history (' + added + ' new). Tap Sync now again to continue.');
    return added;
  }

  /* ===================== receipt handling ===================== */
  function attachReceipt(rc, tx) {
    const role = roleFor(rc, state.me);
    if (!role) throw new Error("Your name isn't the buyer or seller on this receipt.");
    tx.dir = role; tx.items = rc.items.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price }));
    tx.amount = rc.total; tx.src = 'receipt'; tx.locked = true; tx.receiptUrl = rc.url;
    if (rc.tradeId) tx.tradeId = rc.tradeId;
    state.receipts[rc.url] = rc; save();
  }
  function createFromReceipt(rc) {
    const role = roleFor(rc, state.me);
    if (!role) throw new Error("Your name isn't the buyer or seller on this receipt.");
    const tx = { id: 'rc:' + (rc.tradeId || rc.url), ts: rc.ts || Math.floor(Date.now() / 1000), dir: role, channel: 'trade', items: [], amount: null, locked: true, tradeId: rc.tradeId };
    state.txs[tx.id] = tx; attachReceipt(rc, tx); return tx;
  }
  async function resolvePawnHub(rc) {
    await ensureItems();
    const byName = {}; Object.entries(itemNames).forEach(([id, n]) => { byName[String(n).toLowerCase()] = Number(id); });
    rc.items.forEach(i => { if (!i.id) i.id = byName[String(i.name).toLowerCase()] || null; });
    const bad = rc.items.filter(i => !i.id).map(i => i.name);
    if (bad.length) throw new Error("Couldn't match item name(s) to Torn items: " + bad.join(', '));
    // The name shown on a PawnHub receipt is always the seller.
    if (!rc.party) throw new Error("Couldn't find the seller name on this PawnHub receipt.");
    rc.seller = rc.party;
    rc.role = rc.party.toLowerCase() === String((state.me && state.me.name) || '').toLowerCase() ? 'sell' : 'buy';
  }
  async function handleReceipt(rc) {
    await ensureMe();
    if (rc.source === 'pawnhub') await resolvePawnHub(rc);
    if (!roleFor(rc, state.me)) throw new Error("Your name (" + state.me.name + ") isn't the buyer or seller on this receipt.");
    const cands = rankCandidates(rc, state.txs);
    const best = cands[0], second = cands[1];
    if (best && best.score >= 6 && (!second || best.score - second.score >= 2)) {
      attachReceipt(rc, best.tx); ui.pendingReceipt = null; ui.candidates = [];
      return 'Receipt attached to a matching trade.';
    }
    ui.pendingReceipt = rc; ui.candidates = cands;
    return cands.length ? 'Pick which trade this receipt belongs to.' : 'No matching trade found in your log.';
  }
  async function addReceiptInput(text) {
    text = (text || '').trim();
    if (!text) throw new Error('Paste a receipt link first.');
    let rc;
    if (text[0] === '{') rc = JSON.parse(text);
    else if (/^https?:\/\//i.test(text)) {
      rc = await fetchReceipt(text);
      if (!rc) throw new Error("Couldn't read that receipt from the link. Open it, tap \"Add to profit tracker\" on the page, then paste here.");
    } else throw new Error('Paste a receipt link or copied receipt data.');
    return handleReceipt(rc);
  }

  /* ===================== UI ===================== */
  const CSS = `
  #tfp-btn{z-index:2147483646;cursor:pointer;font-size:16px;line-height:1;padding:3px 7px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#fff}
  #tfp-btn{position:absolute;touch-action:none;-webkit-user-select:none;user-select:none}
  #tfp-wrap.pda{padding-bottom:50px}
  #tfp-wrap.pda #tfp-card{max-height:calc(100% - 8px);border-radius:14px}
  #tfp-wrap{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);display:none;align-items:flex-end;justify-content:center}
  #tfp-wrap.open{display:flex}
  #tfp-card{background:#1e1e1e;color:#ddd;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:14px 14px 0 0;padding:12px;font:13px/1.4 Arial,sans-serif;box-sizing:border-box}
  #tfp-card *{box-sizing:border-box}
  .tfp-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .tfp-tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}
  .tfp-tab,.tfp-b{background:#333;color:#eee;border:1px solid #555;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px}
  .tfp-tab.on{background:#3b6fd1;border-color:#3b6fd1}
  .tfp-row{border-top:1px solid #333;padding:8px 0}
  .tfp-top{display:flex;justify-content:space-between;gap:8px}
  .tfp-sub{color:#999;font-size:12px;margin-top:2px}
  .tfp-line{display:flex;justify-content:space-between;color:#bbb;font-size:12px;padding:2px 0 0 10px}
  .tfp-pos{color:#6fcf6f}.tfp-neg{color:#ef6f6f}.tfp-warn{color:#e8b64a}
  .tfp-in,.tfp-ta{background:#111;color:#eee;border:1px solid #555;border-radius:6px;padding:6px;width:100%;font-size:13px}
  .tfp-ta{min-height:70px}
  .tfp-msg{background:#2a2a2a;border-radius:8px;padding:8px;margin:6px 0}
  .tfp-gap{height:6px}
  .tfp-sel{width:auto;padding:4px}
  #tfp-card a{color:#7fb0ff}
  .tfp-disc{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
  .tfp-disc td{border:1px solid #444;padding:4px;vertical-align:top}
  .tfp-disc td:first-child{color:#999;white-space:nowrap;padding-right:10px}
  #tfp-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;background:#222;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 12px;font:13px Arial}
  `;
  const badge = tx => tx.src === 'receipt' ? '🧾' : tx.src === 'log' ? '📒' : tx.src === 'manual' ? '✍️' : '⚠️';
  const fdate = ts => { const d = new Date(ts * 1000); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const itemSummary = tx => tx.items.slice(0, 5).map(i => i.qty + '× ' + esc(i.name || nameOf(i.id))).join(', ') + (tx.items.length > 5 ? ' + ' + (tx.items.length - 5) + ' more' : '') + (tx.count > 1 ? ' · ' + tx.count + ' sends' : '');
  const chanLabel = c => ({ market: 'Market', bazaar: 'Bazaar', trade: 'Trade', send: 'Send', recv: 'Received' }[c] || c);

  const rangeSelect = () => `<select class="tfp-in tfp-sel" data-act="range">${[[1, 'Last 24h'], [7, 'Last 7 days'], [30, 'Last 30 days'], [0, 'All time']].map(r => `<option value="${r[0]}"${ui.range === r[0] ? ' selected' : ''}>${r[1]}</option>`).join('')}</select>`;
  const pnlCls = n => n == null ? 'tfp-warn' : n >= 0 ? 'tfp-pos' : 'tfp-neg';
  const link = (key, label) => `<a href="#" data-act="toggle" data-v="${key}">${ui[key] ? '▾' : '▸'} ${label}</a>`;
  function profitHtml() {
    const cutoff = ui.range ? Date.now() / 1000 - ui.range * 86400 : 0;
    const res = computeFlips(state.txs, flipOpts());
    const flips = res.flips.filter(f => f.tx.ts >= cutoff).sort((a, b) => b.tx.ts - a.tx.ts);
    const done = flips.filter(f => f.profit != null);
    const lines = done.reduce((a, f) => a.concat(f.lines.filter(l => l.matched > 0)), []);
    const revenue = lines.reduce((a, l) => a + l.proceeds, 0), cost = lines.reduce((a, l) => a + (l.cost || 0), 0);
    const profit = done.reduce((a, f) => a + f.profit, 0);
    let h = `<div class="tfp-h"><div><span class="${pnlCls(profit)}" style="font-size:20px"><b>${fmt(profit)}</b></span>
      <div class="tfp-sub">${done.length} flip${done.length === 1 ? '' : 's'}${cost > 0 ? ' · ' + (profit / cost * 100).toFixed(1) + '% return' : ''}</div></div>${rangeSelect()}</div>
      <div class="tfp-sub">Sold for ${fmt(revenue)} · cost ${fmt(cost)}</div>`;
    if (res.pending.length) {
      h += `<div class="tfp-msg tfp-warn"><a href="#" data-act="toggle" data-v="showPending">⚠️ ${res.pending.length} need${res.pending.length === 1 ? 's' : ''} a value ${ui.showPending ? '▾' : '▸'}</a></div>`;
      if (ui.showPending) h += pendingHtml();
    }
    if (flips.length > done.length) h += `<div class="tfp-sub tfp-warn">${flips.length - done.length} sale(s) not counted: no matching buy, or a buy with no value.</div>`;
    if (!flips.length) return h + '<div class="tfp-msg">No flips yet. They appear once you sell items you bought.</div>';
    // One closed row per category; opening it lists that category's sales.
    const CATS = [['trade', 'Trade'], ['market', 'Market'], ['bazaar', 'Bazaar'], ['send', 'Sent']];
    CATS.forEach(([ch, label]) => {
      const fs = flips.filter(f => f.tx.channel === ch);
      const pend = res.pending.filter(tx => tx.channel === ch && tx.dir === 'sell' && tx.ts >= cutoff).sort((a, b) => b.ts - a.ts);
      if (!fs.length && !pend.length) return;
      const cp = fs.reduce((a, f) => a + (f.profit || 0), 0), key = 'cat_' + ch;
      h += `<div class="tfp-row"><div class="tfp-top"><a href="#" data-act="toggle" data-v="${key}">${ui[key] ? '▾' : '▸'} ${label} · ${fs.length + pend.length} sale${fs.length + pend.length === 1 ? '' : 's'}${pend.length ? ' · <span class="tfp-warn">' + pend.length + ' need a value</span>' : ''}</a><b class="${pnlCls(cp)}">${fmt(cp)}</b></div>`;
      if (ui[key]) pend.forEach(tx => { h += `<div class="tfp-gap"></div><div class="tfp-top"><span>${fdate(tx.ts)} ⚠️</span><span class="tfp-warn">needs value</span></div><div class="tfp-sub">${itemSummary(tx)}${tx.cp ? ' · player ' + esc(tx.cp) : ''}${tx.title ? ' · ' + esc(tx.title) : ''}</div>` + editBox(tx); });
      if (ui[key]) fs.forEach(f => {
        const tx = f.tx;
        let flag = '';
        if (f.unmatched) flag += ` <span class="tfp-warn">⚠️ ${f.unmatched} unit(s) had no matching buy</span>`;
        if (f.costUnknown) flag += ' <span class="tfp-warn">⚠️ a matching buy has no value</span>';
        h += `<div class="tfp-gap"></div><div class="tfp-top"><span>${fdate(tx.ts)}${tx.src === 'receipt' ? ' 🧾' : tx.src === 'manual' ? ' ✍️' : ''}</span><b class="${pnlCls(f.profit)}">${fmt(f.profit)}</b></div>
          <div class="tfp-sub">${itemSummary(tx)} · sold for ${fmt(netAmt(tx))} <a href="#" data-act="edit" data-id="${esc(tx.id)}">✎</a>${flag}</div>`;
        if (ui.editing === tx.id) h += editBox(tx);
      });
      h += '</div>';
    });
    return h;
  }
  function stockHtml() {
    const open = computeFlips(state.txs, flipOpts()).open;
    const rows = []; let total = 0, unknown = false;
    Object.entries(open).forEach(([id, q]) => {
      const left = q.filter(l => l.qty > 0); if (!left.length) return;
      const qty = left.reduce((a, l) => a + l.qty, 0);
      const unk = left.some(l => l.unit == null);
      const c = unk ? null : left.reduce((a, l) => a + l.qty * l.unit, 0);
      if (unk) unknown = true; else total += c;
      rows.push({ id, qty, c, unk, oldest: Math.min.apply(null, left.map(l => l.ts)) });
    });
    rows.sort((a, b) => (b.c || 0) - (a.c || 0));
    let h = `<div class="tfp-h"><div><b>Unsold stock</b> <b>${fmt(total)}</b><div class="tfp-sub">at cost · FIFO · ${rows.length} item type(s)${unknown ? ' · some cost unknown' : ''}</div></div></div>`;
    if (!rows.length) return h + '<div class="tfp-msg">Nothing in stock. Items you buy show up here until they are sold.</div>';
    return h + rows.map(r => `<div class="tfp-row"><div class="tfp-top"><span>${r.qty}× ${esc(nameOf(r.id))}</span><b class="${r.unk ? 'tfp-warn' : ''}">${fmt(r.c)}</b></div><div class="tfp-sub">${r.unk ? 'cost unknown · ' : fmt(r.c / r.qty) + ' each · '}oldest ${fdate(r.oldest)}</div></div>`).join('');
  }
  function editBox(tx) {
    const label = tx.dir === 'buy' ? 'Amount paid ($)' : 'Amount received ($)';
    return `<div class="tfp-gap"></div><div class="tfp-sub">${label}</div>
      <input class="tfp-in" id="tfp-val-${esc(tx.id)}" inputmode="numeric" value="${tx.amount != null ? tx.amount : ''}">
      <div class="tfp-gap"></div><button class="tfp-b" data-act="saveval" data-id="${esc(tx.id)}">Save &amp; lock</button>`;
  }
  function pendingHtml() {
    const res = computeFlips(state.txs, flipOpts());
    if (!res.pending.length) return '<div class="tfp-msg">Nothing needs a value. 🎉</div>';
    return res.pending.sort((a, b) => b.ts - a.ts).map(tx => {
      let h = `<div class="tfp-row"><div class="tfp-top"><span>${fdate(tx.ts)} · ${chanLabel(tx.channel)}</span><span>⚠️</span></div><div class="tfp-sub">${itemSummary(tx)}${tx.cp ? ' · player ' + esc(tx.cp) : ''}${tx.title ? ' · ' + esc(tx.title) : ''}</div>`;
      if (!tx.dir) h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="sell">I sold these</button> <button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="buy">I bought these</button>`;
      else {
        h += editBox(tx);
        const want = tx.dir === 'sell' ? 'in' : 'out';
        const sug = Object.entries(state.moneyEvents || {}).filter(([, m]) => m.dir === want && Math.abs(m.ts - tx.ts) < 24 * 3600 && tx.cp != null && m.cp != null && String(m.cp) === String(tx.cp)).slice(0, 3);
        if (tx.channel === 'send' || tx.channel === 'recv') h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="gift" data-id="${esc(tx.id)}">Gift / no payment ($0)</button>`;
        if (tx.channel === 'send' || tx.channel === 'recv') sug.forEach(([mid, m]) => { h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="usemoney" data-id="${esc(tx.id)}" data-v="${esc(mid)}">Use ${fmt(m.amount)} ${want === 'in' ? 'received' : 'sent'} ${fdate(m.ts)}</button>`; });
      }
      return h + '</div>';
    }).join('');
  }
  function receiptsHtml() {
    let h = '<div class="tfp-sub">Paste a Weaver, TornExchange or PawnHub receipt link (or data copied with the "Add to profit tracker" button on the receipt page).</div><div class="tfp-gap"></div><textarea class="tfp-ta" id="tfp-rc" placeholder="https://tornexchange.com/receipt/..."></textarea><div class="tfp-gap"></div><button class="tfp-b" data-act="addrc">Add receipt</button>';
    const inbox = hasGM ? sget('inbox', []) : [];
    if (inbox.length) h += ` <button class="tfp-b" data-act="inbox">Process ${inbox.length} saved receipt(s)</button>`;
    if (ui.pendingReceipt) {
      const rc = ui.pendingReceipt;
      h += `<div class="tfp-msg"><b>${rc.source === 'weaver' ? 'Weaver' : rc.source === 'pawnhub' ? 'PawnHub' : 'TornExchange'} receipt</b> · ${fmt(rc.total)}<br>${rc.items.map(i => i.qty + '× ' + esc(i.name)).join(', ')}</div>`;
      ui.candidates.forEach(c => { h += `<div class="tfp-row"><div class="tfp-top"><span>${fdate(c.tx.ts)} · ${chanLabel(c.tx.channel)}</span><button class="tfp-b" data-act="attach" data-id="${esc(c.tx.id)}">Attach</button></div><div class="tfp-sub">${itemSummary(c.tx)}</div></div>`; });
      h += '<div class="tfp-gap"></div><button class="tfp-b" data-act="newtrade">Add as a new trade instead</button>';
    }
    return h;
  }
  function settingsHtml() {
    const own = !!sget('apikey', '');
    const keyBox = `<div class="tfp-sub">Torn API key${IN_PDA && !own ? ' (currently using the Torn PDA key; add your own if it lacks log access)' : ''}. Needs Limited Access or higher.</div>
      <input class="tfp-in" id="tfp-key" type="password" autocomplete="off" placeholder="${own ? 'Key saved (hidden). Paste a new one to replace.' : 'Paste your key'}"><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="savekey">Save key</button> ${own ? '<button class="tfp-b" data-act="clearkey">Remove key</button>' : ''}
      <table class="tfp-disc"><tr><td>Data storage</td><td>Your trade history and settings are kept only on this device.</td></tr>
      <tr><td>Data sharing</td><td>Not shared with anyone.</td></tr>
      <tr><td>Purpose of use</td><td>Read your own item log, item names and key info to calculate flip profit. Read-only; no game actions.</td></tr>
      <tr><td>Key storage</td><td>Only in this script's local storage on this device.</td></tr>
      <tr><td>Key sharing</td><td>Sent only to api.torn.com. Never shared with anyone else.</td></tr>
      <tr><td>Key access level</td><td>Limited Access (needed for the log).</td></tr></table>
      <div class="tfp-sub">Tip: make a separate key just for this script. Deleting it in Torn settings revokes access at once.</div>`;
    return `${keyBox}<div class="tfp-gap"></div><div class="tfp-sub">First sync looks back this many days</div>
      <input class="tfp-in" id="tfp-days" data-act="setting" inputmode="numeric" value="${esc(sget('startDays', 30))}"><div class="tfp-gap"></div><button class="tfp-b" data-act="sync">${ui.busy ? 'Syncing…' : 'Sync now'}</button>
      <div class="tfp-sub">Syncs automatically when you open this panel. Last sync: ${state.syncedAt || state.lastSync ? fdate(state.syncedAt || state.lastSync) : 'never'} · ${Object.keys(state.txs).length} records</div>
      <div class="tfp-gap"></div><div class="tfp-sub">${link('more', 'Backup &amp; troubleshooting')}</div>
      ${ui.more ? settingsMore() : ''}`;
  }
  function settingsMore() {
    return `<div class="tfp-row"><b>Backup</b><div class="tfp-gap"></div><textarea class="tfp-ta" id="tfp-bk" placeholder="Export fills this box. Paste a backup here to import."></textarea><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="export">Export</button> <button class="tfp-b" data-act="import">Import</button></div>
      <div class="tfp-row"><b>Troubleshooting</b><div class="tfp-gap"></div><button class="tfp-b" data-act="debug">Copy debug sample</button> <button class="tfp-b" data-act="resync">Re-sync from start</button></div>`;
  }

  function render() {
    const card = document.getElementById('tfp-card');
    if (!card) return;
    const needs = computeFlips(state.txs, flipOpts()).pending.length;
    const tabs = [['profit', 'Profit' + (needs ? ' ⚠️' : '')], ['stock', 'Stock'], ['receipts', 'Receipts'], ['settings', 'Settings']];
    card.innerHTML = `<div class="tfp-h"><b>💰 Arbitrage</b><button class="tfp-b" data-act="close">✕</button></div>
      <div class="tfp-tabs">${tabs.map(t => `<button class="tfp-tab ${ui.tab === t[0] ? 'on' : ''}" data-act="tab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div>
      ${lastSaveOk ? '' : '<div class="tfp-msg tfp-warn">⚠️ Could not save your data on this device (storage may be full). Export a backup in Settings.</div>'}
      ${ui.msg ? `<div class="tfp-msg">${esc(ui.msg)}</div>` : ''}
      ${ui.tab === 'profit' ? profitHtml() : ui.tab === 'stock' ? stockHtml() : ui.tab === 'receipts' ? receiptsHtml() : settingsHtml()}`;
  }
  function toast(msg) {
    let t = document.getElementById('tfp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'tfp-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };

  async function onAction(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id, v = el.dataset.v;
    if (act === 'edit' || act === 'toggle') e.preventDefault();
    ui.msg = '';
    try {
      if (act === 'close') ui.open = false, document.getElementById('tfp-wrap').classList.remove('open');
      else if (act === 'tab') { ui.tab = v; ui.editing = null; }
      else if (act === 'range') ui.range = Number(el.value);
      else if (act === 'toggle') ui[v] = !ui[v];
      else if (act === 'setting') { sset('startDays', Number(val('tfp-days')) || 30); }
      else if (act === 'edit') ui.editing = ui.editing === id ? null : id;
      else if (act === 'dir') state.txs[id].dir = v, save();
      else if (act === 'saveval') {
        const n = firstNumber(val('tfp-val-' + id));
        if (n == null) throw new Error('Enter a number.');
        const tx = state.txs[id]; tx.amount = n; tx.src = 'manual'; tx.locked = true; ui.editing = null; save();
      }
      else if (act === 'gift') { const tx = state.txs[id]; tx.amount = 0; tx.src = 'manual'; tx.locked = true; save(); }
      else if (act === 'usemoney') {
        const m = state.moneyEvents[v], tx = state.txs[id];
        if (!m || !tx) throw new Error('That payment is no longer available.');
        tx.amount = m.amount; tx.src = 'manual'; tx.locked = true; save();
      }
      else if (act === 'savekey') {
        const k = val('tfp-key').trim();
        if (!/^[A-Za-z0-9]{16}$/.test(k)) throw new Error('A Torn API key is 16 letters and numbers.');
        const old = sget('apikey', ''); sset('apikey', k);
        try {
          const j = await api('key/info');
          const info = j.info || j, lvl = info.access && (info.access.type || info.access.level);
          state.me = null; save();
          ui.msg = 'Key saved' + (lvl ? ' (access: ' + lvl + ')' : '') + '.';
        } catch (e) { sset('apikey', old); throw e; }
      }
      else if (act === 'clearkey') { sset('apikey', ''); state.me = null; save(); ui.msg = 'Key removed from this device.'; }
      else if (act === 'sync' || act === 'resync') {
        if (act === 'resync') { state.lastSync = 0; state.seenTitles = {}; state.tradeParts = {}; state.sendParts = {}; state.moneyEvents = {}; state.resume = null; save(); }
        sset('startDays', Number(val('tfp-days')) || 30);
        ui.busy = true; render();
        try { const n = await syncLog(); ui.msg = 'Sync done: ' + n + ' new record(s).'; }
        finally { ui.busy = false; }
      }
      else if (act === 'addrc') { ui.msg = await addReceiptInput(val('tfp-rc')); }
      else if (act === 'attach') { attachReceipt(ui.pendingReceipt, state.txs[id]); ui.pendingReceipt = null; ui.candidates = []; ui.msg = 'Receipt attached.'; }
      else if (act === 'newtrade') { createFromReceipt(ui.pendingReceipt); ui.pendingReceipt = null; ui.candidates = []; ui.msg = 'Added as a new trade.'; }
      else if (act === 'inbox') {
        const inbox = sget('inbox', []); sset('inbox', []);
        let last = '';
        for (const rc of inbox) last = await handleReceipt(rc);
        ui.msg = last || 'Inbox empty.';
      }
      else if (act === 'export') { const t = document.getElementById('tfp-bk'); t.value = JSON.stringify(state); await copyText(t.value); ui.msg = 'Exported (also copied).'; render(); document.getElementById('tfp-bk').value = JSON.stringify(state); return; }
      else if (act === 'import') {
        const incoming = JSON.parse(val('tfp-bk'));
        if (!incoming || !incoming.txs) throw new Error('That does not look like a backup.');
        if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Tap again to replace data'; return; }
        state = incoming; save(); ui.msg = 'Backup imported.';
      }
      else if (act === 'debug') {
        const tb = document.querySelector('#topHeaderBanner .toolbar, .header-buttons-wrapper');
        const hdr = tb ? tb.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<form[\s\S]*?<\/form>/g, '<form/>') : null;
        let cats = null; try { cats = await api('torn/logcategories'); } catch (e) { cats = String(e.message || e); }
        const sample = { storage: { hasGM, hasIDB, idbErr, boot: bootInfo, lastSaveOk, stateBytes: JSON.stringify(state).length, gmBytes: hasGM ? String((() => { try { return GM_getValue(NS + 'state') || ''; } catch (e) { return 'err'; } })()).length : null, lsBytes: (() => { try { return (localStorage.getItem(NS + 'state') || '').length; } catch (e) { return 'err'; } })() }, syncInfo: lastSyncInfo, lastError: state.lastError || null, resume: state.resume || null, txCount: Object.keys(state.txs).length, pendingCount: computeFlips(state.txs, flipOpts()).pending.length, logCategories: cats, rawEntries: lastRaw, seenTitles: state.seenTitles, seenExamples: state.seenExamples, lastSync: state.lastSync, sampleTxs: Object.values(state.txs).slice(-5), header: hdr ? hdr.slice(0, 6000) : null, headerPath: tb ? [tb.tagName, tb.id, tb.className, tb.parentElement && tb.parentElement.className].join(' | ') : null };
        const ok = await copyText(JSON.stringify(sample, null, 1));
        ui.msg = ok ? 'Debug sample copied. Paste it to Claude.' : 'Could not copy. Sync first, then try again.';
      }
    } catch (err) { ui.msg = String(err.message || err); }
    render();
  }

  async function autoSync() {
    if (ui.busy || !getKey() || (!state.resume && Math.floor(Date.now() / 1000) - (state.syncedAt || 0) < 300)) return;
    ui.busy = true; ui.msg = 'Syncing…'; render();
    try { const n = await syncLog(); ui.msg = n ? 'Synced: ' + n + ' new record(s).' : ''; }
    catch (err) { ui.msg = String(err.message || err); }
    finally { ui.busy = false; render(); }
  }
  function openPanel() { ui.open = true; document.getElementById('tfp-wrap').classList.add('open'); render(); bootP.then(() => { render(); autoSync(); }); }
  function placeBtn(b, pos) {
    const de = document.documentElement;
    const left = Math.min(Math.max(0, pos.left), Math.max(0, de.scrollWidth - 40));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, de.scrollHeight - 40));
    b.style.left = left + 'px'; b.style.top = top + 'px'; b.style.right = 'auto'; b.style.bottom = 'auto';
  }
  // Button sits at the top of the page so it scrolls with Torn's header. Drag to adjust; position is remembered.
  function attachDrag(b) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false;
    b.addEventListener('pointerdown', ev => {
      ev.stopPropagation(); down = true; moved = false; sx = ev.clientX; sy = ev.clientY;
      const r = b.getBoundingClientRect(); ox = r.left + window.pageXOffset; oy = r.top + window.pageYOffset;
      try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    b.addEventListener('pointermove', ev => {
      if (!down) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 8) return;
      moved = true; placeBtn(b, { left: ox + dx, top: oy + dy });
    });
    b.addEventListener('pointerup', ev => {
      ev.stopPropagation();
      if (!down) return;
      down = false;
      if (moved) { const r = b.getBoundingClientRect(); sset('btnpos2', { left: r.left + window.pageXOffset, top: r.top + window.pageYOffset }); }
      else openPanel();
    });
    ['mousedown', 'touchstart', 'click'].forEach(t => b.addEventListener(t, ev => { ev.stopPropagation(); if (t === 'click') ev.preventDefault(); }));
  }

  function mountTornUI() {
    if (!document.getElementById('tfp-style')) {
      const st = document.createElement('style'); st.id = 'tfp-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    if (!document.getElementById('tfp-wrap')) {
      const w = document.createElement('div'); w.id = 'tfp-wrap'; if (IS_PDA_ENV) w.classList.add('pda'); w.innerHTML = '<div id="tfp-card"></div>';
      w.addEventListener('click', ev => { if (ev.target === w) { w.classList.remove('open'); ui.open = false; } else onAction(ev); });
      w.addEventListener('change', ev => { if (ev.target.matches('select[data-act], input[data-act]')) onAction(ev); });
      document.body.appendChild(w);
    }
    if (!document.getElementById('tfp-btn')) {
      const b = document.createElement('button'); b.id = 'tfp-btn'; b.textContent = '💰'; b.title = 'Arbitrage';
      const pos = sget('btnpos2', null) || (window.innerWidth < 700 ? { left: 124, top: 4 } : { left: Math.max(8, window.innerWidth - 110), top: 8 });
      placeBtn(b, pos);
      attachDrag(b);
      document.body.appendChild(b);
    }
  }

  /* ===================== receipt pages (tornexchange / weav3r) ===================== */
  function mountReceiptButton() {
    if (document.getElementById('tfp-rbtn')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const b = document.createElement('button');
    b.id = 'tfp-rbtn'; b.className = 'tfp-b'; b.textContent = '💰 Add to profit tracker';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647';
    b.addEventListener('click', async () => {
      const rc = parseReceiptDoc(document, location.href.split('#')[0]);
      if (!rc) {
        const ok = await copyText(document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 40000));
        toast("Couldn't read this receipt. " + (ok ? 'Page HTML copied; paste it to Claude.' : 'Let the page finish loading and try again.'));
        return;
      }
      const json = JSON.stringify(rc);
      let msg = '';
      if (hasGM) { const inbox = sget('inbox', []); inbox.push(rc); sset('inbox', inbox); msg = 'Saved. Open Torn > Receipts tab to attach. '; }
      const ok = await copyText(json);
      toast(msg + (ok ? 'Copied to clipboard too.' : 'Could not copy automatically.'));
    });
    document.body.appendChild(b);
  }

  /* ===================== init ===================== */
  function init() {
    if (/tornexchange\.com|weav3r\.dev|z0cl\.eu/.test(location.hostname)) {
      mountReceiptButton();
      setInterval(mountReceiptButton, 3000);
    } else {
      mountTornUI();
      setInterval(mountTornUI, 2500);
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = { buildSendTxs, parsePawnHub, buildTradeTxs, tradeIdOf, computeFlips, parseTornExchange, parseWeaver, roleFor, rankCandidates, parseLogEntry, firstNumber, parseTimeText };
  }
  if (typeof document !== 'undefined' && !globalThis.__TFP_TEST) init();
})();
