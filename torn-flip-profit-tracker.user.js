// ==UserScript==
// @name         Torn Flip Profit Tracker
// @namespace    torn-flip-profit-tracker
// @version      0.1.8-beta
// @description  Tracks bazaar, market and trade flip profit (FIFO) from the Torn API, with Weaver and TornExchange receipts.
// @match        https://www.torn.com/*
// @match        https://tornexchange.com/receipt/*
// @match        https://weav3r.dev/receipt/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      tornexchange.com
// @connect      weav3r.dev
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

  function sget(k, d) {
    try {
      const raw = hasGM ? GM_getValue(NS + k) : localStorage.getItem(NS + k);
      if (raw == null || raw === '') return d;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { return d; }
  }
  function sset(k, v) {
    try {
      const raw = JSON.stringify(v);
      if (hasGM) GM_setValue(NS + k, raw); else localStorage.setItem(NS + k, raw);
    } catch (e) { console.warn('[TFP] storage failed', e); }
  }

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

  function parseReceiptDoc(doc, url) {
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();
    if (/tornexchange/i.test(host)) return parseTornExchange(doc, url);
    if (/weav3r/i.test(host)) return parseWeaver(doc, url);
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
    return { flips, pending, total };
  }

  /* ===================== receipt <-> trade matching (pure) ===================== */
  function roleFor(rc, me) {
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
    { re: /item ?market.*(sell|sold|sale)/i, channel: 'market', dir: 'sell' },
    { re: /trade.*(complete|finish|accept)/i, channel: 'trade', dir: null },
    { re: /(item|items).*(send|sent)|send.*item/i, channel: 'send', dir: 'sell', noMoney: true },
    { re: /(item|items).*(receive|received)|receive.*item/i, channel: 'recv', dir: 'buy', noMoney: true }
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

  /* ===================== state ===================== */
  let state = sget('state', null) || { v: 1, me: null, lastSync: 0, txs: {}, receipts: {}, seenTitles: {} };
  let itemNames = sget('items', null) || {};
  let lastRaw = [];
  let lastSyncInfo = null;
  const ui = { open: false, tab: 'flips', items: false, range: 30, editing: null, msg: '', pendingReceipt: null, candidates: [], busy: false };
  const save = () => sset('state', state);
  const flipOpts = () => ({ marketFee: Math.min(100, Math.max(0, Number(sget('marketFee', 5)) || 0)) / 100 });
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
      sset('items', itemNames);
    } catch (e) { console.warn('[TFP] item names failed', e); }
  }

  async function syncLog() {
    await ensureMe(); await ensureItems();
    const startDays = Number(sget('startDays', 30)) || 30;
    const from = state.lastSync ? state.lastSync + 1 : Math.floor(Date.now() / 1000) - startDays * 86400;
    let j = await api('user/log', { from, limit: 100, sort: 'asc' });
    let pages = 0, added = 0, newest = state.lastSync || 0;
    lastRaw = [];
    lastSyncInfo = { from, topKeys: Object.keys(j || {}), logType: Array.isArray(j && j.log) ? 'array' : typeof (j && j.log), entries: 0, pages: 0, firstRaw: [] };
    while (j && pages++ < 30) {
      const arr = normalizeLog(j.log);
      lastSyncInfo.pages = pages; lastSyncInfo.entries += arr.length;
      arr.slice(0, 8 - lastSyncInfo.firstRaw.length).forEach(e => lastSyncInfo.firstRaw.push(e));
      arr.forEach(e => {
        const title = (e.details && e.details.title) || e.title || '';
        if (title) state.seenTitles[title] = (state.seenTitles[title] || 0) + 1;
        if (e.timestamp > newest) newest = e.timestamp;
        const rule = LOG_RULES.find(r => r.re.test(title));
        if (!rule) return;
        if (lastRaw.length < 6) lastRaw.push(e);
        const tx = parseLogEntry(e, rule, nameOf);
        if (!tx.items.length || state.txs[tx.id]) return;
        state.txs[tx.id] = tx; added++;
      });
      const next = j._metadata && j._metadata.links && j._metadata.links.next;
      if (!next || !arr.length) break;
      j = await apiUrl(next);
    }
    state.lastSync = newest; save();
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
  async function handleReceipt(rc) {
    await ensureMe();
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
  #tfp-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;background:#222;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 12px;font:13px Arial}
  `;
  const badge = tx => tx.src === 'receipt' ? '🧾' : tx.src === 'log' ? '📒' : tx.src === 'manual' ? '✍️' : '⚠️';
  const fdate = ts => { const d = new Date(ts * 1000); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const itemSummary = tx => tx.items.map(i => i.qty + '× ' + esc(i.name || nameOf(i.id))).join(', ');
  const chanLabel = c => ({ market: 'Market', bazaar: 'Bazaar', trade: 'Trade', send: 'Send', recv: 'Received' }[c] || c);

  function flipsHtml() {
    const cutoff = ui.range ? Date.now() / 1000 - ui.range * 86400 : 0;
    const res = computeFlips(state.txs, flipOpts());
    const flips = res.flips.filter(f => f.tx.ts >= cutoff).sort((a, b) => b.tx.ts - a.tx.ts);
    const total = flips.reduce((s, f) => s + (f.profit || 0), 0);
    let h = `<div class="tfp-h"><div><b>Profit</b> <span class="${total >= 0 ? 'tfp-pos' : 'tfp-neg'}" style="font-size:16px"><b>${fmt(total)}</b></span><div class="tfp-sub">${flips.length} flips · FIFO</div></div>
      <div><button class="tfp-b" data-act="range" data-v="7">7d</button> <button class="tfp-b" data-act="range" data-v="30">30d</button> <button class="tfp-b" data-act="range" data-v="0">All</button></div></div>
      <label><input type="checkbox" data-act="items" ${ui.items ? 'checked' : ''}> Per-item breakdown</label>`;
    if (res.pending.length) h += `<div class="tfp-msg tfp-warn">⚠️ ${res.pending.length} trade(s) need a value — see the "Needs value" tab.</div>`;
    if (!flips.length) h += '<div class="tfp-msg">No flips yet. Sync your log in Settings.</div>';
    flips.forEach(f => {
      const tx = f.tx;
      let flag = '';
      if (f.unmatched) flag += ` <span class="tfp-warn">⚠️ ${f.unmatched} unit(s) had no matching buy</span>`;
      if (f.costUnknown) flag += ' <span class="tfp-warn">⚠️ a matching buy has no value</span>';
      h += `<div class="tfp-row"><div class="tfp-top"><span>${fdate(tx.ts)} · ${chanLabel(tx.channel)} ${badge(tx)}</span>
        <b class="${f.profit == null ? 'tfp-warn' : f.profit >= 0 ? 'tfp-pos' : 'tfp-neg'}">${fmt(f.profit)}</b></div>
        <div class="tfp-sub">${itemSummary(tx)} · sold for ${fmt(tx.amount)}${tx.channel === 'market' && tx.src === 'log' && flipOpts().marketFee ? ' (' + fmt(tx.amount * (1 - flipOpts().marketFee)) + ' after fee)' : ''} <a href="#" data-act="edit" data-id="${esc(tx.id)}">✎</a>${flag}</div>`;
      if (ui.editing === tx.id) h += editBox(tx);
      if (ui.items) f.lines.forEach(l => {
        h += `<div class="tfp-line"><span>${l.qty}× ${esc(l.name || nameOf(l.itemId))}</span><span class="${l.profit == null ? 'tfp-warn' : l.profit >= 0 ? 'tfp-pos' : 'tfp-neg'}">${fmt(l.profit)}</span></div>`;
      });
      h += '</div>';
    });
    return h;
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
      let h = `<div class="tfp-row"><div class="tfp-top"><span>${fdate(tx.ts)} · ${chanLabel(tx.channel)}</span><span>⚠️</span></div><div class="tfp-sub">${itemSummary(tx)}${tx.cp ? ' · ' + esc(tx.cp) : ''}</div>`;
      if (!tx.dir) h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="sell">I sold these</button> <button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="buy">I bought these</button>`;
      else h += editBox(tx);
      return h + '</div>';
    }).join('');
  }
  function receiptsHtml() {
    let h = '<div class="tfp-sub">Paste a Weaver or TornExchange receipt link (or data copied with the "Add to profit tracker" button on the receipt page).</div><div class="tfp-gap"></div><textarea class="tfp-ta" id="tfp-rc" placeholder="https://tornexchange.com/receipt/..."></textarea><div class="tfp-gap"></div><button class="tfp-b" data-act="addrc">Add receipt</button>';
    const inbox = hasGM ? sget('inbox', []) : [];
    if (inbox.length) h += ` <button class="tfp-b" data-act="inbox">Process ${inbox.length} saved receipt(s)</button>`;
    if (ui.pendingReceipt) {
      const rc = ui.pendingReceipt;
      h += `<div class="tfp-msg"><b>${rc.source === 'weaver' ? 'Weaver' : 'TornExchange'} receipt</b> · ${fmt(rc.total)}<br>${rc.items.map(i => i.qty + '× ' + esc(i.name)).join(', ')}</div>`;
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
      <div class="tfp-sub">Your key is stored only on this device (script storage) and is sent only to api.torn.com to read your own log and item names. It is never shared with anyone else. Remove it here at any time, or delete it in Torn settings.</div>`;
    return `${keyBox}<div class="tfp-gap"></div><div class="tfp-sub">First sync looks back this many days</div>
      <input class="tfp-in" id="tfp-days" inputmode="numeric" value="${esc(sget('startDays', 30))}"><div class="tfp-gap"></div><div class="tfp-sub">Item market fee % (market sales only)</div>
      <input class="tfp-in" id="tfp-fee" inputmode="decimal" value="${esc(sget('marketFee', 5))}"><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="sync">${ui.busy ? 'Syncing…' : 'Sync log now'}</button>
      <div class="tfp-sub">Last sync: ${state.lastSync ? fdate(state.lastSync) : 'never'} · ${Object.keys(state.txs).length} records</div>
      <div class="tfp-row"><b>Backup</b><div class="tfp-gap"></div><textarea class="tfp-ta" id="tfp-bk" placeholder="Export fills this box. Paste a backup here to import."></textarea><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="export">Export</button> <button class="tfp-b" data-act="import">Import</button></div>
      <div class="tfp-row"><b>Troubleshooting</b><div class="tfp-gap"></div><button class="tfp-b" data-act="debug">Copy debug sample</button></div>`;
  }

  function render() {
    const card = document.getElementById('tfp-card');
    if (!card) return;
    const needs = computeFlips(state.txs, flipOpts()).pending.length;
    const tabs = [['flips', 'Flips'], ['pending', 'Needs value' + (needs ? ' (' + needs + ')' : '')], ['receipts', 'Receipts'], ['settings', 'Settings']];
    card.innerHTML = `<div class="tfp-h"><b>💰 Flip Profit Tracker</b><button class="tfp-b" data-act="close">✕</button></div>
      <div class="tfp-tabs">${tabs.map(t => `<button class="tfp-tab ${ui.tab === t[0] ? 'on' : ''}" data-act="tab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div>
      ${ui.msg ? `<div class="tfp-msg">${esc(ui.msg)}</div>` : ''}
      ${ui.tab === 'flips' ? flipsHtml() : ui.tab === 'pending' ? pendingHtml() : ui.tab === 'receipts' ? receiptsHtml() : settingsHtml()}`;
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
    if (act === 'edit') e.preventDefault();
    ui.msg = '';
    try {
      if (act === 'close') ui.open = false, document.getElementById('tfp-wrap').classList.remove('open');
      else if (act === 'tab') { ui.tab = v; ui.editing = null; }
      else if (act === 'range') ui.range = Number(v);
      else if (act === 'items') ui.items = el.checked;
      else if (act === 'edit') ui.editing = ui.editing === id ? null : id;
      else if (act === 'dir') state.txs[id].dir = v, save();
      else if (act === 'saveval') {
        const n = firstNumber(val('tfp-val-' + id));
        if (n == null) throw new Error('Enter a number.');
        const tx = state.txs[id]; tx.amount = n; tx.src = 'manual'; tx.locked = true; ui.editing = null; save();
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
      else if (act === 'sync') {
        sset('startDays', Number(val('tfp-days')) || 30);
        { const f = parseFloat(val('tfp-fee')); sset('marketFee', isNaN(f) ? 5 : f); }
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
        const sample = { syncInfo: lastSyncInfo, rawEntries: lastRaw, seenTitles: state.seenTitles, lastSync: state.lastSync, sampleTxs: Object.values(state.txs).slice(-5), header: hdr ? hdr.slice(0, 6000) : null, headerPath: tb ? [tb.tagName, tb.id, tb.className, tb.parentElement && tb.parentElement.className].join(' | ') : null };
        const ok = await copyText(JSON.stringify(sample, null, 1));
        ui.msg = ok ? 'Debug sample copied. Paste it to Claude.' : 'Could not copy. Sync first, then try again.';
      }
    } catch (err) { ui.msg = String(err.message || err); }
    render();
  }

  function openPanel() { ui.open = true; document.getElementById('tfp-wrap').classList.add('open'); render(); }
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
      document.body.appendChild(w);
    }
    if (!document.getElementById('tfp-btn')) {
      const b = document.createElement('button'); b.id = 'tfp-btn'; b.textContent = '💰'; b.title = 'Flip Profit Tracker';
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
    if (/tornexchange\.com|weav3r\.dev/.test(location.hostname)) {
      mountReceiptButton();
      setInterval(mountReceiptButton, 3000);
    } else {
      mountTornUI();
      setInterval(mountTornUI, 2500);
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = { computeFlips, parseTornExchange, parseWeaver, roleFor, rankCandidates, parseLogEntry, firstNumber, parseTimeText };
  }
  if (typeof document !== 'undefined' && !globalThis.__TFP_TEST) init();
})();
