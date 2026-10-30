// ==UserScript==
// @name         Arbitrage
// @namespace    torn-flip-profit-tracker
// @version      0.1.162-beta
// @description  Flip profit for Torn: reads your own Torn log and works out profit per sale (FIFO), with Weaver, TornExchange and PawnHub receipts. Read-only, data stays on your device.
// @author       MysteryDryad
// @homepageURL  https://github.com/MysteryDryad/Arbitrage
// @supportURL   https://github.com/MysteryDryad/Arbitrage/issues
// @match        https://www.torn.com/*
// @match        https://tornexchange.com/receipt/*
// @match        https://weav3r.dev/receipt/*
// @match        https://z0cl.eu/PawnHub/*
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
 * ARBITRAGE: flip profit for Torn City (Torn PDA and Tampermonkey/Violentmonkey)
 *
 * What it does
 * - Reads YOUR item market, bazaar, trade and item-send entries from the Torn log and works out profit per sale (first in, first out).
 * - Optional receipts (Weaver / TornW3B, TornExchange, PawnHub) replace the log amount when they have an exact price.
 *
 * Privacy and safety
 * - Read-only: it never performs game actions, clicks or purchases for you.
 * - Your data (trade history, settings, keys) is stored only on this device (script storage / browser storage).
 * - Your Torn API key (a Custom key with just the selections this script reads: user basic and log, torn items; Full Access also works but is not needed) is sent only to api.torn.com. A TornW3B key, if you add one, is sent only to weav3r.dev.
 * - Receipt pages (tornexchange.com, weav3r.dev, z0cl.eu) are read only in your own browser when you open them; nothing is uploaded anywhere.
 * - Backup/restore is in Settings > Backup & troubleshooting. Deleting the key in Torn settings revokes access at once.
 *
 * Troubleshooting: Settings > Backup & troubleshooting > "Copy debug sample" (contains no API keys).
 */
(function () {
  'use strict';

  /* ===================== environment helpers ===================== */
  const NS = 'tfp_';
  const PDA_KEY = '###PDA-APIKEY###';
  const IN_PDA = PDA_KEY[0] !== '#';
  const IS_PDA_ENV = IN_PDA || typeof PDA_httpGet === 'function' || (typeof window !== 'undefined' && !!window.flutter_inappwebview);
  const VERSION = '0.1.162-beta'; // keep equal to @version above (test.js checks this)
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  // Torn PDA's own app storage is shared by the pages of this script on every site, unlike its browser-backed GM storage: receipts travel through it.
  const nat = () => typeof PDA_storage !== 'undefined' ? PDA_storage : null;
  async function inboxGet() {
    const n = nat();
    if (n) { try { const v = await n.get('inbox', []); return Array.isArray(v) ? v : []; } catch (e) { /* fall back */ } }
    return hasGM ? sget('inbox', []) : [];
  }
  async function inboxSet(v) {
    const n = nat();
    if (n) { try { await n.set('inbox', v); return true; } catch (e) { /* fall back */ } }
    return hasGM ? sset('inbox', v) : false;
  }

  // With a PawnHub key saved, the API reads the payments and the PawnHub pages need no banner or button. The flag lives in PDA's shared storage too, so the PawnHub page can see it.
  async function phKeyOn() {
    if (sget('phkey', '')) return true;
    const n = nat(); if (n) { try { return !!(await n.get('phkeyset', false)); } catch (e) { /* ignore */ } }
    return false;
  }
  async function w3bKeyOn() {
    if (sget('w3bkey', '')) return true;
    const n = nat(); if (n) { try { return !!(await n.get('w3bkeyset', false)); } catch (e) { /* ignore */ } }
    return false;
  }
  async function w3bFlagSet(v) { try { sset('w3bkeyset', !!v); } catch (e) { /* ignore */ } const n = nat(); if (n) { try { await n.set('w3bkeyset', !!v); } catch (e) { /* ignore */ } } }
  async function phFlagSet(v) { try { sset('phkeyset', !!v); } catch (e) { /* ignore */ } const n = nat(); if (n) { try { await n.set('phkeyset', !!v); } catch (e) { /* ignore */ } } }
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


  function http(url, headers) {
    return new Promise((resolve, reject) => {
      if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url, headers || {}).then(r => { if (!r) { const er = new Error('No reply from the network (Torn PDA returned nothing)'); er.noReply = true; reject(er); return; } resolve({ status: r.status || r.statusCode, text: r.responseText }); }).catch(reject);
        return;
      }
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, headers: headers || {},
          onload: r => resolve({ status: r.status, text: r.responseText }),
          onerror: reject, ontimeout: reject
        });
        return;
      }
      fetch(url, headers ? { headers } : undefined).then(async r => resolve({ status: r.status, text: await r.text() })).catch(reject);
    });
  }

  // A request that got no reply (Torn PDA sometimes returns nothing under load) is tried again a few times before giving up.
  async function httpRetry(url, headers) {
    for (let t = 0; ; t++) {
      try { const r = await http(url, headers); if (r) return r; throw Object.assign(new Error('No reply from the network'), { noReply: true }); }
      catch (e) { if (t < 4 && (e.noReply || /undefined is not an object|network|failed to fetch|handshake|connection|timed? ?out|socket|reset|terminated|ssl|tls/i.test(String(e && e.message)))) { await new Promise(res => setTimeout(res, 3000 * (t + 1))); continue; } throw e; }
    }
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
    const QTY = /^(\d[\d,]*)\s*[x×]\s*\$?\s*([\d,]+)$/i;
    doc.querySelectorAll('body *').forEach(el => {
      if (el.children.length) return;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(QTY);
      if (!m) return;
      // The item name is the text next to the "qty x $price" label: the rest of its parent, or the element before it.
      const par = el.parentElement;
      let name = par ? (par.textContent || '').replace(/\s+/g, ' ').replace(t, '').trim() : '';
      if (!name || /^\$[\d,]+$/.test(name)) { const prev = el.previousElementSibling; name = prev ? (prev.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
      if (!name || /^\$[\d,]+$/.test(name)) return;
      items.push({ id: null, name, qty: Number(m[1].replace(/,/g, '')), price: Number(m[2].replace(/,/g, '')) });
    });
    if (!tid || !items.length) return null;
    const total = items.reduce((a, i) => a + i.qty * i.price, 0);
    // Safety check: the page must show a total equal to what we computed, otherwise we may have misread it.
    const idx = leaves.findIndex(t => /^\$[\d,]+$/.test(t) && firstNumber(t) === total);
    const inline = leaves.some(t => /^.+\s\$[\d,]+$/.test(t) && firstNumber(t.replace(/^.*\s(\$[\d,]+)$/, '$1')) === total);
    if (idx < 0 && !inline) return null;
    return { source: 'pawnhub', url, tradeId: Number(tid[1]), buyer: null, seller: null, buyerId: null, sellerId: null, party: idx > 0 ? leaves[idx - 1] : null, items, total, timeText: null, ts: null };
  }

  // PawnHub "balance events" page: one row per item PawnHub credited you for (time UTC, item, role, qty, unit, total).
  function parsePawnHubBalance(doc, url) {
    const events = [];
    const TIME = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*UTC/;
    doc.querySelectorAll('tr').forEach(tr => {
      const cells = Array.from(tr.children).map(c => (c.textContent || '').replace(/\s+/g, ' ').trim());
      const ti = cells.findIndex(c => TIME.test(c));
      if (ti < 0 || cells.length < ti + 6) return;
      const m = cells[ti].match(TIME);
      const qty = firstNumber(cells[ti + 3]), unit = firstNumber(cells[ti + 4]), total = firstNumber(cells[ti + 5]);
      if (!qty || unit == null || total == null) return;
      events.push({ ts: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, item: cells[ti + 1], role: cells[ti + 2], qty, unit, total });
    });
    if (!events.length) return null;
    // Some layouts keep a hidden second copy of the table in the page, so every row is read twice: if every row occurs an even number of times, count each half once.
    const key = e => [e.ts, e.item, e.role, e.qty, e.unit, e.total].join('|'), counts = {};
    events.forEach(e => { counts[key(e)] = (counts[key(e)] || 0) + 1; });
    let rows = events, halved = false;
    if (Object.values(counts).every(n => n % 2 === 0)) {
      const seen = {}; rows = events.filter(e => { const k = key(e); seen[k] = (seen[k] || 0) + 1; return seen[k] <= counts[k] / 2; }); halved = true;
    }
    return { source: 'pawnhub-balance', url, events: rows, halved, total: rows.reduce((a, e) => a + e.total, 0) };
  }
  // Pair each credited item event with the oldest unmatched send of the same item and quantity in the 10 minutes before the credit (the credit lands some minutes after the send).
  const PH_LAG = 600;
  const phNear = (t, e) => e.ts - t.ts >= -120 && e.ts - t.ts <= PH_LAG;
  function matchPawnHubEvents(events, txsObj, byName) {
    const sends = Object.values(txsObj).filter(t => t.channel === 'send' && t.dir === 'sell' && t.src !== 'receipt' && t.items && t.items.length === 1);
    const used = new Set(), out = [];
    events.slice().sort((a, b) => a.ts - b.ts).forEach(ev => {
      const id = ev.itemId || byName[String(ev.item).toLowerCase()];
      if (!id) return;
      let best = null;
      sends.forEach(t => {
        if (used.has(t.id) || t.items[0].id !== id || t.items[0].qty !== ev.qty) return;
        const d = ev.ts - t.ts; // PawnHub credits the payment some minutes after the send: take the oldest unmatched send up to 10 minutes before the credit (events go oldest first)
        if (d >= -120 && d <= PH_LAG && (!best || t.ts < best.t.ts)) best = { t, d };
      });
      if (best) { used.add(best.t.id); out.push({ txId: best.t.id, event: ev }); }
    });
    return out;
  }

  function parseReceiptDoc(doc, url) {
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();
    if (/tornexchange/i.test(host)) return parseTornExchange(doc, url);
    if (/weav3r/i.test(host)) return parseWeaver(doc, url);
    if (/z0cl/i.test(host)) return parsePawnHubBalance(doc, url) || parsePawnHub(doc, url);
    return null;
  }

  // Some receipt sites refuse scripted requests (HTTP 403). The fallback loads the receipt like a browser would, in a hidden frame; the script running on the receipt site reads the page and posts it back.
  function viaFrame(url) {
    return new Promise((resolve, reject) => {
      let origin; try { origin = new URL(url).origin; } catch (e) { reject(new Error('Bad link')); return; }
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-20px;top:-20px;width:2px;height:2px;border:0;opacity:0;pointer-events:none';
      let done = false, timer, hello = false;
      const finish = (fn, v) => { if (done) return; done = true; window.removeEventListener('message', onMsg); clearTimeout(timer); f.remove(); fn(v); };
      const onMsg = ev => { if (ev.origin !== origin || !ev.data) return; if (ev.data.tfpHello) hello = true; if (ev.data.tfpReceipt) finish(resolve, ev.data.tfpReceipt); };
      timer = setTimeout(() => finish(reject, new Error(hello ? 'the page loaded but showed no receipt (login needed?)' : 'the script did not run inside the page (framing blocked, or the app does not run scripts in frames)')), 30000);
      window.addEventListener('message', onMsg);
      f.src = url.split('#')[0] + '#tfp-frame';
      document.body.appendChild(f);
    });
  }
  async function fetchReceipt(url) {
    try { return await fetchReceiptDirect(url); }
    catch (e) {
      try { return await viaFrame(url); } catch (e2) { const er = new Error('Could not read this page in the background (' + (/HTTP (\\d+)/.test(e.message) ? 'the site answered ' + e.message.match(/HTTP (\\d+)/)[0] : 'it builds its content after loading') + '). Open it in a tab instead and it saves itself.'); er.detail = (e.message || e) + ' | frame: ' + (e2.message || e2); throw er; }
    }
  }
  async function fetchReceiptDirect(url) {
    const r = await http(url);
    if (!r || r.status >= 400) throw new Error('The site refused the link (HTTP ' + (r && r.status) + ')');
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const rc = parseReceiptDoc(doc, url);
    if (!rc) { const e = new Error('The page loaded (' + String(r.text || '').length + ' characters) but has no receipt data in it. This site builds its page after it loads.'); e.unreadable = true; throw e; }
    return rc;
  }

  /* ===================== ledger engine (pure) ===================== */
  // A send valued at $0 by hand is a gift too (covers gifts saved before the gift flag existed).
  const isGift = tx => (tx.dir === 'sell' && (tx.gift || (tx.channel === 'send' && tx.src === 'manual' && tx.amount === 0))) || (tx.dir === 'buy' && (tx.gift || (tx.channel === 'recv' && tx.src === 'manual' && tx.amount === 0)));
  function computeFlips(txsObj, opts) {
    const fee = (opts && opts.marketFee) || 0;
    const vals = (opts && opts.values) || {};
    // Fee applies only to item-market sales whose amount came from the log (receipt/manual values are used as entered).
    const net = tx => (tx.channel === 'market' && tx.dir === 'sell' && tx.src === 'log') ? tx.amount * (1 - fee) : tx.amount;
    const txs = Object.values(txsObj).sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
    const lots = {};
    const flips = [], pending = [];

    function addLots(tx) {
      const allPriced = tx.items.every(i => i.price != null);
      // No per-item prices (no receipt): split the trade total by each item's market value, or by quantity if values are unknown.
      const mvW = tx.items.map(i => i.qty * (vals[i.id] || 0));
      const w = mvW.every(x => x > 0) ? mvW : tx.items.map(i => i.qty);
      const wsum = w.reduce((a, b) => a + b, 0) || 1;
      tx.items.forEach((i, idx) => {
        let unit = null;
        if (allPriced) unit = i.price;
        else if (tx.amount != null) unit = tx.amount * w[idx] / wsum / (i.qty || 1);
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
      if (tx.dir === 'buy') { if (isGift(tx)) continue; /* received as a gift: not stock, not a buy */ addLots(tx); if (tx.amount == null) pending.push(tx); continue; }
      if (tx.dir !== 'sell') { pending.push(tx); continue; }

      const consumed = tx.items.map(it => Object.assign({ it }, consume(it.id, it.qty)));
      if (isGift(tx)) continue; // given away: leaves stock, not counted in profit
      if (tx.amount == null) { if (opts && opts.skipUnvaluedSends && tx.channel === 'send') continue; /* sends the user does not track: leave empty, not counted */ pending.push(tx); continue; }

      const allPriced = tx.items.every(i => i.price != null);
      const mvW = tx.items.map(i => i.qty * (vals[i.id] || 0));
      let weights = allPriced ? tx.items.map(i => i.price * i.qty) : (mvW.every(x => x > 0) ? mvW : consumed.map(c => c.cost || 0));
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
    { re: /item ?market.*(sell|sold|sale)/i, channel: 'market', dir: 'sell' },
    { re: /^item abroad buy/i, channel: 'abroad', dir: 'buy' }, // flowers and plushies bought while travelling
    { re: /^(item |city )?shop (buy|bought|purchase)/i, channel: 'shop', dir: 'buy' },
    { re: /^(item |city )?shop (sell|sold|sale)|^(item )?sell.*(shop|npc)|^npc.*sell/i, channel: 'shop', dir: 'sell' }
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
    for (const k of ['total_cost', 'total', 'total_price', 'money', 'cost_total', 'total_value', 'cost', 'price', 'value']) {
      if (typeof d[k] === 'number') return d[k];
    }
    const qty = items.reduce((s, i) => s + i.qty, 0) || 1;
    for (const k of ['cost_each', 'value_each', 'price_each', 'cost_per', 'unit_price']) {
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
    return Object.assign({
      id: 'log:' + e.id, ts: e.timestamp, dir: rule.dir, channel: rule.channel,
      cp: pickCounterparty(d),
      tradeId: d.trade_id != null ? d.trade_id : (e.params && e.params.trade_id != null ? e.params.trade_id : null),
      items, amount, src: amount != null ? 'log' : null, locked: false,
      title: (e.details && e.details.title) || e.title || ''
    }, rule.channel === 'market' && rule.dir === 'sell' ? { each: typeof d.cost_each === 'number' ? d.cost_each : null, fee: typeof d.fee === 'number' ? d.fee : null, anon: d.anonymous ? 1 : 0 } : {});
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
    const raw = d.trade_id != null ? d.trade_id : (e.params && e.params.trade_id != null ? e.params.trade_id : (d.trade != null && typeof d.trade !== 'object' ? d.trade : null));
    if (raw == null) return null;
    const m = String(raw).match(/ID=(\d+)/) || String(raw).match(/^\s*(\d+)\s*$/) || String(raw).match(/(\d{5,})/);
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
  // parts: { entryId: { ts, kind: 'send'|'recv', cp, items:[{id,qty}], msg } }. Set SEND_GROUP_SECONDS above 0 to merge
  // entries to the same player within that many seconds into one record.
  const SEND_GROUP_SECONDS = -1; // -1: every send/receive is its own record, so each can be matched to what that person paid
  function buildSendTxs(parts, nameOf) {
    const list = Object.entries(parts || {}).map(([id, p]) => Object.assign({ id }, p))
      .sort((a, b) => (a.kind + a.cp).localeCompare(b.kind + b.cp) || a.ts - b.ts);
    const groups = [];
    list.forEach(p => {
      const g = groups[groups.length - 1];
      if (g && g.kind === p.kind && String(g.cp) === String(p.cp) && p.ts - g.last <= SEND_GROUP_SECONDS) { g.entries.push(p); g.last = p.ts; }
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
  let itemValues = sget('itemvals', null) || {};
  let lastRaw = [];
  let lastSyncInfo = null;
  const ui = { open: false, tab: 'profit', items: false, breakdown: false, more: false, showPending: false, range: (r => ['today', 'yesterday', 'custom'].includes(r) ? r : [1, 7, 30, 90, 0].includes(Number(r)) ? Number(r) : 30)(sget('range', 30)), from: sget('rangeFrom', ''), to: sget('rangeTo', ''), editing: null, msg: '', pendingReceipt: null, candidates: [], busy: false };
  // Several Torn pages (and your phone's page cache) can hold their own copy of the data. Before one overwrites the other, fold in what the other copy has that this one lacks, so a value from a receipt or Balance import can never be lost to a stale copy.
  const valued = t => t && (t.locked || t.src === 'receipt' || t.src === 'manual') && t.amount != null;
  function mergeState(mine, other) {
    if (!other || !other.txs) return mine;
    Object.entries(other.txs).forEach(([id, t]) => {
      const m = mine.txs[id];
      if (!m) mine.txs[id] = t; // a record only the other copy has (a page with stale data must not drop it)
      else if (valued(t) && !valued(m)) mine.txs[id] = Object.assign({}, m, { amount: t.amount, src: t.src, gift: t.gift, locked: t.locked, receiptUrl: t.receiptUrl, items: t.items && m.items && t.items.length === m.items.length ? t.items : m.items });
    });
    ['receipts', 'tradeEnd', 'tradeParts', 'sendParts', 'moneyEvents', 'listEvents', 'ack', 'names'].forEach(k => { if (other[k]) mine[k] = Object.assign({}, other[k], mine[k] || {}); });
    if (other.w3b) { const w = mine.w3b = mine.w3b || { done: {}, miss: {}, at: {} }; ['done', 'at'].forEach(k => { w[k] = Object.assign({}, other.w3b[k] || {}, w[k] || {}); }); w.miss = w.miss || {}; }
    if ((other.lastSync || 0) > (mine.lastSync || 0) && !mine.resume) mine.lastSync = other.lastSync;
    if (other.pawnhubSince && (!mine.pawnhubSince || other.pawnhubSince < mine.pawnhubSince)) mine.pawnhubSince = other.pawnhubSince;
    if (!mine.me && other.me) mine.me = other.me;
    return mine;
  }
  let lastWrite = state.savedAt || 0;
  // The full copy lives in IndexedDB (shared by all Torn pages). Script storage only gets a small compressed backup, because the plain data outgrew it.
  const hasZ = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Response === 'function' && typeof btoa === 'function';
  const gzip = async text => { const cs = new CompressionStream('gzip'), w = cs.writable.getWriter(); w.write(new TextEncoder().encode(text)); w.close(); const u = new Uint8Array(await new Response(cs.readable).arrayBuffer()); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); };
  const gunzip = async b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter(); w.write(u); w.close(); return new Response(ds.readable).text(); };
  // Hand-off through the page address (the part after #), for when two tabs cannot share storage: nothing is sent to any server.
  const b64url = b => b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = b => { b = b.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; return b; };
  async function packReceipt(rc) {
    const json = JSON.stringify(rc);
    if (hasZ) return 'z.' + b64url(await gzip(json));
    return 'j.' + b64url(btoa(unescape(encodeURIComponent(json))));
  }
  async function unpackReceipt(str) {
    const kind = str.slice(0, 2), body = unb64url(str.slice(2));
    return JSON.parse(kind === 'z.' ? await gunzip(body) : decodeURIComponent(escape(atob(body))));
  }
  let backupT = null;
  function scheduleBackup() {
    if (backupT || !hasGM && typeof localStorage === 'undefined') return;
    backupT = setTimeout(async () => {
      backupT = null;
      try {
        const copy = Object.assign({}, state, { seenExamples: {} });
        if (hasZ) { const z = await gzip(JSON.stringify(copy)), n = nat(); let ok = false; if (n) { try { await n.set('statez', { at: state.savedAt, z }); ok = true; } catch (e) { /* quota or bridge error: use script storage */ } } if (sset('statez', { at: state.savedAt, z }) || ok) sset('state', null); }
        else { const t = JSON.stringify(copy); if (t.length < 1000000) sset('state', copy); }
      } catch (e) { /* the backup is optional */ }
    }, 15000);
  }
  const save = () => {
    const prev = lastWrite; state.savedAt = Date.now(); lastWrite = state.savedAt;
    if (!hasIDB) { lastSaveOk = sset('state', state); return; }
    const mine = state.savedAt;
    idb.get('state').catch(() => null)
      .then(v => { if (v && v.txs && (v.savedAt || 0) > prev && v.savedAt !== mine) mergeState(state, v); return idb.set('state', state); }) // another page saved newer data meanwhile: keep both
      .then(() => { lastSaveOk = true; idbErr = null; })
      .catch(e => { idbErr = String(e && e.message || e); lastSaveOk = sset('state', state); });
    scheduleBackup();
  };
  const STATE_DEFAULTS = () => ({ v: 1, me: null, lastSync: 0, txs: {}, receipts: {}, seenTitles: {}, seenExamples: {}, tradeParts: {}, sendParts: {}, moneyEvents: {} });
  // Load the saved state from IndexedDB when it is newer than what script storage gave us.
  const bootP = !hasIDB ? Promise.resolve() : Promise.all([idb.get('state').catch(() => null), idb.get('items').catch(() => null), idb.get('itemvals').catch(() => null)]).then(async ([v, it, iv]) => {
    if (iv && Object.keys(iv).length >= Object.keys(itemValues).length) itemValues = iv;
    if (v && v.txs) {
      if ((v.savedAt || 0) >= (state.savedAt || 0)) { const old = state; state = mergeState(Object.assign(STATE_DEFAULTS(), v), old); }
      else mergeState(state, v);
      lastWrite = Math.max(lastWrite, state.savedAt || 0);
    }
    if (it && Object.keys(it).length >= Object.keys(itemNames).length) itemNames = it;
    let z = hasZ ? sget('statez', null) : null;
    if (hasZ && nat()) { try { const nz = await nat().get('statez', null); if (nz && nz.z && (!z || (nz.at || 0) > (z.at || 0))) z = nz; } catch (e) { /* ignore */ } } // the app's own storage survives a browser cache clear
    if (hasZ && (!v || !v.txs || (v.savedAt || 0) < ((z || {}).at || 0))) { // IndexedDB was cleared or is older than the compressed backup
      if (z && z.z && (z.at || 0) > (state.savedAt || 0)) { try { const back = JSON.parse(await gunzip(z.z)); if (back && back.txs) { state = mergeState(Object.assign(STATE_DEFAULTS(), back), state); lastWrite = Math.max(lastWrite, state.savedAt || 0); } } catch (e) { /* backup unreadable */ } }
    }
  }).catch(() => {});
  // Read the saved copy back and compare, so a silently failing save shows up as a warning.
  function verifySaved() {
    if (hasIDB) return;
    try { const back = sget('state', null); lastSaveOk = !!back && Object.keys(back.txs || {}).length === Object.keys(state.txs || {}).length; }
    catch (e) { lastSaveOk = false; }
  }
  const netAmt = tx => tx.amount;
  const gotWord = tx => tx.channel === 'send' ? 'received' : 'sold for';
  const costOf = f => f.lines.some(l => l.matched > 0 && l.cost == null) ? null : f.lines.reduce((a, l) => a + (l.cost || 0), 0);
  // PawnHub users get their sends valued from PawnHub; everyone else leaves plain sends empty (they leave stock but are not counted and never nag).
  const usesPH = () => { const v = sget('usePH', null); return v == null ? !!state.pawnhubSince : !!v; };
  const flipOpts = () => ({ marketFee: 0, values: itemValues, skipUnvaluedSends: !usesPH() }); // Torn's market-sale log amount is already after the fee
  const nameOf = id => itemNames[id] || ('Item ' + id);

  /* ===================== Torn API ===================== */
  function getKey() { return (sget('apikey', '') || '') || (IN_PDA ? PDA_KEY : ''); }
  const KEYURL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Arbitrage&user=basic,log&torn=items,logcategories';
  async function apiUrl(url) {
    const key = getKey();
    if (!key && !/[?&]key=/.test(url)) throw new Error('No API key set (Settings tab).');
    const u = url + (url.includes('?') ? '&' : '?') + (/[?&]key=/.test(url) ? '' : 'key=' + encodeURIComponent(key));
    const r = await httpRetry(u);
    let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('Bad API response (HTTP ' + (r && r.status) + ')'); }
    if (j && j.error && j.error.code === 16) throw new Error('Your API key does not have enough access. Reading your log needs a Custom key with the user log ticked (Settings > Create the key for me), or a Full Access key; a Limited Access key is refused.');
    if (j && j.error && j.error.code === 2) throw new Error('Torn rejected the API key as incorrect. Check it in Settings.');
    if (j && j.error && j.error.code === 5) { const er = new Error('Torn is limiting requests (too many in one minute). Progress is saved and will continue on the next sync.'); er.rate = true; throw er; }
    if (j && j.error) { const er = new Error('Torn API: ' + (j.error.error || j.error.code) + ' (code ' + j.error.code + ')'); er.code = j.error.code; throw er; }
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
  const itemCat = {}; // item id -> the category name the inventory API uses (from Torn's item list)
  async function ensureItems(force) {
    if (!force && Object.keys(itemNames).length && Object.keys(itemValues).length) return;
    try {
      const j = await api('torn/items');
      const list = Array.isArray(j.items) ? j.items : Object.entries(j.items || {}).map(([id, v]) => Object.assign({ id }, v));
      list.forEach(i => { itemNames[i.id] = i.name; const c = i.type === 'Weapon' ? (i.details && i.details.category) : i.type; if (c) itemCat[i.id] = c; const v = i.value || {}; const mv = [v.market_value, v.market_price, i.market_value, i.market_price].find(x => x > 0); if (mv > 0) itemValues[i.id] = mv; });
      state.itemSample = list.filter(i => i.name).slice(0, 2); // shape check for the debug sample
      sset('items', itemNames); sset('itemvals', itemValues);
      if (hasIDB) { idb.set('items', itemNames).catch(() => {}); idb.set('itemvals', itemValues).catch(() => {}); }
    } catch (e) { console.warn('[TFP] item names failed', e); }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Rebuild the per-entry send/receive records from the stored log entries (no network needed).
  function rebuildSendTxs() {
    let added = 0;
    const sends = buildSendTxs(state.sendParts, nameOf);
    Object.keys(state.txs).forEach(id => { // drop earlier per-entry send/receive records and stale batches; keep ones you valued
      const t = state.txs[id];
      if ((t.channel === 'send' || t.channel === 'recv') && !t.locked && (id.indexOf('log:') === 0 || (id.indexOf('send:') === 0 && !sends[id]))) delete state.txs[id];
    });
    Object.entries(sends).forEach(([id, tx]) => {
      const old = state.txs[id];
      if (!old) added++;
      state.txs[id] = old && old.locked && !(old.count > 1) ? Object.assign({}, tx, { amount: old.amount, src: old.src, gift: old.gift, locked: true }) : tx; // a value entered for an old merged batch no longer fits one entry: dropped
    });
    return added;
  }
  // One tap does everything: read the log, pick up saved receipts, import Weaver receipts. Shows only "Syncing…" while it runs; the details go to the debug sample.
  // Receipts attached before the $0-line fix: redo them from the stored receipt when the log amount is higher.
  function reapplyZeroPriced() {
    let n = 0;
    Object.values(state.txs).forEach(t => {
      const rc = t.src === 'receipt' && t.logAmount != null && t.receiptUrl && state.receipts[t.receiptUrl];
      if (rc && !t.zeroFixed && t.amount < t.logAmount && rc.items && rc.items.some(i => !(i.price > 0))) { try { attachReceipt(rc, t); n++; } catch (e) { /* leave it */ } }
    });
    return n;
  }
  async function readLogFully() {
    let added = 0;
    for (let round = 0; round < 12; round++) {
      try { added += await syncLog(); return added; }
      catch (e) { if (!e.capped || round === 11) throw e; added += e.added || 0; await sleep(1500); }
    }
    return added;
  }
  async function syncAll() {
    let added = 0, att = 0, last = null, weaverErr = '';
    const T0 = Date.now(), tm = {}, lap = k => { tm[k] = Math.round((Date.now() - T0) / 100) / 10; };
    const readLog = async () => { added += await readLogFully(); };
    await readLog(); lap('log');
    try { if ((await inboxGet()).length) await processInbox(true); } catch (e) { /* receipts stay queued */ }
    lap('inbox');
    let pawn = null, pawnErr = '';
    const phStart = Date.now();
    if (!IS_PDA_ENV && hasGM && sget('pawnhubAuto', false)) { try { pawn = await readPawnHubBalance(); } catch (e) { pawnErr = String(e.message || e).slice(0, 120); } }
    if (usesPH() && sget('phkey', '')) { try { pawn = await readPawnHubApi(); } catch (e) { pawnErr = String(e.message || e).slice(0, 120); } }
    lap('pawnhub'); tm.phSecs = Math.round((Date.now() - phStart) / 100) / 10;
    if (sget('w3bkey', '')) {
      try {
        for (let round = 0; round < 15; round++) { last = await weaverImport(); att += last.attached; if (!last.left) break; }
        // A receipt whose trade is not in your data may have been missed (log read cut short, or an older copy of your data saved over it): read the log again from a bit before it, once per receipt.
        if (last && last.reread && last.reread.length) {
          const w = state.w3b; last.reread.forEach(r => { w.re[r.id] = Math.floor(Date.now() / 1000); });
          state.lastSync = Math.min(state.lastSync || 0, Math.min.apply(null, last.reread.map(r => r.ts)) - 86400); state.resume = null; save();
          await readLog();
          last = await weaverImport(); att += last.attached;
        }
      } catch (e) { weaverErr = String(e.message || e); }
    }
    lap('weaver');
    try { reapplyZeroPriced(); snapshotProfit(); } catch (e) { /* ignore */ }
    lap('total');
    state.lastSyncDetail = { at: Math.floor(Date.now() / 1000), seconds: tm, added, attached: att, weaver: last ? last.text : null, weaverErr: weaverErr || null, pawnhub: pawn ? pawn.text : null, pawnhubErr: pawnErr || null }; save();
    const bits = [];
    if (added) bits.push(added + ' new record' + (added === 1 ? '' : 's'));
    if (att) bits.push(att + ' receipt' + (att === 1 ? '' : 's') + ' attached');
    if (last && last.missing) bits.push(last.missing + ' Weaver receipt' + (last.missing === 1 ? ' has' : 's have') + ' no matching trade yet (Settings → Check Weaver)');
    if (pawn && pawn.short) bits.push(pawn.short);
    if (pawn && pawn.preview) bits.push('PawnHub is ready: check the box at the top of the screen');
    if (pawn && pawn.valued) bits.push(pawn.valued + ' PawnHub payment' + (pawn.valued === 1 ? '' : 's') + ' matched');
    if (weaverErr) bits.push('Weaver: ' + weaverErr.slice(0, 90));
    if (pawnErr) bits.push('PawnHub: ' + pawnErr.slice(0, 70));
    const slow = tm.total > 8 ? ' (' + Math.round(tm.total) + ' s: log ' + Math.round(tm.log) + ', inbox ' + Math.round(tm.inbox - tm.log) + ', PawnHub ' + Math.round(tm.phSecs) + ', Weaver ' + Math.round(tm.weaver - tm.pawnhub) + ')' : '';
    return (bits.length ? 'Synced · ' + bits.join(' · ') : 'Up to date.') + slow;
  }
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
      const arr = normalizeLog(j.log);
      lastSyncInfo.pages = pages; lastSyncInfo.entries += arr.length;
      { const ts = arr.map(x => x.timestamp).filter(Number); const md = j._metadata || {};
        lastSyncInfo.pageInfo.push({ count: arr.length, newest: ts.length ? Math.max.apply(null, ts) : null, oldest: ts.length ? Math.min.apply(null, ts) : null,
          meta: JSON.stringify(md).replace(/key=[A-Za-z0-9]+/g, 'key=HIDDEN').slice(0, 400) }); }
      { const o = arr.reduce((m, x) => Number(x.timestamp) && x.timestamp < m ? x.timestamp : m, state.oldestLog || Infinity); if (o !== Infinity) state.oldestLog = o; }
      arr.slice(0, 8 - lastSyncInfo.firstRaw.length).forEach(e => lastSyncInfo.firstRaw.push(e));
      arr.forEach(e => {
        const title = (e.details && e.details.title) || e.title || '';
        if (title) state.seenTitles[title] = (state.seenTitles[title] || 0) + 1;
        if (e.timestamp > newest) newest = e.timestamp;
        state.seenExamples = state.seenExamples || {};
        if (title && !state.seenExamples[title] && (Object.keys(state.seenExamples).length < 40 || /abroad|shop|museum|cache|ranked|item use|points/i.test(title)) && !/^(Crime|Forums|Message|Faction newsletter)/i.test(title)) state.seenExamples[title] = e;
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
          const end = title.match(/^Trade (cancel|expire|decline)/i), eid = end && tradeIdOf(e);
          if (eid) { state.tradeEnd = state.tradeEnd || {}; state.tradeEnd[eid] = { kind: end[1].toLowerCase() === 'cancel' ? 'cancelled' : end[1].toLowerCase() === 'expire' ? 'expired' : 'declined', ts: e.timestamp }; }
          return;
        }
        if (/^Item market (add|remove)$/i.test(title) && e.data) {
          state.listEvents = state.listEvents || {};
          const li = pickItems(e.data).map(i => ({ id: i.id, qty: i.qty }));
          if (li.length) state.listEvents[e.id] = { ts: e.timestamp, kind: /add/i.test(title) ? 'add' : 'remove', items: li };
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
        if (!tx.items.length) return;
        if (state.txs[tx.id]) { const ex = state.txs[tx.id]; if (tx.fee != null && ex.fee == null) { ex.fee = tx.fee; ex.each = tx.each; ex.anon = tx.anon; } return; } // fill in the new market details without touching the amount
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
      if (old && old.locked) { if (tx.dir && old.dir !== tx.dir && old.src === 'receipt' && /weav3r/.test(old.receiptUrl || '')) old.dir = tx.dir; return; } // the log decides whether you bought or sold; repairs trades a receipt had flipped
      if (!old) added++;
      state.txs[id] = tx;
    });
    added += rebuildSendTxs();
    // The log arrives newest-first, so if we stopped at the page cap, older entries were not read: keep the old cursor.
    if (!capped) { state.lastSync = newest; state.syncedAt = Math.floor(Date.now() / 1000); state.resume = null; }
    else state.resume = { from, to: curTo, newest };
    save(); verifySaved();
    if (capped) { const er = new Error('Imported part of your history (' + added + ' new). Tap Sync now again to continue.'); er.capped = true; er.added = added; throw er; }
    return added;
  }

  /* ===================== receipt handling ===================== */
  function attachReceipt(rc, tx) {
    const role = roleFor(rc, state.me);
    if (!role) throw new Error("Your name isn't the buyer or seller on this receipt.");
    tx.dir = role; tx.items = rc.items.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price }));
    if (tx.src === 'log' && tx.amount != null && tx.logAmount == null) tx.logAmount = tx.amount; // kept so the Weaver check can compare
    let total = rc.total;
    // A receipt line priced at $0 (no price known) makes the receipt total too low. The trade's real money is in the Torn log: keep that total and spread what the priced lines do not cover over the $0 lines.
    const zero = tx.items.filter(i => !(i.price > 0));
    if (zero.length && tx.logAmount != null && tx.logAmount > rc.total) {
      const known = tx.items.filter(i => i.price > 0).reduce((a, i) => a + i.price * i.qty, 0), rest = tx.logAmount - known;
      const mv = zero.map(i => i.qty * (itemValues[i.id] || 0)), useMv = mv.every(x => x > 0), wt = zero.map((i, k) => useMv ? mv[k] : i.qty), ws = wt.reduce((a, x) => a + x, 0);
      if (rest > 0 && ws > 0) { zero.forEach((i, k) => { i.price = Math.round(rest * (wt[k] / ws) / i.qty); }); total = tx.logAmount; tx.zeroFixed = true; }
    }
    tx.amount = total; tx.src = 'receipt'; tx.locked = true; tx.receiptUrl = rc.url;
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
  async function applyPawnHubBalance(rc) {
    await ensureItems();
    rebuildSendTxs();
    const byName = {}; Object.entries(itemNames).forEach(([id, n]) => { byName[String(n).toLowerCase()] = Number(id); });
    const idFor = e => e.itemId || byName[String(e.item).toLowerCase()];
    const hits = matchPawnHubEvents(rc.events, state.txs, byName);
    hits.forEach(({ txId, event }) => {
      const t = state.txs[txId];
      t.items[0].price = event.unit; t.amount = event.total; t.gift = false; t.src = 'receipt'; t.locked = true; t.receiptUrl = rc.url;
    });
    const itemEv = rc.events.filter(e => idFor(e));
    const earliest = itemEv.length ? Math.min.apply(null, itemEv.map(e => e.ts)) : null;
    if (earliest && (!state.pawnhubSince || earliest < state.pawnhubSince)) state.pawnhubSince = earliest;
    save();
    const olderCount = earliest ? Object.values(state.txs).filter(t => t.channel === 'send' && t.dir === 'sell' && t.amount == null && t.ts < earliest - PH_LAG).length : 0;
    const itemEvents = itemEv.length;
    const matched = new Set(hits.map(h => h.event));
    const sends1 = Object.values(state.txs).filter(t => t.channel === 'send' && t.dir === 'sell' && t.items && t.items.length === 1);
    const near = e => sends1.filter(t => t.items[0].id === idFor(e) && t.items[0].qty === e.qty).sort((a, b) => Math.abs(a.ts - e.ts) - Math.abs(b.ts - e.ts))[0];
    // An event whose send already carries the same value was applied earlier (or the page lists it twice): not a failure.
    const done = e => { const t = near(e); return !!t && t.src === 'receipt' && t.amount === e.total && phNear(t, e); };
    const rest = itemEv.filter(e => !matched.has(e) && !done(e));
    const already = itemEvents - hits.length - rest.length;
    let why = '';
    if (rest.length) {
      const miss = rest.slice(0, 3).map(e => { const t = near(e); return e.qty + '× ' + e.item + ' at ' + fdate(e.ts) + (t ? ' (nearest send with that item and quantity: ' + fdate(t.ts) + (t.src === 'receipt' ? ', already valued differently' : '') + ')' : ' (no send with that item and quantity)'); });
      why = ' You have ' + sends1.length + ' single-item sends. Unmatched examples: ' + miss.join('; ') + '.';
    }
    const roles = {}; itemEv.forEach(e => { roles[e.role] = (roles[e.role] || 0) + 1; });
    const dupEx = itemEv.filter(e => !matched.has(e) && done(e)).slice(0, 2).map(e => e.qty + '× ' + e.item + ' ' + fmt(e.total) + ' ' + e.role + ' at ' + fdate(e.ts) + ' = send at ' + fdate(near(e).ts));
    if (already) why += ' Roles on the page: ' + Object.entries(roles).map(([r, n]) => r + ' ' + n).join(', ') + '. Already-applied examples: ' + dupEx.join('; ') + '.';
    if (rc.halved) why += ' (The page listed every row twice, so each was counted once.)';
    return 'PawnHub balance: valued ' + hits.length + ' of ' + itemEvents + ' item events' + (already ? ', ' + already + ' more already had the same amount on your sends (from a receipt or an earlier Balance import)' : '') + (rest.length ? ', ' + rest.length + ' have no send with the same item, quantity and time (or the send is not in your log yet)' : '') + '. The Balance page starts ' + (earliest ? fdate(earliest) : '?') + (olderCount ? ', so ' + olderCount + ' older send(s) have no PawnHub entry (see Profit, needs a value).' : '.') + why;
  }
  // Weaver receipts through TornW3B's API (its own key, sent only to weav3r.dev): matched to your Torn trades by trade ID.
  function rcFromWeaverApi(r) {
    const tm = r && r.trade_id != null ? String(r.trade_id).match(/\d+/) : null; // some receipts have no usable Torn trade number
    if (!r || !tm || Number(tm[0]) < 10000000 || !Array.isArray(r.items) || !r.items.length) return null; // Torn trade numbers are 8 digits now; smaller numbers on old receipts are not trades
    const items = r.items.map(i => ({ id: Number(i.item_id), name: i.item_name, qty: Number(i.quantity), price: Number(i.price_used) }));
    if (items.some(i => !i.id || !i.qty || !(i.price >= 0))) return null;
    return { source: 'weaver', url: 'https://weav3r.dev/receipt/' + r.id, tradeId: Number(tm[0]), buyer: r.buyer_name, seller: state.me.name, sellerId: state.me.id,
      items, total: Number(r.total_value) || items.reduce((a, i) => a + i.price * i.qty, 0), ts: r.created_at || null };
  }
  async function w3bCall(url) {
    const r = await httpRetry(url, { 'X-API-Key': sget('w3bkey', ''), Accept: 'application/json' });
    if (r && r.status === 401) throw new Error('TornW3B did not accept your key (HTTP 401). Check it in Settings.');
    if (r && r.status === 429) throw new Error('TornW3B is limiting requests. Wait a minute and tap again.');
    if (!r || r.status >= 400) throw new Error('TornW3B answered HTTP ' + (r && r.status) + (r && r.status === 403 ? ' (access denied: the trades endpoint may need Premium)' : ''));
    try { return JSON.parse(r.text); } catch (e) { throw new Error('TornW3B sent something I could not read.'); }
  }
  // A read-only health check of the Weaver import: is the API answering, does what it lists match your trades, do the amounts agree with your log.
  async function weaverAudit() {
    if (!sget('w3bkey', '')) throw new Error('Add your TornW3B key in Settings first.');
    await ensureMe();
    const base = 'https://weav3r.dev/api/trades/' + state.me.id, w = state.w3b || { done: {} };
    const lines = [];
    const list = await w3bCall(base), rows = (list.trades || []).filter(t => t && t.id);
    lines.push('API: answering, key accepted · ' + rows.length + ' receipts in the newest page' + (rows.length >= 100 ? ' (there are more)' : '') + '.');
    const attached = rows.filter(t => w.done && w.done[t.id]).length;
    lines.push('Of those, ' + attached + ' are already in your data.' + (rows.length - attached ? ' ' + (rows.length - attached) + ' are not: they were cancelled/expired trades, have no Torn trade number, or are waiting for their trade to reach your log.' : ''));
    if (rows[0]) {
      try {
        await sleep(900); const r = await w3bCall(base + '/' + encodeURIComponent(rows[0].id));
        lines.push('Newest receipt (compare with the website): trade #' + r.trade_id + ' with ' + (r.buyer_name || '?') + ', ' + (r.items || []).map(i => i.quantity + '× ' + i.item_name + ' @ ' + fmt(i.price_used)).join(', ') + ', total ' + fmt(r.total_value) + (r.created_at ? ', ' + fdate(r.created_at) : '') + '.');
      } catch (e) { lines.push('Could not read the newest receipt: ' + String(e.message || e)); }
    }
    { const d = state.lastSyncDetail && state.lastSyncDetail.weaver, m = d && d.match(/not found in your log \((.*)\)\. TornW3B lists/); if (m) lines.push('Waiting for their trade (from the last sync): ' + m[1].slice(0, 600)); }
    const since = Math.floor(Date.now() / 1000) - 14 * 86400;
    const trades = Object.values(state.txs).filter(t => t.channel === 'trade' && t.tradeId && t.ts >= since && !t.id.startsWith('rc:'));
    const withW = trades.filter(t => t.receiptUrl && /weav3r\.dev/.test(t.receiptUrl)), without = trades.filter(t => !t.receiptUrl).sort((a, b) => b.ts - a.ts);
    lines.push('Your trades in the last 14 days: ' + trades.length + ' · ' + withW.length + ' with a Weaver receipt · ' + without.length + ' with no receipt' + (without.length ? ' (newest: ' + without.slice(0, 3).map(t => '#' + t.tradeId + ' ' + fdate(t.ts)).join(', ') + '). Those may not have been made through Weaver, or the receipt is not on TornW3B yet' : '') + '.');
    const cmp = withW.filter(t => t.logAmount != null);
    const off = cmp.filter(t => Math.abs(t.amount - t.logAmount) > Math.max(1, t.logAmount * 0.01));
    lines.push(cmp.length ? 'Amounts: ' + cmp.length + ' receipts checked against your Torn log, ' + (off.length ? off.length + ' differ by more than 1% (' + off.slice(0, 3).map(t => '#' + t.tradeId + ': log ' + fmt(t.logAmount) + ' vs receipt ' + fmt(t.amount)).join('; ') + '). The receipt amount is the one used.' : 'all agree within 1%.') : 'Amounts: no cross-check yet. Receipts attached from now on keep your log amount for comparison.');
    return lines;
  }
  // A plain-language reconciliation of the profit number for the range on the Profit tab, so it can be checked by hand.
  function snapshotProfit() {
    const res = computeFlips(state.txs, flipOpts()), now = Math.floor(Date.now() / 1000), sum = since => res.flips.filter(f => f.profit != null && f.tx.ts >= since).reduce((a, f) => a + f.profit, 0);
    state.profitLog = (state.profitLog || []).concat([{ at: now, v: VERSION, d7: Math.round(sum(now - 7 * 86400)), d30: Math.round(sum(now - 30 * 86400)), all: Math.round(sum(0)), n: Object.keys(state.txs).length }]).slice(-40);
  }
  function profitAudit() {
    const [lo, hi] = rangeBounds(), res = computeFlips(state.txs, flipOpts()), inR = ts => ts >= lo && ts < hi;
    const flips = res.flips.filter(f => inR(f.tx.ts)), done = flips.filter(f => f.profit != null), skipped = flips.filter(f => f.profit == null);
    const lines = done.reduce((a, f) => a.concat(f.lines.filter(l => l.matched > 0)), []);
    const rev = lines.reduce((a, l) => a + l.proceeds, 0), cost = lines.reduce((a, l) => a + (l.cost || 0), 0), profit = done.reduce((a, f) => a + f.profit, 0);
    const label = { today: 'Today', yesterday: 'Yesterday', custom: (ui.from || '?') + ' to ' + (ui.to || ui.from || '?'), 0: 'All time' }[ui.range] || 'Last ' + ui.range + ' day(s)';
    const out = [label + ': profit ' + fmt(profit) + ' = sold for ' + fmt(rev) + ' − cost ' + fmt(cost) + ' over ' + done.length + ' sales' + (cost > 0 ? ' (' + (profit / cost * 100).toFixed(2) + '% on cost)' : '') + '. Check: ' + fmt(rev) + ' − ' + fmt(cost) + ' = ' + fmt(rev - cost) + '.'];
    const src = { receipt: 0, log: 0, manual: 0 }; done.forEach(f => { src[f.tx.src] = (src[f.tx.src] || 0) + 1; });
    out.push('Sale amounts come from: receipts ' + (src.receipt || 0) + ', Torn log ' + (src.log || 0) + ', entered by hand ' + (src.manual || 0) + '.');
    const pend = res.pending.filter(t => t.dir === 'sell' && inR(t.ts));
    out.push('Left out of the total: ' + skipped.length + ' sale(s) with no earlier buy (' + fmt(skipped.reduce((a, f) => a + (netAmt(f.tx) || 0), 0)) + ' received) and ' + pend.length + ' send(s)/sale(s) with no amount yet.');
    const byP = done.slice().sort((a, b) => b.profit - a.profit), show = f => fmt(f.profit) + ' · ' + fdate(f.tx.ts) + (f.tx.tradeId ? ' #' + f.tx.tradeId : '') + ' · ' + f.tx.items.slice(0, 2).map(i => i.qty + '× ' + (i.name || nameOf(i.id))).join(', ');
    if (byP.length) out.push('Biggest gains: ' + byP.slice(0, 3).map(show).join(' | '));
    const neg = byP.filter(f => f.profit < 0).slice(-3).reverse();
    if (neg.length) out.push('Losses to look at: ' + neg.map(show).join(' | '));
    const zf = Object.values(state.txs).filter(t => t.zeroFixed && state.receipts[t.receiptUrl]);
    if (zf.length) { const eff = zf.reduce((a, t) => a + (t.dir === 'sell' ? 1 : -1) * (t.amount - state.receipts[t.receiptUrl].total), 0); out.push(zf.length + ' receipt(s) had $0-priced lines and use your Torn log money instead (net effect on profit about ' + fmt(eff) + ', mostly raising buy costs).'); }
    const pl = state.profitLog || [];
    if (pl.length) out.push('Earlier readings (30 days): ' + pl.slice(-4).map(r => fdate(r.at) + ' v' + r.v.replace('-beta', '') + ' ' + fmt(r.d30)).join(' · ') + '. A jump between versions points at a calculation change, not your trading.');
    out.push('To verify one sale: open its category row and tap ✎ (sold for and cost), or use the "history" link of an item under "not counted" to see every buy and sale of it.');
    return out;
  }
  async function weaverImport() {
    const key = sget('w3bkey', '');
    if (!key) throw new Error('Add your TornW3B key in Settings first.');
    await ensureMe();
    const base = 'https://weav3r.dev/api/trades/' + state.me.id;
    const call = w3bCall;
    const w = state.w3b = state.w3b || { done: {}, miss: {}, at: {} };
    w.at = w.at || {}; w.re = w.re || {};
    const now = Math.floor(Date.now() / 1000);
    let budget = 40, attached = 0, missing = 0, ended = 0, left = 0, pages = 0, to = null, listed = 0, already = 0, newest = 0, noId = 0;
    const reread = [];
    const lost = [];
    const seen = new Set();
    const fullScan = now - (w.fullAt || 0) > 6 * 3600; // newest-first list: a page that is entirely done means everything older is done too, so skip the rest except in an occasional full scan
    try {
      // The list holds 100 receipts, newest first; step back through older pages using the oldest receipt's time.
      while (pages++ < 30) {
        const list = ((await call(base + (to ? '?to=' + to : ''))).trades || []).filter(t => t && t.id && !seen.has(t.id));
        if (!list.length) break;
        const pageDone = list.filter(t => w.done[t.id]).length;
        list.forEach(t => { seen.add(t.id); listed++; if (w.done[t.id]) already++; if (t.created_at && t.created_at > newest) newest = t.created_at; });
        for (const t of list) {
          if (w.done[t.id] || w.miss[t.id] > now - 20 * 60) continue;
          if (budget <= 0) { left++; continue; }
          budget--; await sleep(900);
          const r = await call(base + '/' + encodeURIComponent(t.id));
          if (r && r.created_at) w.at[t.id] = r.created_at;
          const rc = rcFromWeaverApi(r);
          const tx = rc && Object.values(state.txs).find(x => x.tradeId && String(x.tradeId) === String(rc.tradeId));
          // your log says whether you bought or sold; the receipt only names the other player
          if (tx) { if (tx.dir) rc.role = tx.dir; attachReceipt(rc, tx); w.done[t.id] = 1; attached++; }
          else if (rc && state.tradeEnd && state.tradeEnd[rc.tradeId]) { w.done[t.id] = 1; ended++; }
          else if (!rc) { w.done[t.id] = 1; noId++; } // nothing to match it with: no Torn trade number or no item prices
          else { w.miss[t.id] = now; missing++; if (rc.ts && rc.ts > now - 14 * 86400 && !w.re[t.id]) reread.push({ id: t.id, ts: rc.ts }); if (lost.length < 5) lost.push(rc ? 'trade ' + rc.tradeId + ' with ' + rc.buyer + ', ' + fmt(rc.total) + (rc.ts ? ' at ' + fdate(rc.ts) : '') + (() => { const tp = state.tradeParts && state.tradeParts[rc.tradeId]; return tp ? ' [log has: ' + Object.values(tp.parts || {}).map(p => p.title).join(', ') + ']' : ' [no log entry with this trade ID]'; })() : 'receipt ' + t.id + ' (unreadable)'); }
        }
        if (list.length < 100) break;
        if (pageDone === list.length && !fullScan) break;
        const last = list[list.length - 1];
        if (!w.at[last.id]) { await sleep(900); const r = await call(base + '/' + encodeURIComponent(last.id)); if (r && r.created_at) w.at[last.id] = r.created_at; }
        if (!w.at[last.id] || w.at[last.id] === to) break;
        to = w.at[last.id];
        await sleep(900);
      }
    } finally { if (fullScan && pages > 1) w.fullAt = now; save(); }
    const text = 'Weaver: ' + attached + ' receipt(s) attached' + (ended ? ', ' + ended + ' skipped (their trades were cancelled, expired or declined)' : '') + (noId ? ', ' + noId + ' ignored (no Torn trade number or no prices)' : '') + (missing ? ', ' + missing + ' not found in your log (' + lost.join('; ') + ')' : '') + (left ? ', ' + left + ' more waiting: tap again' : '') + (!attached && !missing && !left ? ' (nothing new)' : '') + '. TornW3B lists ' + listed + ' receipt(s)' + (newest ? ', newest ' + fdate(newest) : '') + '; ' + already + ' already attached.';
    return { text, attached, left, ended, missing, reread };
  }
  async function handleReceipt(rc) {
    if (rc.source === 'pawnhub-balance') {
      let full = await applyPawnHubBalance(rc), none = Number((full.match(/(\d+) have no send/) || [])[1] || 0);
      // The newest payments can be for sends your data does not hold yet: read the log first, then match again (once).
      if (none && getKey() && !ui.busy && Date.now() / 1000 - (state.syncedAt || 0) > 90) {
        try { await readLogFully(); full = await applyPawnHubBalance(rc); none = Number((full.match(/(\d+) have no send/) || [])[1] || 0); } catch (e) { /* keep the first result */ }
      }
      state.lastInboxDetail = full.slice(0, 1500);
      const g = re => Number((full.match(re) || [])[1] || 0);
      return 'PawnHub: ' + g(/valued (\d+) of/) + ' payments matched · ' + g(/, (\d+) more already/) + ' already had a value' + (none ? ' · ' + none + ' not matched yet (the send may not be in your log)' : '');
    }
    await ensureMe();
    if (rc.source === 'pawnhub') await resolvePawnHub(rc);
    if (!roleFor(rc, state.me)) throw new Error("Your name (" + state.me.name + ") isn't the buyer or seller on this receipt.");
    const cands = rankCandidates(rc, state.txs);
    const best = cands[0], second = cands[1];
    // Same items and quantities, close in time and nothing else comparable: that is the trade (TornExchange receipts carry no trade number).
    const sure = best && (best.score >= 6 || (best.score >= 5 && itemKey(best.tx.items) === itemKey(rc.items)));
    if (sure && (!second || best.score - second.score >= 2)) {
      attachReceipt(rc, best.tx); ui.pendingReceipt = null; ui.candidates = [];
      return 'Receipt attached to a matching trade.';
    }
    ui.pendingReceipt = rc; ui.candidates = cands;
    return cands.length ? 'Pick which trade this receipt belongs to.' : 'No matching trade found in your log.';
  }
  // Reads the PawnHub Balance page without you visiting it: directly if the site allows, else in a hidden frame (your own browser session, same as opening it).
  async function readPawnHubBalance() {
    let rc;
    try { rc = await fetchReceipt('https://z0cl.eu/PawnHub/balance.php'); }
    catch (e) { state.lastSyncDetail = Object.assign({}, state.lastSyncDetail, { pawnhubErr: e.detail || e.message }); { const why = String(e.detail || '').split('frame: ')[1] || ''; throw new Error('Could not read the PawnHub Balance page in the background' + (why ? ': ' + why : '') + '. Open it in a tab instead.'); } }
    if (!rc || rc.source !== 'pawnhub-balance') throw new Error('That did not look like the Balance page (are you logged in to PawnHub?).');
    const msg = await applyPawnHubBalance(rc);
    sset('pawnhubAuto', true);
    const m = msg.match(/valued (\d+)/);
    return { text: msg, valued: m ? Number(m[1]) : 0 };
  }
  // PawnHub's own API (key = the Torn key you log in to PawnHub with; sent only to z0cl.eu): the same payments as the Balance page, with item ids and exact times.
  async function readPawnHubApi() {
    const key = sget('phkey', ''); if (!key) throw new Error('Add your PawnHub key in Settings first.');
    const clean = t => String(t == null ? '' : t).split(key).join('***');
    // PawnHub returns 100 payments per page, newest first, with a cursor (pagination.next_before_id). Keep paging until we are past your oldest send that still has no value.
    const base = 'https://z0cl.eu/PawnHub/api.php?selections=balance_events&key=' + encodeURIComponent(key);
    // Only sends with no value at all need payments. After the first read, look back 3 days at most: older sends that PawnHub could value were valued then, and paging through months of history on every Sync is slow.
    const unvalued = Object.values(state.txs).filter(t => t.channel === 'send' && t.dir === 'sell' && t.items && t.items.length === 1 && t.amount == null).map(t => t.ts);
    const horizon = state.phFirstDone ? Math.floor(Date.now() / 1000) - 3 * 86400 : 0;
    const needTs = unvalued.length ? Math.max(Math.min.apply(null, unvalued) - PH_LAG, horizon) : Infinity;
    const tsOf = e => Date.parse(String(e.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')) / 1000;
    let evs = [], beforeId = null, pages = 0, firstJ = null, stop = 'end'; const seen = new Set();
    for (;;) {
      let r;
      try { r = await httpRetry(base + (beforeId ? '&before_id=' + encodeURIComponent(beforeId) : ''), { Accept: 'application/json' }); }
      catch (e) { throw new Error('Could not reach PawnHub: ' + clean(e && e.message).slice(0, 100)); }
      let j; try { j = JSON.parse(r.text); } catch (e) { throw new Error('PawnHub did not return data (HTTP ' + (r && r.status) + '). Check the key in Settings.'); }
      if (j && j.error) throw new Error('PawnHub: ' + clean(typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error))).slice(0, 100));
      const page = j && j.balance_events && j.balance_events.events;
      if (!Array.isArray(page)) throw new Error('PawnHub answered, but without payment rows. Check the key in Settings.');
      if (!firstJ) firstJ = j;
      pages++;
      const fresh = page.filter(e => !seen.has(e.id)); fresh.forEach(e => seen.add(e.id)); evs = evs.concat(fresh);
      const pg = j.balance_events.pagination || {}, times = page.map(tsOf).filter(isFinite), oldest = times.length ? Math.min.apply(null, times) : Infinity;
      if (!fresh.length) { stop = pages > 1 ? 'before_id ignored' : 'empty'; break; }
      if (!pg.has_more || !pg.next_before_id) { stop = 'end'; break; }
      if (oldest <= needTs) { stop = 'far enough'; break; }
      if (pages >= 15) { stop = 'page limit'; break; }
      beforeId = pg.next_before_id; await sleep(700);
    }
    state.phApiSample = { keys: Object.keys(firstJ || {}), eventKeys: Object.keys((firstJ || {}).balance_events || {}), pages, rows: evs.length, stop, pagination: JSON.stringify(((firstJ || {}).balance_events || {}).pagination === undefined ? null : firstJ.balance_events.pagination).slice(0, 300) };
    const events = evs.filter(e => Number(e.item_id) > 0 && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(String(e.created_at || ''))).map(e => ({ id: e.id, ts: Date.parse(String(e.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')) / 1000, itemId: Number(e.item_id), item: e.item_name, role: e.member_role, qty: Number(e.quantity), unit: Number(e.unit_price), total: Number(e.total_value) })).filter(e => e.qty > 0 && isFinite(e.unit) && isFinite(e.total) && isFinite(e.ts));
    if (!events.length) return { text: 'PawnHub: no item payments in the reply.', valued: 0 };
    const rc = { source: 'pawnhub-balance', url: 'https://z0cl.eu/PawnHub/balance.php', events, total: events.reduce((a, e) => a + e.total, 0) };
    if (!state.phFirstDone) { // the first read can change a lot of old values: show what it would do and wait for a tap
      await ensureItems(); rebuildSendTxs();
      const byName = {}; Object.entries(itemNames).forEach(([id, n]) => { byName[String(n).toLowerCase()] = Number(id); });
      const hits = matchPawnHubEvents(events, state.txs, byName), ts = hits.map(h => state.txs[h.txId].ts);
      if (!hits.length) { // nothing new to fill in (for example the Balance page already valued these sends): no need to ask
        const msg = await applyPawnHubBalance(rc); state.phFirstDone = true; state.phAt = Math.floor(Date.now() / 1000); save();
        return { text: 'PawnHub: read ' + events.length + ' item payments (' + state.phApiSample.pages + ' page' + (state.phApiSample.pages === 1 ? '' : 's') + '). Nothing new to fill in. ' + msg.replace('PawnHub balance: ', '').replace('The Balance page starts', "PawnHub's list starts"), valued: 0, short: events.length + ' PawnHub payments read, nothing new to fill in' };
      }
      ui.phPreview = { rc, read: events.length, n: hits.length, total: hits.reduce((a, h) => a + h.event.total, 0), from: ts.length ? Math.min.apply(null, ts) : null, to: ts.length ? Math.max.apply(null, ts) : null, manual: hits.filter(h => state.txs[h.txId].src === 'manual').length, loose: events.length - hits.length };
      return { text: hits.length ? 'PawnHub: ' + hits.length + ' sends ready to fill in. Check the box at the top and tap Apply.' : 'PawnHub: no sends match its payments yet.', valued: 0, preview: true };
    }
    const msg = await applyPawnHubBalance(rc);
    state.phAt = Math.floor(Date.now() / 1000); save();
    const m = msg.match(/valued (\d+)/);
    return { text: msg.replace('The Balance page starts', "PawnHub's list starts"), valued: m ? Number(m[1]) : 0 };
  }
  async function addReceiptInput(text) {
    text = (text || '').trim();
    if (!text) throw new Error('Paste a receipt link first.');
    if (text[0] === '{') return handleReceipt(JSON.parse(text));
    const links = text.split(/\s+/).filter(t => /^https?:\/\//i.test(t));
    if (!links.length) throw new Error('Paste a receipt link or copied receipt data.');
    let attached = 0, review = 0, failed = [], notes = [], rest = links;
    ui.failedLinks = [];
    // With a TornW3B key, Weaver links need no page load (which Cloudflare often blocks): the API gives every receipt, this one included.
    const wl = links.filter(u => /weav3r\.dev\/receipt\//i.test(u));
    if (wl.length && sget('w3bkey', '')) {
      try {
        const r = await weaverImport();
        notes.push(r.attached ? r.attached + ' Weaver receipt' + (r.attached === 1 ? '' : 's') + ' attached.' : r.missing ? 'Weaver receipt found, but its trade is not in your log yet. Sync, then try again.' : 'Weaver receipts are up to date.');
        rest = links.filter(u => !wl.includes(u));
        if (!rest.length) return notes.join(' ');
      } catch (e) { /* fall back to loading the links themselves */ }
    }
    for (const url of rest) {
      try {
        const rc = await fetchReceipt(url);
        const msg = await handleReceipt(rc);
        if (rc.source === 'pawnhub-balance') { notes.push(msg); continue; }
        if (/attached/i.test(msg)) attached++; else review++;
      } catch (e) { failed.push(url + ' (' + (e.message || e) + ')'); ui.failedLinks.push(url); }
    }
    const pre = notes.length ? notes.join(' ') + ' ' : '';
    if (notes.length && !failed.length && !attached && !review) return notes.join(' ');
    if (rest.length === 1 && !failed.length) return pre + (review ? 'Pick which trade this receipt belongs to.' : 'Receipt attached to a matching trade.');
    if (rest.length === 1) throw new Error(pre + failed[0].replace(/^\S+ \(/, '').replace(/\)$/, '') + ' Open it in a tab: it saves itself, then come back here.');
    return pre + attached + ' attached' + (review ? ', ' + review + ' need you to pick a trade (shown below)' : '') + (failed.length ? ', ' + failed.length + ' could not be read' : '') + '.';
  }

  /* ===================== UI ===================== */
  const CSS = `
  #tfp-btn{z-index:2147483646;cursor:pointer;font-size:16px;line-height:1;padding:3px 7px;border-radius:8px;border:1px solid #555;background:#2b2b2b;color:#fff}
  #tfp-btn{position:absolute;touch-action:none;-webkit-user-select:none;user-select:none;font:700 12px Arial;white-space:nowrap}
  #tfp-btn.up{color:#6fcf6f;background:#1f2a1f;border-color:#3f7a3f}#tfp-btn.dn{color:#ef6f6f;background:#2a1f1f;border-color:#7a3f3f}#tfp-btn.zero{color:#9aa0ab}
  #tfp-btn.att:after{content:"";position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;background:#ffb74d;border:1px solid #181818}
  #tfp-btn.hdr{position:relative;margin:0 6px;align-self:center;display:inline-block}
  #tfp-wrap.pda{padding-bottom:0}
  #tfp-wrap.pda #tfp-card{max-height:100%}
  #tfp-wrap{position:fixed;inset:0;z-index:2147483647;background:#1e1e1e;display:none;align-items:stretch;justify-content:center}
  #tfp-wrap.open{display:flex}
  #tfp-card{background:#1e1e1e;color:#ddd;width:100%;max-width:560px;height:100%;display:flex;flex-direction:column;position:relative;overflow:hidden;padding:0;font:13px/1.4 Arial,sans-serif;box-sizing:border-box}
  .tfp-hd{flex:none;display:flex;justify-content:space-between;align-items:center;padding:10px 12px 6px}
  .tfp-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 12px 80px}
  .tfp-nav{flex:none;display:flex;border-top:1px solid #333;background:#171717;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
  .tfp-nav button{flex:1;background:none;border:0;color:#999;font-size:11px;padding:4px 0;cursor:pointer}
  .tfp-nav button.on{color:#6fa3ff}.tfp-nav i{display:block;font-style:normal;font-size:19px;position:relative}
  .tfp-bdg{position:absolute;top:-4px;margin-left:2px;background:#e8b64a;color:#222;font:700 9px Arial;border-radius:999px;padding:1px 5px}
  .tfp-fab{position:absolute;right:14px;bottom:calc(64px + env(safe-area-inset-bottom));background:#3b6fd1;color:#fff;border:0;border-radius:999px;padding:10px 16px;font-weight:700;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.5);cursor:pointer;z-index:3}
  .tfp-rng{display:flex;gap:6px;overflow-x:auto;padding:4px 0 8px}
  .tfp-rc{white-space:nowrap;border:1px solid #444;background:#2a2a2a;color:#aaa;border-radius:999px;padding:5px 11px;font-size:12.5px;cursor:pointer}
  .tfp-rc.on{background:#3b6fd1;border-color:#3b6fd1;color:#fff}
  .tfp-hsync{display:none}
  #tfp-card.tfp-setup .tfp-hd{flex:none}
  .tfp-wiz{padding:8px 16px 16px}.tfp-wt{margin:4px 0 6px;font-size:18px}
  .tfp-dots{display:flex;gap:6px;margin:6px 0 12px}.tfp-dots i{height:5px;flex:1;border-radius:3px;background:#34383f}.tfp-dots i.on{background:#4d8dff}
  .tfp-opt{display:block;border:1px solid #3a3f49;background:#242830;border-radius:12px;padding:11px 12px;margin:8px 0;color:inherit!important;text-decoration:none}
  .tfp-opt b{display:block;font-size:14px}.tfp-opt span{font-size:12px;color:#99a}
  a.tfp-opt.sel{border-color:#4d8dff;background:#1f2a40}
  .tfp-wfoot{flex:none;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #333}
  .tfp-pri{background:#3b6fd1!important;border-color:#3b6fd1!important;font-weight:700}.tfp-b[disabled]{opacity:.4}
  .tfp-hsync,.tfp-prow{}
  .tfp-prow{display:flex;justify-content:space-between;align-items:flex-end}
  .tfp-day{display:flex;justify-content:space-between;padding:12px 0 4px;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:#999}
  .tfp-day b{font-size:12px}
  a.tfp-tl{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid #333;color:inherit!important;text-decoration:none}
  .tfp-tl .tm{width:42px;color:#999;font-size:12px;padding-top:2px;flex:none}.tfp-tl .gr{flex:1;min-width:0}.tfp-tl .tt{font-weight:600}
  .tfp-amt{text-align:right;white-space:nowrap;font-weight:600}
  .tfp-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;margin-right:6px;font-weight:400;background:#2b3140;color:#aeb7ca}
  .tfp-tag.trade{background:#2a3b57;color:#9cc1ff}.tfp-tag.market{background:#2c3f35;color:#9fe0bb}.tfp-tag.sent{background:#4a3b24;color:#f0cf8a}
  .tfp-det{margin:0 0 6px 52px;padding:8px 10px;background:#151515;border-radius:8px;font-size:13px}
  .tfp-dl{display:flex;justify-content:space-between;gap:10px;padding:2px 0}.tfp-dl span:last-child{color:#aaa;text-align:right}
  .tfp-dl.sep{border-top:1px solid #2e2e2e;margin-top:4px;padding-top:5px}
  .tfp-hdr{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.04em;margin:6px 0 2px}
  a.tfp-more{display:block;text-align:center;padding:12px;border-top:1px solid #333}
  .tfp-graph{margin:6px 0 2px;display:block;touch-action:pan-y}
  @media (min-width:820px){
    #tfp-card.tfp-setup{max-width:560px;height:auto;max-height:92vh;min-height:440px}
    .tfp-wfoot{order:3}
    #tfp-wrap{background:rgba(0,0,0,.62);align-items:center}
    #tfp-card{max-width:1040px;height:min(92vh,900px);border-radius:14px;border:1px solid #3a3a3a;font-size:14px;box-shadow:0 12px 40px rgba(0,0,0,.6)}
    .tfp-nav{order:1;border-top:0;border-bottom:1px solid #333;padding:0 16px;gap:4px}
    .tfp-nav button{flex:none;display:flex;gap:7px;align-items:center;padding:10px 16px;font-size:13.5px;border-bottom:2px solid transparent}
    .tfp-nav button.on{border-bottom-color:#6fa3ff}
    .tfp-nav i{display:inline;font-size:16px}.tfp-bdg{position:static;margin-left:6px}
    .tfp-body{order:2;padding:14px 24px 80px}
    .tfp-hd{padding:12px 24px 6px}
    .tfp-fab{display:none}.tfp-hsync{display:inline-block!important;background:#3b6fd1!important;border-color:#3b6fd1!important}
    .tfp-two{display:grid;grid-template-columns:minmax(320px,380px) 1fr;gap:28px;align-items:start}
    .tfp-colL{position:sticky;top:0}
    .tfp-big{font-size:34px}
    a.tfp-tl:hover,a.tfp-ir:hover,a.tfp-more:hover{background:#262626}.tfp-rc:not(.on):hover{background:#333}.tfp-b:not(.tfp-hsync):hover{background:#383838}
    .tfp-det{margin-left:52px}
  }.tfp-axis{display:flex;justify-content:space-between;color:#999;font-size:11px}
  .tfp-seg{display:flex;background:#262626;border-radius:10px;padding:3px;margin:8px 0}.tfp-seg span{flex:1;text-align:center;padding:6px 0;border-radius:8px;color:#999;font-size:12.5px;cursor:pointer}.tfp-seg span.on{background:#3a4152;color:#eee}
  a.tfp-ir,div.tfp-ir{display:block;padding:9px 0;border-top:1px solid #333;color:inherit!important;text-decoration:none}
  .tfp-bar{height:8px;background:#2b303b;border-radius:6px;margin-top:6px;overflow:hidden}.tfp-bar i{display:block;height:100%;border-radius:6px}
  #tfp-card *{box-sizing:border-box}
  .tfp-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .tfp-tabs{display:flex;gap:6px;margin-bottom:10px;overflow-x:auto}
  .tfp-tabs .tfp-tab{flex:1;white-space:nowrap;padding:8px 6px;text-align:center}
  .tfp-tab,.tfp-b{background:#2d2d2d;color:#eee;border:1px solid #444;border-radius:10px;padding:8px 12px;cursor:pointer;font-size:13px}
  .tfp-tab.on{background:#3b6fd1!important;border-color:#3b6fd1!important}
  .tfp-row{border-top:1px solid #333;padding:8px 0}
  .tfp-top{display:flex;justify-content:space-between;gap:8px}
  .tfp-sub{color:#999;font-size:12px;margin-top:2px}
  .tfp-line{display:flex;justify-content:space-between;color:#bbb;font-size:12px;padding:2px 0 0 10px}
  .tfp-pos{color:#6fcf6f}.tfp-neg{color:#ef6f6f}.tfp-warn{color:#e8b64a}
  .tfp-in,.tfp-ta{background:#111;color:#eee;border:1px solid #555;border-radius:6px;padding:6px;width:100%;font-size:13px}
  .tfp-ta{min-height:70px}
  .tfp-msg{background:#2a2a2a;border-radius:8px;padding:8px;margin:6px 0}
  .tfp-gap{height:6px}
  .tfp-big{font-size:28px;font-weight:700;line-height:1.1}
  .tfp-stats{display:flex;gap:8px;margin:8px 0}
  .tfp-stat{flex:1;background:#262626;border-radius:10px;padding:8px 10px}
  .tfp-stat b{display:block;font-size:14px;color:#eee}
  .tfp-stat span{font-size:11px;color:#999}
  .tfp-chips{display:flex;gap:8px;margin:8px 0}
  .tfp-chip{flex:1;background:#33290f;border:1px solid #6b5420;border-radius:10px;padding:8px 10px;color:#e8b64a;text-decoration:none}
  .tfp-chip b{display:block;font-size:16px}
  .tfp-chip span{font-size:11px}
  #tfp-card a.tfp-chip{color:#e8b64a}
  .tfp-cat{background:#262626;border-radius:10px;margin:8px 0;padding:10px 12px}
  .tfp-cat .tfp-top{align-items:center}
  .tfp-cat-h{display:block;color:#eee!important;text-decoration:none}
  .tfp-cat-h b{font-size:15px}
  .tfp-chev{display:inline-block;width:14px;color:#888}
  .tfp-cat .tfp-sub{padding-left:14px}
  .tfp-note{font-size:11px;color:#8a7a4a;margin:6px 0}
  #tfp-card .tfp-note a{color:#a8935a}
  a.tfp-trow{display:block;color:inherit!important;text-decoration:none;padding:8px 0;border-top:1px solid #333}
  .tfp-foot{color:#777;font-size:11px;margin-top:10px}
  .tfp-sel{width:auto;padding:4px}
  .tfp-ctl{display:flex;gap:6px;align-items:center}
  #tfp-card a{color:#7fb0ff}
  .tfp-disc{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
  .tfp-disc td{border:1px solid #444;padding:4px;vertical-align:top}
  .tfp-disc td:first-child{color:#999;white-space:nowrap;padding-right:10px}
  #tfp-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;background:#222;color:#fff;border:1px solid #555;border-radius:8px;padding:8px 12px;font:13px Arial}
  `;
  const badge = tx => tx.src === 'receipt' ? '🧾' : tx.src === 'log' ? '📒' : tx.src === 'manual' ? '✍️' : '⚠️';
  // All times are shown in Torn City Time (TCT, the same as UTC) so they match the game logs and PawnHub.
  const fdate = ts => { const d = new Date(ts * 1000); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' TCT'; };
  const itemSummary = tx => tx.items.slice(0, 5).map(i => i.qty + '× ' + esc(i.name || nameOf(i.id))).join(', ') + (tx.items.length > 5 ? ' + ' + (tx.items.length - 5) + ' more' : '') + (tx.count > 1 ? ' · ' + tx.count + ' sends' : '');
  const tradeTag = tx => tx.tradeId ? ' · #' + tx.tradeId : '';
  const chanLabel = c => ({ market: 'Market', bazaar: 'Bazaar', trade: 'Trade', send: 'Send', recv: 'Received', abroad: 'Abroad', shop: 'Shop' }[c] || c);

  // Profit ranges are in TCT (UTC) days, like the log. Presets, single days and a from-to range.
  const dayStr = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  const dayTs = str => /^\d{4}-\d{2}-\d{2}$/.test(str || '') ? Date.parse(str + 'T00:00:00Z') / 1000 : null;
  function rangeBounds() {
    const now = Date.now() / 1000, today = Math.floor(now / 86400) * 86400, r = ui.range;
    if (r === 'today') return [today, Infinity];
    if (r === 'yesterday') return [today - 86400, today];
    if (r === 'custom') { const lo = dayTs(ui.from) != null ? dayTs(ui.from) : today, hi = dayTs(ui.to) != null ? dayTs(ui.to) : lo; return [Math.min(lo, hi), Math.max(lo, hi) + 86400]; }
    return [r ? now - r * 86400 : 0, Infinity];
  }
  const rangeChips = () => `<div class="tfp-rng">${[['today', 'Today'], ['yesterday', 'Yesterday'], [7, '7d'], [30, '30d'], [0, 'All'], ['custom', '📅 Pick']].map(r => `<span class="tfp-rc${ui.range === r[0] ? ' on' : ''}" data-act="rangeset" data-v="${r[0]}">${r[1]}</span>`).join('')}</div>`;
  const rangeDates = () => ui.range === 'custom' ? `<div class="tfp-ctl" style="margin:6px 0"><span class="tfp-sub">From</span><input type="date" class="tfp-in tfp-sel" data-act="rangefrom" value="${esc(ui.from || dayStr(Date.now() / 1000))}"><span class="tfp-sub">to</span><input type="date" class="tfp-in tfp-sel" data-act="rangeto" value="${esc(ui.to || ui.from || dayStr(Date.now() / 1000))}"></div>` : '';
  const pnlCls = n => n == null ? 'tfp-warn' : n >= 0 ? 'tfp-pos' : 'tfp-neg';
  const link = (key, label) => `<a href="#" data-act="toggle" data-v="${key}">${ui[key] ? '▾' : '▸'} ${label}</a>`;
  // The log the API gives us may reach back less far than the selected range: say where the data really starts.
  function historyNote() {
    const ts = Object.values(state.txs).map(t => t.ts).filter(Number);
    if (!ts.length) return '';
    const first = Math.min.apply(null, ts), days = (Date.now() / 1000 - first) / 86400;
    return 'History from ' + fdate(first) + ' (' + (days < 1 ? 'under a day' : Math.round(days) + ' days') + ')' + (typeof ui.range === 'number' && ui.range && days < ui.range ? ' · longer ranges show the same numbers' : '');
  }
  // For a sale with units that found no earlier buy: what the data holds for that item, so the gap can be explained.
  function itemTrail(f, l) {
    const id = String(l.itemId), ts = f.tx.ts;
    let bought = 0, last = null, gifts = 0, usedBefore = 0; const both = [];
    Object.values(state.txs).forEach(t => {
      if (!t.items || t.id === f.tx.id) return;
      const q = t.items.filter(i => String(i.id) === id).reduce((a, i) => a + i.qty, 0);
      if (!q) return;
      if (t.dir === 'buy' && t.ts <= ts) { if (isGift(t)) gifts += q; else { bought += q; if (!last || t.ts > last.ts) last = t; } }
      else if (t.dir === 'sell' && t.ts <= ts) usedBefore += q;
      else if (!t.dir && t.channel === 'trade') both.push(t);
    });
    let out = nameOf(l.itemId) + ': ' + bought + ' bought in your data' + (last ? ' (latest: ' + chanLabel(last.channel) + tradeTag(last) + ', ' + fdate(last.ts) + ')' : '') + (gifts ? ', ' + gifts + ' received as gifts (not counted as stock)' : '') + '; ' + usedBefore + ' sold, sent or removed before this sale; this sale takes ' + l.qty + ', ' + l.unmatched + ' short.';
    if (both.length) out += ' Trade' + (both.length > 1 ? 's ' : ' ') + both.slice(0, 3).map(t => '#' + t.tradeId).join(', ') + ' moved items both ways, so ' + (both.length > 1 ? 'they are' : 'it is') + ' not used as a buy.';
    if (!bought) out += ' No earlier purchase of this item is in your data. If you bought it in a trade, look the trade up in Settings.';
    else if (bought <= usedBefore) out += ' Everything you bought was already used by earlier sales.';
    return out;
  }
  /* ----- Profit tab: graph, timeline (10 rows at a time), details on tap ----- */
  const profileUrl = id => 'https://www.torn.com/profiles.php?XID=' + encodeURIComponent(id);
  const isPid = id => id != null && /^\d+$/.test(String(id)) && Number(id) > 0;
  const playerLink = id => !isPid(id) ? null : `<a href="${profileUrl(id)}" target="_blank" rel="noopener">${(state.names || {})[id] ? esc(state.names[id]) + ' [' + esc(id) + ']' : 'player ' + esc(id)} ↗</a>`;
  const hhmm = ts => new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  const dayLabel = ts => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const sgn = n => (n >= 0 ? '+' : '−') + fmt(Math.abs(n));
  const dl = (a, b, sep) => `<div class="tfp-dl${sep ? ' sep' : ''}"><span>${a}</span><span>${b}</span></div>`;
  const TAGCLS = { trade: 'trade', market: 'market', bazaar: 'market', abroad: 'market', send: 'sent', recv: 'sent', shop: 'sent' };
  const rcSource = u => /weav3r/i.test(u || '') ? 'Weaver' : /tornexchange/i.test(u || '') ? 'TornExchange' : /z0cl/i.test(u || '') ? 'PawnHub' : 'Receipt';
  const safeUrl = u => /^https:\/\//i.test(u || '') ? u : null;
  const titleOf = (tx, verb) => verb + ' ' + ((tx.items || []).length === 1 ? tx.items[0].qty + '× ' + esc(tx.items[0].name || nameOf(tx.items[0].id)) : (tx.items || []).length + ' items');
  let namesBusy = false;
  // Names of the players on rows you opened: looked up once, kept on this device, a few at a time.
  async function fetchNames() {
    if (namesBusy) return; namesBusy = true;
    try {
      state.names = state.names || {}; ui.nameFail = ui.nameFail || {};
      const want = [];
      const addId = tx => { if (tx && isPid(tx.cp) && !state.names[tx.cp] && !ui.nameFail[tx.cp] && want.indexOf(String(tx.cp)) < 0) want.push(String(tx.cp)); };
      Object.keys(ui).forEach(k => { if (/^tx_/.test(k) && ui[k]) addId(state.txs[k.slice(3)]); });
      (ui.visTx || []).forEach(id => addId(state.txs[id]));
      let got = 0;
      for (const id of want.slice(0, 4)) {
        try {
          const j = await api('user/' + id + '/basic'), pr = (j && j.profile) || j || {};
          if (!state.nameSample) state.nameSample = { keys: Object.keys(j || {}), profileKeys: Object.keys(pr) };
          if (pr.name) { state.names[id] = String(pr.name).slice(0, 40); got++; } else ui.nameFail[id] = 1;
        } catch (e) { ui.nameFail[id] = 1; if (e.rate) break; }
        await sleep(700);
      }
      if (got) { save(); if (ui.open) render(); }
    } finally { namesBusy = false; }
  }
  function entryHtml(e) {
    const tx = e.tx, k = 'tx_' + tx.id, open = !!ui[k], f = e.f;
    const amt = { sale: `<span class="tfp-amt ${pnlCls(f && f.profit)}">${f && f.profit != null ? sgn(f.profit) : ''}</span>`, skip: '<span class="tfp-amt tfp-warn">not counted</span>', pend: `<span class="tfp-amt tfp-warn">${tx.dir ? 'needs value' : 'both ways'}</span>`, buy: `<span class="tfp-amt tfp-sub" style="margin:0">−${fmt(tx.amount)}</span>`, gift: '<span class="tfp-amt tfp-sub" style="margin:0">gift</span>' }[e.kind];
    const verb = e.kind === 'buy' ? 'Bought' : e.kind === 'gift' ? (tx.dir === 'buy' ? 'Got' : 'Gave') : tx.dir === 'buy' ? 'Bought' : tx.dir ? 'Sold' : 'Items moved';
    let h = `<a href="#" class="tfp-tl" data-act="toggle" data-v="${esc(k)}"><div class="tm">${hhmm(tx.ts)}</div><div class="gr"><div class="tt"><span class="tfp-tag ${TAGCLS[tx.channel] || ''}">${esc(chanLabel(tx.channel))}</span>${titleOf(tx, verb)}</div><div class="tfp-sub">${open ? 'tap to close' : 'tap for details'}</div></div>${amt}</a>`;
    if (!open) return h;
    const items = tx.items || [], n = items.length;
    const vals = flipOpts().values || {}, mv = items.map(i => i.qty * (vals[i.id] || 0)), w = mv.every(x => x > 0) ? mv : items.map(i => i.qty), ws = w.reduce((a, x) => a + x, 0) || 1;
    let d = '<div class="tfp-hdr">Items</div>' + items.slice(0, 8).map((i, idx) => {
      const unit = i.price != null ? fmt(i.price) : tx.amount != null && i.qty ? '~' + fmt(Math.round(tx.amount * w[idx] / ws / i.qty)) : '?';
      return dl(i.qty + '× ' + esc(i.name || nameOf(i.id)), unit + ' ea');
    }).join('') + (n > 8 ? '<div class="tfp-sub">+ ' + (n - 8) + ' more items</div>' : '');
    const market = tx.channel === 'market' && tx.dir === 'sell';
    if (e.kind === 'sale' || e.kind === 'skip') {
      if (market && tx.fee != null && tx.each != null) d += dl('Listed at', fmt(tx.each) + ' each', true) + dl('Sold for', fmt(tx.amount + tx.fee)) + dl('Torn fee', '−' + fmt(tx.fee)) + dl('You received', '<b>' + fmt(tx.amount) + '</b>');
      else if (market) d += dl('You received', '<b>' + fmt(netAmt(tx)) + '</b>', true) + '<div class="tfp-sub">Listing price and fee are not stored for sales read before v0.1.129. Settings → Re-sync from start fills them in.</div>';
      else d += dl(gotWord(tx).replace(/^./, c => c.toUpperCase()), '<b>' + fmt(netAmt(tx)) + '</b>', true);
      if (e.kind === 'sale') d += dl('Your cost', costOf(f) == null ? '?' : fmt(costOf(f))) + dl('Profit', `<b class="${pnlCls(f.profit)}">${sgn(f.profit)}</b>`) + (f.unmatched ? `<div class="tfp-sub tfp-warn">${f.unmatched} unit(s) had no matching buy</div>` : '');
    } else if (tx.amount != null) d += dl(e.kind === 'buy' ? 'You paid' : 'Amount', '<b>' + fmt(tx.amount) + '</b>', true);
    // who it was with
    const who = tx.channel === 'trade' ? 'With' : market ? 'Bought by' : tx.channel === 'bazaar' ? 'Seller' : tx.channel === 'send' ? 'Sent to' : tx.channel === 'recv' ? 'From' : null;
    if (who) d += '<div class="tfp-hdr">' + (tx.channel === 'trade' ? 'Trade' : who === 'Bought by' ? 'Buyer' : 'Player') + '</div>' + dl(who, market && (tx.anon || !isPid(tx.cp)) ? 'anonymous buyer' : (playerLink(tx.cp) || '–'));
    if (tx.tradeId) d += dl('Trade number', '#' + esc(tx.tradeId));
    const ru = safeUrl(tx.receiptUrl);
    if (ru) d += dl('Receipt', `<a href="${esc(ru)}" target="_blank" rel="noopener">🧾 ${rcSource(ru)} ↗</a>`);
    else if (tx.src === 'receipt') d += dl('Receipt', '🧾 attached');
    if (e.kind === 'skip') d += skippedRowHtml(f, false);
    else if (e.kind === 'pend') d += pendingHtml([tx], false);
    else d += `<div class="tfp-sub"><a href="#" data-act="edit" data-id="${esc(tx.id)}">✎ ${e.kind === 'gift' ? 'set value' : 'edit'}</a></div>` + (ui.editing === tx.id ? editBox(tx) : '');
    return h + '<div class="tfp-det">' + d + '</div>';
  }
  // Running profit over the chosen range: hourly for a day or two, daily after that, weekly for very long ranges.
  function graphHtml(sales, lo) {
    if (!sales.length) return '<div class="tfp-sub" style="margin:10px 0">No sales in this range yet.</div>';
    const now = Math.floor(Date.now() / 1000), first = Math.min.apply(null, sales.map(x => x.ts)), start0 = lo > 0 ? lo : first;
    const span = Math.max(1, now - start0), step = span <= 2 * 86400 ? 3600 : span <= 120 * 86400 ? 86400 : 7 * 86400;
    const t0 = Math.floor(start0 / step) * step, nb = Math.max(2, Math.floor((now - t0) / step) + 1), v = new Array(nb).fill(0);
    sales.forEach(x => { const i = Math.min(nb - 1, Math.max(0, Math.floor((x.ts - t0) / step))); v[i] += x.profit; });
    let c = 0; const cum = v.map(x => (c += x));
    const mn = Math.min(0, ...cum), mx = Math.max(0, ...cum), rg = (mx - mn) || 1, y = val => 78 - (val - mn) / rg * 66;
    const pts = cum.map((val, i) => [(i / (nb - 1) * 300).toFixed(1), y(val).toFixed(1)]), line = pts.map(q => q.join(',')).join(' '), up = cum[nb - 1] >= 0, col = up ? '#6fcf6f' : '#ef6f6f';
    const lab = [0, 1, 2, 3].map(i => { const ts = t0 + Math.round((nb - 1) * i / 3) * step; return step === 3600 ? hhmm(ts) : dayLabel(ts); });
    const gl = cum.map((val, i) => { const ts = t0 + i * step; return step === 3600 ? dayLabel(ts) + ' ' + hhmm(ts) : step === 86400 ? dayLabel(ts) : 'week of ' + dayLabel(ts); });
    const gdata = esc(JSON.stringify({ l: gl, v: cum.map(Math.round), y: pts.map(q => Number(q[1])) }));
    return `<svg viewBox="0 0 300 90" width="100%" height="90" preserveAspectRatio="none" class="tfp-graph" data-g="${gdata}">${mn < 0 ? `<line x1="0" x2="300" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#555" stroke-width=".6" stroke-dasharray="3 3"/>` : ''}<polygon fill="${up ? 'rgba(111,207,111,.13)' : 'rgba(239,111,111,.13)'}" points="${line} 300,${y(0).toFixed(1)} 0,${y(0).toFixed(1)}"/><polyline fill="none" stroke="${col}" stroke-width="2" points="${line}"/><circle cx="300" cy="${y(cum[nb - 1]).toFixed(1)}" r="3.5" fill="${col}"/><line class="gl" x1="0" x2="0" y1="0" y2="90" stroke="#aaa" stroke-width=".7" stroke-dasharray="2 2" style="display:none"/><circle class="gd" r="4" cx="0" cy="0" fill="${col}" style="display:none"/></svg><div class="tfp-axis">${lab.map(x => '<span>' + x + '</span>').join('')}</div><div class="tfp-sub tfp-gcap" style="min-height:17px">Touch the graph to see running profit for a day.</div>`;
  }
  // On All: say how much history is loaded, in a small line (the first sync only reads the last N days; Settings changes it).
  function olderNote() {
    if (ui.range !== 0) return '';
    const ts = Object.values(state.txs).map(t => t.ts).filter(Number); if (!ts.length) return '';
    const days = Math.max(1, Math.round((Date.now() / 1000 - Math.min.apply(null, ts)) / 86400));
    return `<div class="tfp-sub" style="margin:6px 0">${days} day${days === 1 ? '' : 's'} of history loaded. <a href="#" data-act="tab" data-v="settings">Change in Settings</a> if you want more.</div>`;
  }
  function rangeCaption() {
    const r = ui.range;
    return r === 'today' ? 'Today' : r === 'yesterday' ? 'Yesterday' : r === 'custom' ? (ui.from || '') + ' to ' + (ui.to || ui.from || '') : r ? 'Last ' + r + ' days' : 'All time';
  }
  // Counts for the chosen range: how many trades, sends, sales and buys, how many items moved and the money on them.
  function activityHtml(inR) {
    const L = { 'trade|sell': 'Trades (sold)', 'trade|buy': 'Trades (bought)', 'send|sell': 'Sent', 'recv|buy': 'Received', 'market|sell': 'Market sales', 'bazaar|sell': 'Bazaar sales', 'market|buy': 'Market buys', 'bazaar|buy': 'Bazaar buys', 'shop|buy': 'Shop buys', 'abroad|buy': 'Abroad buys' }, m = {};
    Object.values(state.txs).forEach(t => {
      if (!inR(t.ts) || !t.items || !t.items.length || !L[t.channel + '|' + t.dir]) return;
      const o = m[t.channel + '|' + t.dir] = m[t.channel + '|' + t.dir] || { n: 0, q: 0, amt: 0, unk: 0 };
      o.n++; o.q += t.items.reduce((a, i) => a + (i.qty || 0), 0);
      if (t.amount != null) o.amt += t.amount; else o.unk++;
    });
    const keys = Object.keys(L).filter(k => m[k]); if (!keys.length) return '';
    return '<div class="tfp-hdr">Activity · ' + esc(rangeCaption()) + '</div>' + keys.map(k => { const o = m[k]; return dl(L[k], '<b>' + o.n + '</b> · ' + o.q.toLocaleString() + ' item' + (o.q === 1 ? '' : 's') + (o.amt ? ' · ' + fmt(o.amt) : '') + (o.unk ? ' <span class="tfp-sub">(' + o.unk + ' no value)</span>' : '')); }).join('');
  }
  function profitHtml() {
    const [cutoff, upto] = rangeBounds(), inR = ts => ts >= cutoff && ts < upto;
    const res = getRes(), ack = state.ack || {};
    const flips = res.flips.filter(f => inR(f.tx.ts));
    const done = flips.filter(f => f.profit != null);
    const lines = done.reduce((a, f) => a.concat(f.lines.filter(l => l.matched > 0)), []);
    const revenue = lines.reduce((a, l) => a + l.proceeds, 0), cost = lines.reduce((a, l) => a + (l.cost || 0), 0);
    const profit = done.reduce((a, f) => a + f.profit, 0);
    let h = `${rangeChips()}${rangeDates()}<div class="tfp-sub" style="margin:0">Profit · ${esc(rangeCaption())}</div><div class="tfp-prow"><div class="tfp-big ${pnlCls(profit)}">${fmt(profit)}</div><div class="tfp-sub" style="margin:0">${cost > 0 ? (profit >= 0 ? '▲ ' : '▼ ') + (profit / cost * 100).toFixed(1) + '% on cost' : ''}</div></div>
      ${graphHtml(done.map(f => ({ ts: f.tx.ts, profit: f.profit })), cutoff)}
      <div class="tfp-stats"><div class="tfp-stat"><span>Sold for</span><b>${fmt(revenue)}</b></div><div class="tfp-stat"><span>Cost</span><b>${fmt(cost)}</b></div><div class="tfp-stat"><span>Sales</span><b>${done.length}</b></div></div>${activityHtml(inR)}${olderNote()}`;
    const left = h; h = ''; const wrap2 = r => '<div class="tfp-two"><div class="tfp-colL">' + left + '</div><div class="tfp-colR">' + r + '</div></div>';
    if (!Object.keys(state.txs).length) return wrap2('<div class="tfp-msg">Nothing imported yet. Tap Sync to read your Torn log.</div>');
    const entries = [];
    flips.forEach(f => { if (f.profit != null) entries.push({ tx: f.tx, kind: 'sale', f }); else if (!ack[f.tx.id]) entries.push({ tx: f.tx, kind: 'skip', f }); });
    res.pending.filter(t => inR(t.ts) && !ack[t.id]).forEach(tx => entries.push({ tx, kind: 'pend' }));
    Object.values(state.txs).forEach(t => {
      if (!inR(t.ts) || !t.items || !t.items.length) return;
      if (isGift(t)) { if (!ack[t.id]) entries.push({ tx: t, kind: 'gift' }); }
      else if (t.channel === 'trade' && t.dir === 'buy' && t.amount != null) entries.push({ tx: t, kind: 'buy' });
    });
    entries.sort((a, b) => b.tx.ts - a.tx.ts);
    if (!entries.length) return wrap2('<div class="tfp-msg">No activity in this time range. Sales appear once you sell items you bought.</div>');
    const dayTot = {}; entries.forEach(e => { if (e.kind === 'sale') dayTot[dayLabel(e.tx.ts)] = (dayTot[dayLabel(e.tx.ts)] || 0) + e.f.profit; });
    const lim = ui.limit || 10; let last = '';
    ui.visTx = entries.slice(0, lim).map(e => e.tx.id);
    entries.slice(0, lim).forEach(e => {
      const d = dayLabel(e.tx.ts);
      if (d !== last) { last = d; h += `<div class="tfp-day"><span>${d}</span>${dayTot[d] != null ? '<b class="' + pnlCls(dayTot[d]) + '">' + sgn(dayTot[d]) + '</b>' : ''}</div>`; }
      h += entryHtml(e);
    });
    if (entries.length > lim) h += `<a href="#" class="tfp-more" data-act="more">Show ${Math.min(10, entries.length - lim)} more · ${lim} of ${entries.length}</a>`;
    return wrap2(h + '<div class="tfp-foot">' + historyNote() + (state.oldestLog ? ' · oldest log entry read ' + fdate(state.oldestLog) : '') + ' · times in TCT</div>');
  }
  /* ----- Items tab: where the profit comes from ----- */
  function itemsHtml() {
    const [cutoff, upto] = rangeBounds(), inR = ts => ts >= cutoff && ts < upto;
    const done = getRes().flips.filter(f => f.profit != null && inR(f.tx.ts)), profit = done.reduce((a, f) => a + f.profit, 0), by = ui.itemsBy || 'item';
    let h = `${rangeChips()}${rangeDates()}<div class="tfp-sub" style="margin:0">Profit · ${esc(rangeCaption())}</div><div class="tfp-big ${pnlCls(profit)}">${fmt(profit)}</div>
      ${olderNote()}<div class="tfp-seg">${[['item', 'By item'], ['day', 'By day'], ['channel', 'By channel']].map(x => `<span class="${by === x[0] ? 'on' : ''}" data-act="itemsby" data-v="${x[0]}">${x[1]}</span>`).join('')}</div>`;
    const left = h; h = ''; const wrap2 = r => '<div class="tfp-two"><div class="tfp-colL">' + left + '</div><div class="tfp-colR">' + r + '</div></div>';
    const rows = [];
    if (by === 'item') {
      const m = {};
      done.forEach(f => f.lines.filter(l => l.matched > 0 && l.profit != null).forEach(l => { const o = m[l.itemId] = m[l.itemId] || { id: l.itemId, p: 0, q: 0, rev: 0, cost: 0 }; o.p += l.profit; o.q += l.matched; o.rev += l.proceeds; o.cost += l.cost || 0; }));
      Object.values(m).sort((a, b) => b.p - a.p).forEach(o => rows.push({ t: esc(nameOf(o.id)), p: o.p, sub: o.q + ' sold · avg buy ' + fmt(o.cost / o.q) + ' · avg sell ' + fmt(o.rev / o.q), id: o.id }));
    } else if (by === 'day') {
      const m = {}; done.forEach(f => { const k = dayStr(f.tx.ts); (m[k] = m[k] || { p: 0, n: 0 }); m[k].p += f.profit; m[k].n++; });
      Object.keys(m).sort().reverse().forEach(k => rows.push({ t: k, p: m[k].p, sub: m[k].n + ' sale' + (m[k].n === 1 ? '' : 's') }));
    } else {
      const m = {}; done.forEach(f => { const k = f.tx.channel; (m[k] = m[k] || { p: 0, n: 0 }); m[k].p += f.profit; m[k].n++; });
      Object.keys(m).sort((a, b) => m[b].p - m[a].p).forEach(k => rows.push({ t: esc(chanLabel(k)), p: m[k].p, sub: m[k].n + ' sale' + (m[k].n === 1 ? '' : 's') }));
    }
    if (!rows.length) return wrap2('<div class="tfp-msg">No sales in this range yet.</div>');
    const mx = Math.max.apply(null, rows.map(r => Math.abs(r.p))) || 1, lim = ui.ilimit || 25;
    rows.slice(0, lim).forEach(r => {
      h += `<${r.id ? 'a href="#" data-act="itemlog" data-id="' + esc(r.id) + '"' : 'div'} class="tfp-ir"><div class="tfp-top"><b>${r.t}</b><b class="${pnlCls(r.p)}">${sgn(r.p)}</b></div><div class="tfp-sub">${r.sub}</div><div class="tfp-bar"><i style="width:${Math.max(2, Math.abs(r.p) / mx * 100).toFixed(0)}%;background:${r.p >= 0 ? '#3fae72' : '#d65a5a'}"></i></div></${r.id ? 'a' : 'div'}>${r.id && String(ui.itemLog) === String(r.id) ? ledgerHtml(r.id) : ''}`;
    });
    if (rows.length > lim) h += `<a href="#" class="tfp-more" data-act="imore">Show 25 more · ${lim} of ${rows.length}</a>`;
    return wrap2(h + (by === 'item' ? '<div class="tfp-sub" style="margin-top:8px">Tap an item for its buy and sell history.</div>' : ''));
  }
  // Units of one item still listed on the item market: listed minus sold minus taken down (an estimate; older listings are not in the log window).
  function listedNow(id) {
    const ev = Object.values(state.listEvents || {}).filter(x => x.items.some(i => String(i.id) === String(id)));
    if (!ev.length) return null;
    const q = x => x.items.filter(i => String(i.id) === String(id)).reduce((a, i) => a + i.qty, 0);
    let n = 0;
    ev.forEach(x => { n += x.kind === 'add' ? q(x) : -q(x); });
    Object.values(state.txs).forEach(t => { if (t.channel === 'market' && t.dir === 'sell' && t.items && t.ts >= Math.min.apply(null, ev.map(x => x.ts))) n -= t.items.filter(i => String(i.id) === String(id)).reduce((a, i) => a + i.qty, 0); });
    return Math.max(0, n);
  }
  // Every buy, sale, send and removal of one item in time order with the running amount in stock, so a shortage can be traced.
  function ledgerHtml(forId) {
    const id = forId || ui.itemLog; if (!id) return '';
    const txs = Object.values(state.txs).filter(t => t.items && t.items.some(i => String(i.id) === String(id))).sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
    let bal = 0;
    let firstShort = null;
    const rows = txs.map(t => {
      const qty = t.items.filter(i => String(i.id) === String(id)).reduce((a, i) => a + i.qty, 0), buy = t.dir === 'buy', gift = isGift(t);
      if (buy && !gift) bal += qty; else if (!buy) bal -= qty;
      if (bal < 0 && !firstShort) firstShort = { ts: t.ts, short: -bal, what: (buy ? 'buy' : t.channel === 'send' ? 'send' : 'sale') + ' of ' + qty };
      const what = t.channel === 'writeoff' ? 'removed from stock' : buy ? (gift ? 'received as a gift (not stock)' : 'bought') : (gift ? 'given away' : 'sold');
      return `<div class="tfp-sub">${fdate(t.ts)} · ${buy && !gift ? '+' : buy ? '' : '−'}${qty} ${what} (${chanLabel(t.channel)}${tradeTag(t)}) → <b class="${bal < 0 ? 'tfp-warn' : ''}">${bal} in stock</b></div>`;
    });
    const listed = listedNow(id);
    const listNote = listed != null ? `<div class="tfp-sub">Still listed on the item market: about ${listed}. Listing does not count as a sale; only units that sell are counted.</div>` : '';
    return `<div class="tfp-row"><div class="tfp-top"><b>${esc(nameOf(id))} history</b><a href="#" data-act="itemlogclose">close</a></div>${firstShort ? '<div class="tfp-sub tfp-warn">Stock first goes short at ' + fdate(firstShort.ts) + ' (' + esc(firstShort.what) + '): ' + firstShort.short + ' more went out than the tracker saw come in. Look for a missing buy just before that.</div>' : ''}${rows.length ? rows.slice(ui.ledgerAll ? 0 : -40).reverse().join('') : '<div class="tfp-sub">Nothing recorded for this item.</div>'}${rows.length > 40 ? (ui.ledgerAll ? '<a href="#" data-act="ledgermore">Show newest 40 only</a>' : '<div class="tfp-sub">(newest 40 of ' + rows.length + ') <a href="#" data-act="ledgermore">Show all ' + rows.length + '</a></div>') : ''}${listNote}<div class="tfp-sub">A negative number means more was sold or sent than the tracker saw coming in.</div></div>`;
  }
  function editBox(tx) {
    const label = tx.dir === 'buy' ? 'Amount paid ($)' : 'Amount received ($)';
    return `<div class="tfp-gap"></div><div class="tfp-sub">${label}</div>
      <input class="tfp-in" id="tfp-val-${esc(tx.id)}" inputmode="numeric" value="${tx.amount != null ? tx.amount : ''}">
      <div class="tfp-gap"></div><button class="tfp-b" data-act="saveval" data-id="${esc(tx.id)}">Save &amp; lock</button>${tx.amount != null && (tx.channel === 'send' || tx.channel === 'recv') ? ` <button class="tfp-b" data-act="clearval" data-id="${esc(tx.id)}">Clear value</button>` : ''}`;
  }
  // Rows that need a look. Each has "Got it" (hides it from the count; it stays editable under Dismissed).
  function pendingHtml(list, dismissed) {
    if (!list.length) return '';
    const giftable = dismissed ? [] : list.filter(t => t.channel === 'send' || t.channel === 'recv');
    const bulk = giftable.length > 3 ? `<button class="tfp-b" data-act="giftall">${ui.armGift ? 'Tap again to confirm: ' + giftable.length + ' set to $0' : 'Mark all ' + giftable.length + ' sends/receives as gifts ($0)'}</button>` : '';
    const older = !dismissed && state.pawnhubSince ? list.filter(t => t.channel === 'send' && t.dir === 'sell' && t.ts < state.pawnhubSince - PH_LAG) : [];
    const olderBtn = older.length ? `<button class="tfp-b" data-act="giftolder">${ui.armOlder ? 'Tap again to confirm: ' + older.length + ' not counted' : older.length + ' sends from before PawnHub Balance starts: leave out of profit'}</button> ` : '';
    const ackBtn = tx => `<div class="tfp-gap"></div><button class="tfp-b" data-act="${dismissed ? 'unack' : 'ack'}" data-id="${esc(tx.id)}">${dismissed ? 'Show again' : 'Got it'}</button>`;
    return olderBtn + bulk + list.slice().sort((a, b) => b.ts - a.ts).map(tx => {
      let h = `<div class="tfp-row"><div class="tfp-top"><span>${fdate(tx.ts)} · ${chanLabel(tx.channel)}${tradeTag(tx)}</span><span>⚠️</span></div><div class="tfp-sub">${itemSummary(tx)}${tx.cp ? ' · player ' + esc(tx.cp) : ''}${tx.title ? ' · ' + esc(tx.title) : ''}</div>`;
      if (!tx.dir) h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="sell">I sold these</button> <button class="tfp-b" data-act="dir" data-id="${esc(tx.id)}" data-v="buy">I bought these</button>`;
      else {
        h += editBox(tx);
        if (tx.channel === 'send' || tx.channel === 'recv') h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="gift" data-id="${esc(tx.id)}">Gift / no payment ($0)</button>`;
        // No "money received" suggestions: a payment settles a balance and does not belong to one send. Values come from receipts or the PawnHub Balance page.
      }
      return h + ackBtn(tx) + '</div>';
    }).join('');
  }
  // A sale the tracker could not cost, with the reason and the item trail.
  function skippedRowHtml(f, dismissed) {
    const tx = f.tx;
    const why = f.unmatched ? f.unmatched + ' unit(s) have no matching buy: bought before the sync window, or got another way. A longer look-back (Settings, then Re-sync from start) may find the buy.' : 'The items came from a buy or receive with no value. Open the matching buy or send and set a value.';
    return `<div class="tfp-row"><div class="tfp-top"><span>${fdate(tx.ts)} · ${chanLabel(tx.channel)}${tradeTag(tx)}</span><span class="tfp-warn">not counted</span></div><div class="tfp-sub">${itemSummary(tx)} · ${gotWord(tx)} ${fmt(netAmt(tx))}</div><div class="tfp-sub tfp-warn">${why}</div>${f.lines.filter(l => l.unmatched > 0).map(l => `<div class="tfp-sub">${esc(itemTrail(f, l))} <a href="#" data-act="itemlog" data-id="${esc(l.itemId)}">history</a></div>`).join('')}<div class="tfp-gap"></div><button class="tfp-b" data-act="${dismissed ? 'unack' : 'ack'}" data-id="${esc(tx.id)}">${dismissed ? 'Show again' : 'Got it'}</button></div>`;
  }
  // Everything that needs a look, split into waiting and dismissed ("Got it").
  const getRes = () => ui._res || (ui._res = computeFlips(state.txs, flipOpts()));
  function attention() {
    const res = getRes(), ack = state.ack || {};
    const sk = res.flips.filter(f => f.profit == null);
    return { pend: res.pending.filter(t => !ack[t.id]), skip: sk.filter(f => !ack[f.tx.id]), dPend: res.pending.filter(t => ack[t.id]), dSkip: sk.filter(f => ack[f.tx.id]) };
  }
  function phPreviewHtml() {
    const p = ui.phPreview; if (!p) return '';
    return `<div class="tfp-msg" style="border:1px solid #3b6fd1"><b>PawnHub is ready</b><div class="tfp-sub" style="color:#ccc">PawnHub sent ${p.read} item payments. This would fill in <b>${p.n}</b> send${p.n === 1 ? '' : 's'}${p.from ? ' (' + dayLabel(p.from) + ' to ' + dayLabel(p.to) + ')' : ''}, ${fmt(p.total)} in all.${p.manual ? ' ' + p.manual + (p.manual === 1 ? ' of them has a value you entered, which would be replaced.' : ' of them have a value you entered, which would be replaced.') : ''}${p.loose ? ' ' + p.loose + ' PawnHub row' + (p.loose === 1 ? ' has' : 's have') + ' no matching send in your data.' : ''} Profit for past days will change. This check only happens the first time.</div><div class="tfp-gap"></div><button class="tfp-b" data-act="phapply">Apply</button> <button class="tfp-b" data-act="phcancel">Not now</button></div>`;
  }
  function inboxHtml() {
    const a = attention(), n = a.pend.length + a.skip.length, nd = a.dPend.length + a.dSkip.length;
    let h = `<div class="tfp-cat"><div class="tfp-top"><a href="#" class="tfp-cat-h" data-act="toggle" data-v="showInbox"><span class="tfp-chev">${ui.showInbox ? '▾' : '▸'}</span><b>Needs attention</b><div class="tfp-sub">${n ? (a.pend.length ? '<span class="tfp-warn">' + a.pend.length + ' need a value</span>' : '') + (a.pend.length && a.skip.length ? ' · ' : '') + (a.skip.length ? '<span class="tfp-warn">' + a.skip.length + ' not counted</span>' : '') : 'Nothing waiting'}${nd ? ' · ' + nd + ' dismissed' : ''}</div></a></div>`;
    if (ui.showInbox) {
      if (n) h += `<div class="tfp-gap"></div><button class="tfp-b" data-act="ackall">${ui.armAck ? 'Tap again to dismiss all ' + n : 'Dismiss all ' + n}</button>`;
      h += pendingHtml(a.pend, false) + a.skip.map(f => skippedRowHtml(f, false)).join('');
      if (!n) h += '<div class="tfp-sub">Nothing needs a value. 🎉</div>';
      if (nd) h += `<div class="tfp-gap"></div><a href="#" data-act="toggle" data-v="showDismissed">${ui.showDismissed ? '▾' : '▸'} Dismissed (${nd})</a>` + (ui.showDismissed ? pendingHtml(a.dPend, true) + a.dSkip.map(f => skippedRowHtml(f, true)).join('') : '');
      h += '<div class="tfp-sub">"Got it" only hides a row here. Nothing is changed and profit stays the same; open Dismissed to edit it later.</div>';
    }
    return h + '</div>';
  }
  function receiptsHtml() {
    const li = state.lastInbox, hasW = !!sget('w3bkey', '');
    let h = `<div class="tfp-cat"><div class="tfp-dl"><span>Weaver (TornW3B)</span><span class="${hasW ? 'tfp-pos' : 'tfp-warn'}">${hasW ? 'connected ✓' : 'not connected (add a key in Settings)'}</span></div>
      ${usesPH() ? '<div class="tfp-dl"><span>PawnHub</span><span>' + (sget('phkey', '') ? (state.phAt ? '<span class="tfp-pos">key connected</span> · read ' + fdate(state.phAt) : 'key saved, not read yet') : state.pawnhubSince ? '<span class="tfp-pos">read</span> · from ' + fdate(state.pawnhubSince) : 'open the Balance page in Torn to read it') + '</span></div>' : ''}
      <div class="tfp-dl"><span>TornExchange</span><span>by link</span></div>${li ? '<div class="tfp-sub">Last receipt added ' + fdate(li.at) + (li.msg ? ': ' + esc(li.msg) : '') + '</div>' : ''}</div>`;
    { const wl = ui.inboxList || [], dd = state.lastSyncDetail && state.lastSyncDetail.weaver, wm = dd && dd.match(/not found in your log \((.*)\)\. TornW3B lists/), cnt = wl.length + (wm ? 1 : 0);
      if (cnt) {
        h += `<div class="tfp-note" style="font-size:12.5px;color:#c9aa5d">⏳ ${wl.length ? wl.length + ' saved receipt' + (wl.length === 1 ? ' is' : 's are') + ' waiting for their trade or to be read.' : 'Some Weaver receipts are waiting for their trade.'} They attach on the next Sync. <a href="#" data-act="toggle" data-v="showWaiting">See which ${ui.showWaiting ? '▾' : '▸'}</a>${wl.length ? ' · <a href="#" data-act="inbox">Try now</a>' : ''}</div>`;
        if (ui.showWaiting) {
          h += wl.map(x => { const u = safeUrl(x.u); return `<div class="tfp-row"><div class="tfp-top"><span><span class="tfp-tag ${x.s === 'weaver' ? 'trade' : x.s === 'pawnhub' || x.s === 'pawnhub-balance' ? 'sent' : 'market'}">${esc(x.s === 'pawnhub-balance' ? 'PawnHub Balance' : x.s === 'weaver' ? 'Weaver' : x.s === 'pawnhub' ? 'PawnHub' : 'Receipt')}</span>${esc(x.i || (x.n ? x.n + ' rows' : 'receipt'))}</span><b>${x.t != null ? fmt(x.t) : ''}</b></div><div class="tfp-sub">${x.id ? 'Trade #' + esc(x.id) + ' · ' : ''}${x.e ? esc(x.e) : 'its trade is not in your log yet'}${u ? ' · <a href="' + esc(u) + '" target="_blank" rel="noopener">open receipt ↗</a>' : ''}</div></div>`; }).join('');
          if (wm) h += `<div class="tfp-row"><div class="tfp-sub">Weaver receipts from the last sync whose trade is not in your log yet: ${esc(wm[1].slice(0, 600))}</div></div>`;
        }
      } }
    h += '<div class="tfp-day"><span>Add a receipt</span></div><div class="tfp-sub">Open a receipt in Torn, or paste its link here.</div><textarea class="tfp-ta" id="tfp-rc" placeholder="Paste a receipt link"></textarea><div class="tfp-gap"></div><button class="tfp-b" data-act="addrc">Add receipt</button>';
    if (ui.failedLinks && ui.failedLinks.length) h += '<div class="tfp-msg">Could not read automatically. Open, and it adds itself (then come back here): ' + ui.failedLinks.map((u, i) => '<a href="' + esc(u.split('#')[0]) + '#tfp-add" target="_blank" rel="noopener">receipt ' + (i + 1) + '</a>').join(' · ') + '</div>';
    if (!IS_PDA_ENV) h += ' <button class="tfp-b" data-act="pawnhub">' + (ui.busy ? 'Reading…' : 'Read PawnHub Balance now') + '</button>';
    if (hasGM && sget('pawnhubAuto', false)) h += ' <a href="#" data-act="pawnoff">stop doing this on Sync</a>';
    if (hasW) h += ' <button class="tfp-b" data-act="w3bimport">' + (ui.busy ? 'Importing…' : 'Import Weaver receipts') + '</button>';
    if (ui.pendingReceipt) {
      const rc = ui.pendingReceipt;
      h += `<div class="tfp-msg"><b>${rc.source === 'weaver' ? 'Weaver' : rc.source === 'pawnhub' ? 'PawnHub' : 'TornExchange'} receipt</b> · ${fmt(rc.total)}<br>${rc.items.map(i => i.qty + '× ' + esc(i.name)).join(', ')}</div>`;
      ui.candidates.forEach(c => { h += `<div class="tfp-row"><div class="tfp-top"><span>${fdate(c.tx.ts)} · ${chanLabel(c.tx.channel)}${tradeTag(c.tx)}</span><button class="tfp-b" data-act="attach" data-id="${esc(c.tx.id)}">Attach</button></div><div class="tfp-sub">${itemSummary(c.tx)}</div></div>`; });
      h += '<div class="tfp-gap"></div><button class="tfp-b" data-act="newtrade">Add as a new trade instead</button>';
    }
    const rcs = Object.values(state.txs).filter(t => t.src === 'receipt' && t.items && t.items.length).sort((a, b) => b.ts - a.ts), lim = ui.rlimit || 10;
    h += '<div class="tfp-day"><span>Recent receipts</span><span>newest first</span></div>';
    if (!rcs.length) h += '<div class="tfp-sub">No receipts yet.</div>';
    rcs.slice(0, lim).forEach(t => {
      const u = safeUrl(t.receiptUrl), src = u ? rcSource(u) : t.channel === 'send' ? 'PawnHub' : 'Receipt', first = t.items[0];
      h += `<div class="tfp-row"><div class="tfp-top"><span><span class="tfp-tag ${src === 'Weaver' ? 'trade' : src === 'PawnHub' ? 'sent' : 'market'}">${src}</span>${esc(first.name || nameOf(first.id))}${t.items.length > 1 ? ' +' + (t.items.length - 1) : ''}</span><b>${t.amount != null ? fmt(t.amount) : ''}</b></div><div class="tfp-sub">${t.tradeId ? 'Trade #' + esc(t.tradeId) + ' · ' : ''}${fdate(t.ts)}${u ? ' · <a href="' + esc(u) + '" target="_blank" rel="noopener">open receipt ↗</a>' : ''}</div></div>`;
    });
    if (rcs.length > lim) h += `<a href="#" class="tfp-more" data-act="rmore">Show 10 more · ${lim} of ${rcs.length}</a>`;
    return h;
  }
  function settingsHtml() {
    const own = !!sget('apikey', '');
    const keyBox = `<div class="tfp-sub">${IN_PDA && !own ? 'Using your Torn PDA key by default.' : 'Torn API key.'} <a href="${esc(KEYURL)}">Create a custom key ↗</a> (read-only: just your log and item names), then paste it here. Limited keys don't work.</div>
      <input class="tfp-in" id="tfp-key" type="password" autocomplete="off" placeholder="${own ? 'Key saved (hidden). Paste a new one to replace.' : 'Paste your key'}"><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="savekey">Save key</button> ${own ? '<button class="tfp-b" data-act="clearkey">Remove key</button>' : ''}
      <table class="tfp-disc"><tr><td>Your data</td><td>Stays on this device. Not shared with anyone.</td></tr>
      <tr><td>What it does</td><td>Reads your own item log and item names to work out flip profit. Read-only; no game actions.</td></tr>
      <tr><td>Your key</td><td>Stored only on this device. Sent only to api.torn.com.</td></tr>
      <tr><td>Key needs</td><td>Custom key: user basic, user log, torn items.</td></tr>
      <tr><td>Player names</td><td>Looked up once with your key when you open a row, then kept here.</td></tr>
      <tr><td>TornW3B key</td><td>Optional, for Weaver receipts. Stored here, sent only to weav3r.dev.</td></tr>
      <tr><td>PawnHub</td><td>Optional. Read when you open a receipt or the Balance page. If you add a PawnHub key (the Torn key you log in to PawnHub with), it is stored here and sent only to z0cl.eu. Without it, nothing is sent to PawnHub.</td></tr></table>
`;
    const hasPH = !!sget('phkey', '');
    const phKey = usesPH() ? `<div class="tfp-sub" style="margin-top:8px">PawnHub key (optional). Paste the Torn API key you use to log in to PawnHub. It is stored only on this device and sent only to PawnHub (z0cl.eu), like logging in there. Leave it empty and nothing is sent to PawnHub. A key with just "user basic" ticked is enough.</div><input class="tfp-in" id="tfp-phkey" type="password" autocomplete="off" placeholder="${hasPH ? 'PawnHub key saved (hidden). Paste a new one to replace.' : 'Paste your PawnHub key'}"><div class="tfp-gap"></div><button class="tfp-b" data-act="savephkey">Save PawnHub key</button> ${hasPH ? '<button class="tfp-b" data-act="clearphkey">Remove</button> ' : ''}` : '';
    const phBox = `<div class="tfp-row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-act="useph" ${usesPH() ? 'checked' : ''}> <b>I use PawnHub</b></label><div class="tfp-sub">${usesPH() ? 'Item sends are valued from PawnHub (Balance page, or your PawnHub key). Sends it can\'t value show under Needs attention.' : 'Item sends are left empty: they leave your stock but are not counted in profit and never show under Needs attention.'}</div>${phKey}</div>`;
    return `<div class="tfp-sub"><a href="#" data-act="runsetup">Run setup again</a></div>${inboxHtml()}${keyBox}${phBox}<div class="tfp-gap"></div><div class="tfp-sub">First sync looks back this many days</div>
      <input class="tfp-in" id="tfp-days" data-act="setting" inputmode="numeric" value="${esc(sget('startDays', 30))}">
      <div class="tfp-sub">Sync from the Profit tab. Last sync: ${state.syncedAt || state.lastSync ? fdate(state.syncedAt || state.lastSync) : 'never'} · ${Object.keys(state.txs).length} records</div>
      <div class="tfp-gap"></div><div class="tfp-sub">TornW3B key (optional, for Weaver receipts). Use the key from TornW3B, not your Torn key.</div>
      <input class="tfp-in" id="tfp-w3b" type="password" autocomplete="off" placeholder="${sget('w3bkey', '') ? 'TornW3B key saved (hidden). Paste a new one to replace.' : 'Paste your TornW3B key'}"><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="savew3b">Save TornW3B key</button> ${sget('w3bkey', '') ? '<button class="tfp-b" data-act="clearw3b">Remove</button> <button class="tfp-b" data-act="w3bcheck">' + (ui.busy ? 'Checking…' : 'Check Weaver') + '</button>' : ''}
      ${ui.w3bReport ? '<div class="tfp-msg">' + ui.w3bReport.map(l => '<div class="tfp-sub" style="color:#ccc">' + esc(l) + '</div>').join('') + '</div>' : ''}
      <div class="tfp-gap"></div><div class="tfp-sub">${link('more', 'Backup &amp; troubleshooting')}</div>
      ${ui.more ? settingsMore() : ''}`;
  }
  // "Why is my trade not where I expect it?": shows what the tracker holds for one trade number.
  function tradeLookup(q) {
    const m = String(q || '').match(/\d{4,}/);
    if (!m) throw new Error('Type a trade number (the digits after ID= in the trade link).');
    const id = m[0], tx = Object.values(state.txs).find(t => t.tradeId && String(t.tradeId) === id), out = [];
    if (tx) {
      const res = computeFlips(state.txs, flipOpts()), f = res.flips.find(x => x.tx.id === tx.id), pend = res.pending.some(x => x.id === tx.id);
      out.push('Trade #' + id + ' · ' + (tx.dir === 'buy' ? 'you bought' : tx.dir === 'sell' ? 'you sold' : 'direction unknown') + ' · ' + fdate(tx.ts) + ' · ' + itemSummary(tx) + ' · amount ' + (tx.amount == null ? 'none' : fmt(tx.amount)) + ' (' + (tx.src === 'receipt' ? 'receipt' : tx.src === 'log' ? 'Torn log' : tx.src || 'none') + ')');
      if (!tx.dir) out.push('Items moved both ways in this trade, so it is not counted as a buy or a sale.');
      else if (tx.dir === 'buy') out.push('A purchase: listed under Trade → bought. Its cost is used when you sell those items.');
      else if (pend) out.push('It has no amount: it is under "need a value" (open Trade, find it and set one).');
      else if (f && f.profit == null) out.push('Not counted: ' + (f.unmatched ? f.unmatched + ' unit(s) have no earlier buy of that item in your data (open the item history under "not counted").' : 'a buy it uses has no value.'));
      else if (f) out.push('Counted: profit ' + fmt(f.profit) + ' on ' + fmt(netAmt(tx)) + ' received. It shows under Trade for ' + dayStr(tx.ts) + ' (TCT).');
      else out.push('It is a gift or removed record, so it is not in profit.');
    } else {
      const tp = state.tradeParts && state.tradeParts[id], end = state.tradeEnd && state.tradeEnd[id];
      if (end) out.push('Trade #' + id + ' was ' + end.kind + ' on ' + fdate(end.ts) + ', so there is nothing to count.');
      else if (tp) out.push('Trade #' + id + ': the log has ' + Object.values(tp.parts || {}).map(p => p.title).join(', ') + ' but no "Trade completed" yet. Sync again in a few minutes.');
      else out.push('Trade #' + id + ' is not in your data. It is not in the log read so far: tap Sync, then look again.');
    }
    return out;
  }
  function settingsMore() {
    return `<div class="tfp-row"><b>Backup</b><div class="tfp-gap"></div><textarea class="tfp-ta" id="tfp-bk" placeholder="Export fills this box. Paste a backup here to import."></textarea><div class="tfp-gap"></div>
      <button class="tfp-b" data-act="export">Export</button> <button class="tfp-b" data-act="import">Import</button></div>
      <div class="tfp-row"><b>Troubleshooting</b><div class="tfp-gap"></div><input class="tfp-in" id="tfp-tq" inputmode="numeric" placeholder="Look up a trade number"><div class="tfp-gap"></div><button class="tfp-b" data-act="tradelookup">Look up trade</button> <button class="tfp-b" data-act="profitaudit">Check profit</button>${ui.audit ? ui.audit.map(l => '<div class="tfp-sub" style="color:#ccc">' + esc(l) + '</div>').join('') : ''}${ui.tradeInfo ? ui.tradeInfo.map(l => '<div class="tfp-sub" style="color:#ccc">' + esc(l) + '</div>').join('') : ''}<div class="tfp-gap"></div><button class="tfp-b" data-act="debug">Copy debug sample</button> <button class="tfp-b" data-act="resync">Re-sync from start</button></div>`;
  }

  /* ===================== first-run setup ===================== */
  let booted = false;
  const setupDone = () => !!sget('setupDone', false);
  // People who already use the script (a key or saved data) are not sent through setup.
  function migrateSetup() { if (!setupDone() && (sget('apikey', '') || Object.keys(state.txs || {}).length)) sset('setupDone', true); }
  function startSetup(again) {
    const d = Number(sget('startDays', 30)) || 30;
    ui.setup = { i: again ? 0 : Math.min(6, Number(sget('setupStep', 0)) || 0), torn: again && sget('apikey', '') ? 'custom' : null, tornOk: !!again && (!!sget('apikey', '') || IN_PDA), tornName: '', msg: '', ph: again ? usesPH() : null, phOk: !!again && !!sget('phkey', ''), phMsg: '', days: again ? d : 90, wMsg: '', busy: false };
  }
  async function checkTornKey(key) {
    const enc = encodeURIComponent(key);
    try {
      await apiUrl('https://api.torn.com/v2/user/log?limit=1&key=' + enc); // the log is the part that needs the right access
      let name = ''; try { const j = await apiUrl('https://api.torn.com/v2/user/basic?key=' + enc); name = ((j && j.profile) || j || {}).name || ''; } catch (e) { /* name is only a nicety */ }
      return { ok: true, name };
    } catch (e) { return { ok: false, msg: e && e.rate ? 'Torn is limiting requests right now. Wait a minute, then tap Check key again.' : String((e && e.message) || e).split(key).join('***').slice(0, 200) }; }
  }
  async function checkPawnKey(key) {
    try {
      const r = await httpRetry('https://z0cl.eu/PawnHub/api.php?selections=balance_events&key=' + encodeURIComponent(key), { Accept: 'application/json' });
      let j; try { j = JSON.parse(r.text); } catch (e) { return { ok: false, msg: 'PawnHub did not return data (HTTP ' + (r && r.status) + '). Check the key.' }; }
      if (j && j.error) return { ok: false, msg: 'PawnHub: ' + String(typeof j.error === 'string' ? j.error : (j.error.message || 'not accepted')).split(key).join('***').slice(0, 120) };
      return j && j.balance_events && Array.isArray(j.balance_events.events) ? { ok: true } : { ok: false, msg: 'PawnHub answered without payment rows. Check the key.' };
    } catch (e) { return { ok: false, msg: 'Could not reach PawnHub: ' + String((e && e.message) || e).split(key).join('***').slice(0, 100) }; }
  }
  const swSteps = () => ['welcome', 'torn', 'ph'].concat(ui.setup && ui.setup.ph ? ['phkey'] : [], ['days', 'weaver', 'done']);
  function setupHtml() {
    const S = ui.setup, steps = swSteps(), cur = steps[Math.min(S.i, steps.length - 1)], n = steps.length;
    const dots = '<div class="tfp-dots">' + steps.map((x, i) => '<i' + (i <= S.i ? ' class="on"' : '') + '></i>').join('') + '</div>';
    const opt = (act, v, title, sub, sel) => `<a href="#" class="tfp-opt${sel ? ' sel' : ''}" data-act="${act}" data-v="${v}"><b>${title}</b><span>${sub}</span></a>`;
    const next = (ok, label) => `<button class="tfp-b tfp-pri" data-act="swnext"${ok ? '' : ' disabled'}>${label || 'Next ▸'}</button>`;
    const back = S.i > 0 ? '<button class="tfp-b" data-act="swback">‹ Back</button>' : '<span></span>';
    let title = '', body = '', foot = '';
    if (cur === 'welcome') {
      title = '💰 Welcome to Arbitrage';
      body = `<p>Flip profit for Torn, worked out from your own log. A quick setup takes about a minute.</p><div class="tfp-opt"><b>Read-only</b><span>It only reads your log and item names. It never does anything in the game.</span></div><div class="tfp-opt"><b>Stays on this device</b><span>Your history and keys are stored here and sent only to Torn (and to PawnHub or Weaver if you add them).</span></div>`;
      foot = `<span class="tfp-sub">Step 1 of ${n}</span>` + next(true, 'Start ▸');
    } else if (cur === 'torn') {
      title = 'Your Torn API key';
      const custom = `<p>Arbitrage needs a key that can read your log. Make a <b>custom</b> key with only what it needs:</p><p><a href="${esc(KEYURL)}">Create the key for me ↗</a><br><span class="tfp-sub">Opens Torn already filled in. Tap Create, copy the key, then come back and paste it.</span></p><input class="tfp-in" id="tfp-swkey" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="-webkit-text-security:disc" placeholder="Paste your key"><div class="tfp-gap"></div><button class="tfp-b" data-act="swcheck">${S.busy ? 'Checking…' : 'Check key'}</button>`;
      if (IN_PDA) body = `<p>You're in Torn PDA. Use PDA's key, or a custom one.</p>` + opt('swpda', 'pda', 'Use my PDA key', 'Nothing to paste.', S.torn === 'pda') + opt('swcustom', 'custom', 'Use a custom key instead', 'Safer: only your log and item names.', S.torn === 'custom') + (S.torn === 'custom' ? custom : '');
      else body = custom;
      body += S.msg ? `<div class="tfp-msg ${S.tornOk ? 'tfp-pos' : 'tfp-warn'}">${esc(S.msg)}</div>` : (S.tornOk ? `<div class="tfp-msg tfp-pos">✓ Key saved${S.tornName ? ' for ' + esc(S.tornName) : ''}.</div>` : '');
      body += '<div class="tfp-sub">Limited keys do not work.</div>';
      foot = back + next(S.tornOk);
    } else if (cur === 'ph') {
      title = 'Do you use PawnHub?';
      body = `<p>PawnHub pays you for plushies and flowers you send. Arbitrage can read those payments to value your sends.</p>` + opt('swph', 'yes', 'Yes, I use PawnHub', 'Add your PawnHub key on the next step.', S.ph === true) + opt('swph', 'no', 'No', 'Item sends are left empty: they leave your stock but are not counted in profit.', S.ph === false);
      foot = back + next(S.ph !== null);
    } else if (cur === 'phkey') {
      title = 'Your PawnHub key';
      body = `<p>Paste the Torn API key you use to log in to PawnHub.</p><input class="tfp-in" id="tfp-swph" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="-webkit-text-security:disc" placeholder="Paste your PawnHub key"><div class="tfp-gap"></div><button class="tfp-b" data-act="swphcheck">${S.busy ? 'Checking…' : 'Check key'}</button>` + (S.phMsg ? `<div class="tfp-msg ${S.phOk ? 'tfp-pos' : 'tfp-warn'}">${esc(S.phMsg)}</div>` : (S.phOk ? '<div class="tfp-msg tfp-pos">✓ PawnHub key saved.</div>' : '')) + `<p class="tfp-sub">Stored only on this device and sent only to PawnHub (z0cl.eu), like logging in there. A key with just "user basic" ticked is enough. You can skip this and add it later in Settings.</p>`;
      foot = back + (S.phOk ? next(true) : '<span><button class="tfp-b" data-act="swskip">Skip</button></span>');
    } else if (cur === 'days') {
      title = 'How far back?';
      body = `<p>The first sync reads your Torn log back this far. Longer takes longer.</p>` + opt('swdays', 30, '30 days', 'Fast. Good to try it out.', S.days === 30) + opt('swdays', 90, '90 days', 'A few minutes. Recommended.', S.days === 90) + opt('swdays', 365, '1 year', 'Slower. Best if you flip a lot.', S.days === 365) + `<p class="tfp-sub">Change it any time in Settings.</p>`;
      foot = back + next(true);
    } else if (cur === 'weaver') {
      title = 'Weaver receipts (optional)';
      body = `<p>If you trade through Weaver (TornW3B), paste the key you registered there and receipts attach to your trades automatically.</p><input class="tfp-in" id="tfp-swweaver" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-lpignore="true" data-1p-ignore style="-webkit-text-security:disc" placeholder="TornW3B key (optional)">${S.wMsg ? '<div class="tfp-msg tfp-warn">' + esc(S.wMsg) + '</div>' : ''}<p class="tfp-sub">Stored only on this device, sent only to weav3r.dev. Your Torn key never goes there. TornExchange receipts need no key.</p>`;
      foot = back + '<span><button class="tfp-b" data-act="swskip">Skip</button> ' + next(true) + '</span>';
    } else {
      title = "You're set";
      body = `<p>Everything is saved on this device. Tap Sync to read your log.</p><div class="tfp-opt"><b class="tfp-pos">✓ Torn key</b></div>` + (usesPH() ? `<div class="tfp-opt"><b class="${sget('phkey', '') ? 'tfp-pos' : ''}">${sget('phkey', '') ? '✓ PawnHub key' : 'PawnHub on (no key yet: add it in Settings)'}</b></div>` : '') + `<div class="tfp-opt"><b>${esc(String(sget('startDays', 30)))} days</b> of history</div><p class="tfp-sub">Change any of this later in Settings. "Run setup again" is at the top of Settings.</p>`;
      foot = back + '<button class="tfp-b tfp-pri" data-act="swdone">⟳ Sync now</button>';
    }
    return `<div class="tfp-hd"><span><b>💰 Arbitrage</b> <span class="tfp-sub">v${VERSION}</span></span><button class="tfp-b" data-act="close">✕</button></div><div class="tfp-body tfp-wiz">${dots}<h3 class="tfp-wt">${title}</h3>${body}</div><div class="tfp-wfoot">${foot}</div>`;
  }
  async function setupAction(act, v, el) {
    const S = ui.setup; if (!S) return false;
    if (S.busy) return true; // one check at a time: ignore taps and stray events while it runs
    const steps = swSteps();
    const go = d => { S.i = Math.max(0, Math.min(steps.length - 1, S.i + d)); S.msg = ''; S.phMsg = ''; S.wMsg = ''; sset('setupStep', S.i); };
    if (act === 'swnext') {
      if (steps[S.i] === 'weaver') { const k = val('tfp-swweaver').trim(); if (k) { if (!/^[A-Za-z0-9_-]{8,64}$/.test(k)) { S.wMsg = 'That does not look like a TornW3B key. Check it, or Skip.'; return true; } sset('w3bkey', k); w3bFlagSet(true); } }
      go(1); return true;
    }
    if (act === 'swback') { go(-1); return true; }
    if (act === 'swskip') { go(1); return true; }
    if (act === 'swcustom') { S.torn = 'custom'; S.tornOk = false; S.msg = ''; return true; }
    if (act === 'swpda') {
      S.torn = 'pda'; S.tornOk = false; S.msg = 'Checking PDA\'s key…'; S.busy = true; render();
      const r = await checkTornKey(PDA_KEY); S.busy = false;
      if (r.ok) { sset('apikey', ''); S.tornOk = true; S.tornName = r.name; S.msg = '✓ PDA\'s key can read your log' + (r.name ? ' (' + r.name + ')' : '') + '.'; }
      else S.msg = 'PDA\'s key cannot read your log (' + r.msg + '). Use a custom key instead.';
      return true;
    }
    if (act === 'swcheck') {
      const k = val('tfp-swkey').trim(); if (!k) { S.msg = 'Paste your key first.'; return true; }
      if (!/^[A-Za-z0-9]{12,32}$/.test(k)) { S.msg = 'That does not look like a Torn API key.'; return true; }
      S.busy = true; S.msg = 'Checking…'; render();
      const r = await checkTornKey(k); S.busy = false;
      if (r.ok) { sset('apikey', k); S.tornOk = true; S.tornName = r.name; S.msg = '✓ Key works: it can read your log' + (r.name ? ' (' + r.name + ')' : '') + '.'; }
      else { S.tornOk = false; S.msg = r.msg; }
      return true;
    }
    if (act === 'swph') { S.ph = v === 'yes'; sset('usePH', S.ph); if (!S.ph) S.phOk = false; return true; }
    if (act === 'swphcheck') {
      const k = val('tfp-swph').trim(); if (!k) { S.phMsg = 'Paste your PawnHub key first.'; return true; }
      if (!/^[A-Za-z0-9]{12,32}$/.test(k)) { S.phMsg = 'That does not look like a Torn API key.'; return true; }
      S.busy = true; S.phMsg = 'Checking…'; render();
      const r = await checkPawnKey(k); S.busy = false;
      if (r.ok) { sset('phkey', k); phFlagSet(true); S.phOk = true; S.phMsg = '✓ PawnHub accepted the key.'; } else { S.phOk = false; S.phMsg = r.msg; }
      return true;
    }
    if (act === 'swdays') { S.days = Number(v); sset('startDays', S.days); return true; }
    if (act === 'swdone') {
      sset('setupDone', true); sset('setupStep', 0); ui.setup = null; ui.tab = 'profit'; ui.msg = '';
      if (ui.busy) return true;
      ui.busy = true; render();
      try { ui.msg = await syncAll(); } finally { ui.busy = false; }
      return true;
    }
    return false;
  }
  const card0 = () => document.querySelector('#tfp-card .tfp-body') || {};
  const navPush = () => { ui.nav = ui.nav || []; ui.nav.push({ tab: ui.tab, itemLog: ui.itemLog || null }); if (ui.nav.length > 20) ui.nav.shift(); };
  function render() {
    const card = document.getElementById('tfp-card');
    if (!card) return;
    ui._res = null; setTimeout(updateBtn, 0);
    if (!booted) { card.className = ''; card.innerHTML = '<div class="tfp-body"><div class="tfp-sub" style="padding:20px">Loading…</div></div>'; return; }
    if (!ui.setup && !setupDone()) startSetup(false);
    if (ui.setup) { card.className = 'tfp-setup'; card.innerHTML = setupHtml(); return; }
    card.className = '';
    const a = attention(), badge = a.pend.length + a.skip.length;
    const tabs = [['profit', '💰', 'Profit'], ['receipts', '🧾', 'Receipts'], ['items', '📊', 'Items'], ['settings', '⚙️', 'Settings']];
    const back = ui.nav && ui.nav.length, old = card.querySelector('.tfp-body'), keep = old ? old.scrollTop : 0;
    const fab = ui.tab === 'profit' || ui.tab === 'receipts' || ui.tab === 'items' ? `<button class="tfp-fab" data-act="sync">${ui.busy ? 'Syncing…' : state.resume ? 'Continue' : '⟳ Sync'}</button>` : '';
    card.innerHTML = `<div class="tfp-hd"><span>${back ? '<button class="tfp-b" data-act="back">‹ Back</button> ' : ''}<b>💰 Arbitrage</b> <span class="tfp-sub">v${VERSION}</span></span><span><button class="tfp-b tfp-hsync" data-act="sync">${ui.busy ? 'Syncing…' : state.resume ? 'Continue' : '⟳ Sync'}</button> <button class="tfp-b" data-act="close">– minimise</button></span></div>
      <div class="tfp-body">${lastSaveOk ? '' : '<div class="tfp-msg tfp-warn">⚠️ Could not save your data on this device (storage may be full). Export a backup in Settings.</div>'}
      ${phPreviewHtml()}${ui.msg ? `<div class="tfp-msg">${esc(ui.msg)}</div>` : ''}
      ${ui.itemLog && ui.tab === 'profit' ? ledgerHtml() : ''}${ui.tab === 'profit' ? profitHtml() : ui.tab === 'items' ? itemsHtml() : ui.tab === 'receipts' ? receiptsHtml() : settingsHtml()}</div>${fab}
      <div class="tfp-nav">${tabs.map(t => `<button class="${ui.tab === t[0] ? 'on' : ''}" data-act="tab" data-v="${t[0]}"><i>${t[1]}${t[0] === 'settings' && badge ? '<span class="tfp-bdg">' + badge + '</span>' : ''}</i>${t[2]}</button>`).join('')}</div>`;
    const nb = card.querySelector('.tfp-body'); if (nb) nb.scrollTop = keep;
    if (ui.tab === 'profit' && !ui.busy && (ui.visTx || []).length) setTimeout(fetchNames, 400);
  }
  function toast(msg) {
    let t = document.getElementById('tfp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'tfp-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };

  const inboxBrief = list => list.map(rc => ({ s: rc.source || '', u: rc.url || '', t: rc.total != null ? rc.total : null, n: rc.events ? rc.events.length : 0, i: (rc.items || []).slice(0, 3).map(i => i.qty + '× ' + i.name).join(', ') + ((rc.items || []).length > 3 ? ' +' + ((rc.items || []).length - 3) : ''), e: rc.lastErr || '', id: rc.tradeId || null }));
  let inboxBusy = false;
  // force: also retry receipts that were put on hold (their trade was not in the log yet, or a read failed). Held ones are retried by Sync or every few minutes, and never re-announced.
  async function processInbox(force) {
    if (inboxBusy) return '';
    inboxBusy = true;
    try {
      const inbox = await inboxGet(), keep = [], now = Math.floor(Date.now() / 1000);
      let last = '', changed = false;
      const phApi = await phKeyOn();
      for (const rc of inbox) {
        if (phApi && rc.source === 'pawnhub-balance') { changed = true; continue; } // the PawnHub API covers the Balance page: drop it quietly
        if (!force && rc.nextTry && rc.nextTry > now) { keep.push(rc); continue; }
        try {
          const msg = await handleReceipt(rc);
          if (/^No matching trade/.test(msg)) {
            ui.pendingReceipt = null; ui.candidates = [];
            if ((rc.tries || 0) < 50) { keep.push(Object.assign(rc, { tries: (rc.tries || 0) + 1, nextTry: now + 600 })); if (!rc.told) { rc.told = 1; last = 'Receipt saved. Its trade is not in your log yet; it will attach by itself after a later sync.'; } }
          } else last = msg;
        } catch (e) {
          const msg = String(e.message || e);
          if (!/match item name/i.test(msg)) { keep.push(Object.assign(rc, { nextTry: now + 180 })); if (rc.lastErr !== msg) { rc.lastErr = msg; last = msg; } } // unreadable names are a stale parse: drop it and re-add from the page
          else last = msg;
        }
        changed = true;
      }
      if (changed || keep.length !== inbox.length) await inboxSet(keep);
      ui.inboxN = keep.length; ui.inboxList = inboxBrief(keep);
      return last;
    } finally { inboxBusy = false; }
  }
  // Receipts saved from a receipt page are picked up when you come back to Torn.
  // A receipt page can hand its data over in the address (#tfp=...): add it, run it, tidy the address.
  async function importFromHash() {
    const m = location.hash.match(/^#tfp=([A-Za-z0-9_.-]+)$/);
    if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* keep the hash */ }
    try {
      const rc = await unpackReceipt(m[1]);
      ui.msg = '📥 ' + await handleReceipt(rc);
      state.lastInbox = { at: Math.floor(Date.now() / 1000), msg: ui.msg.slice(0, 700) }; save();
    } catch (e) { ui.msg = 'Could not read the receipt that was sent: ' + String(e.message || e); }
    ui.tab = 'receipts'; ui.open = true;
    const wrap = document.getElementById('tfp-wrap'); if (wrap) wrap.classList.add('open');
    render(); toast(ui.msg.slice(0, 160));
  }
  // Once reading the Balance page in the background has worked (Receipts → Read PawnHub Balance now, desktop browsers only), repeat it quietly while Torn is open.
  let pawnRunning = false;
  async function autoPawnhub() {
    if (!setupDone()) return;
    if (IS_PDA_ENV || pawnRunning || ui.busy || document.hidden || !sget('pawnhubAuto', false)) return;
    const now = Math.floor(Date.now() / 1000);
    if (now - (state.pawnAt || 0) < 30 * 60) return;
    state.pawnAt = now; pawnRunning = true;
    try { const r = await readPawnHubBalance(); if (r.valued) { toast('PawnHub: ' + r.valued + ' payment' + (r.valued === 1 ? '' : 's') + ' matched'); if (ui.open) render(); } }
    catch (e) { /* quiet: the next try is in 30 minutes */ }
    finally { pawnRunning = false; save(); }
  }
  async function autoInbox() {
    if (!setupDone()) return;
    if (inboxBusy || !(hasGM || nat())) return;
    const queued = await inboxGet(); ui.inboxN = queued.length; ui.inboxList = inboxBrief(queued);
    const nowS = Math.floor(Date.now() / 1000);
    if (!queued.length || queued.every(r => r.nextTry && r.nextTry > nowS)) return;
    try { ui.msg = await processInbox(); } catch (e) { ui.msg = String(e.message || e); }
    if (!ui.msg) return;
    state.lastInbox = { at: Math.floor(Date.now() / 1000), msg: String(ui.msg || '').slice(0, 700) }; save();
    if (ui.msg) { ui.msg = '📥 ' + ui.msg; toast(ui.msg.slice(0, 160)); if (ui.open) render(); }
  }
  async function onAction(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id, v = el.dataset.v;
    if (act === 'edit' || act === 'toggle' || act === 'tab' || act === 'ledgermore' || act === 'more' || act === 'imore' || act === 'rmore' || act === 'pawnoff' || act === 'itemlog' || act === 'itemlogclose') e.preventDefault();
    ui.msg = ''; ui._res = null;
    if (/^sw(next|back|skip|custom|pda|check|ph|phcheck|days|done)$/.test(act)) { e.preventDefault(); try { await setupAction(act, v, el); } catch (err) { if (ui.setup) { ui.setup.busy = false; ui.setup.msg = String(err.message || err); } } render(); return; }
    if (act === 'runsetup') { e.preventDefault(); startSetup(true); render(); return; }
    if (act !== 'giftall') ui.armGift = false;
    if (act !== 'giftolder') ui.armOlder = false;
    if (act !== 'ackall') ui.armAck = false;
    try {
      if (act === 'close') ui.open = false, document.getElementById('tfp-wrap').classList.remove('open');
      else if (act === 'tab') { if (v !== ui.tab) navPush(); ui.tab = v; ui.editing = null; ui.itemLog = null; ui.limit = 10; card0().scrollTop = 0; }
      else if (act === 'back') { const b = (ui.nav || []).pop(); if (b) { ui.tab = b.tab; ui.itemLog = b.itemLog; ui.editing = null; card0().scrollTop = 0; } }
      else if (act === 'home') { ui.nav = []; ui.tab = 'profit'; ui.itemLog = null; ui.editing = null; card0().scrollTop = 0; }
      else if (act === 'range') { ui.range = /^\d+$/.test(el.value) ? Number(el.value) : el.value; if (ui.range === 'custom' && !ui.from) { ui.from = ui.to = dayStr(Date.now() / 1000); sset('rangeFrom', ui.from); sset('rangeTo', ui.to); } sset('range', ui.range); }
      else if (act === 'rangefrom') { ui.limit = 10; ui.from = el.value; if (!ui.to || ui.to < ui.from) ui.to = ui.from; sset('rangeFrom', ui.from); sset('rangeTo', ui.to); }
      else if (act === 'rangeto') { ui.limit = 10; ui.to = el.value; if (ui.from && ui.to < ui.from) ui.from = ui.to; sset('rangeFrom', ui.from); sset('rangeTo', ui.to); }
      else if (act === 'toggle') ui[v] = !ui[v];
      else if (act === 'rangeset') { ui.limit = 10; ui.ilimit = 25; ui.range = /^\d+$/.test(v) ? Number(v) : v; if (ui.range === 'custom' && !ui.from) { ui.from = ui.to = dayStr(Date.now() / 1000); sset('rangeFrom', ui.from); sset('rangeTo', ui.to); } sset('range', ui.range); }
      else if (act === 'ack' || act === 'unack') { state.ack = state.ack || {}; state.ack[id] = act === 'ack' ? 1 : 0; save(); }
      else if (act === 'ackall') {
        if (!ui.armAck) ui.armAck = true;
        else { const a = attention(); state.ack = state.ack || {}; a.pend.forEach(t => { state.ack[t.id] = 1; }); a.skip.forEach(f => { state.ack[f.tx.id] = 1; }); save(); ui.armAck = false; }
      }
      else if (act === 'itemlog') { if (ui.tab === 'items') ui.itemLog = String(ui.itemLog) === String(id) ? null : id; else { navPush(); ui.tab = 'profit'; ui.itemLog = id; card0().scrollTop = 0; } }
      else if (act === 'more') ui.limit = (ui.limit || 10) + 10;
      else if (act === 'ledgermore') ui.ledgerAll = !ui.ledgerAll;
      else if (act === 'imore') ui.ilimit = (ui.ilimit || 25) + 25;
      else if (act === 'rmore') ui.rlimit = (ui.rlimit || 10) + 10;
      else if (act === 'itemsby') { ui.itemsBy = v; ui.ilimit = 25; }
      else if (act === 'itemlogclose') ui.itemLog = null;
      else if (act === 'clearval') { const tx = state.txs[id]; tx.amount = null; tx.gift = false; tx.src = null; tx.locked = false; ui.editing = null; save(); }
      else if (act === 'useph') { sset('usePH', !!el.checked); ui.msg = el.checked ? 'PawnHub on: sends are valued from PawnHub.' : 'PawnHub off: item sends are left empty.'; }
      else if (act === 'savephkey') {
        const k = val('tfp-phkey').trim();
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(k)) throw new Error('That does not look like a Torn API key.');
        sset('phkey', k); phFlagSet(true); ui.msg = 'PawnHub key saved on this device. Tap Sync to read it.';
      }
      else if (act === 'clearphkey') { sset('phkey', ''); phFlagSet(false); ui.msg = 'PawnHub key removed from this device.'; }
      else if (act === 'phapply') {
        const p = ui.phPreview; ui.phPreview = null;
        if (p) { ui.msg = await applyPawnHubBalance(p.rc); state.phFirstDone = true; state.phAt = Math.floor(Date.now() / 1000); save(); }
      }
      else if (act === 'phcancel') { ui.phPreview = null; ui.msg = 'Okay, nothing changed. PawnHub will ask again on the next Sync.'; }
      else if (act === 'savew3b') {
        const k = val('tfp-w3b').trim();
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(k)) throw new Error('That does not look like a TornW3B key.');
        sset('w3bkey', k); w3bFlagSet(true); ui.msg = 'TornW3B key saved on this device.';
      }
      else if (act === 'clearw3b') { sset('w3bkey', ''); w3bFlagSet(false); ui.msg = 'TornW3B key removed from this device.'; }
      else if (act === 'pawnhub') {
        if (ui.busy) return;
        ui.busy = true; render();
        try { const r = await readPawnHubBalance(); ui.msg = r.valued ? r.valued + ' PawnHub payment' + (r.valued === 1 ? '' : 's') + ' matched. Sync now reads it too.' : 'Read the Balance page: nothing new to match. Sync now reads it too.'; state.lastSyncDetail = Object.assign({}, state.lastSyncDetail, { pawnhub: r.text }); save(); } finally { ui.busy = false; }
      }
      else if (act === 'pawnoff') { sset('pawnhubAuto', false); ui.msg = 'Sync will no longer read the PawnHub Balance page.'; }
      else if (act === 'profitaudit') { ui.audit = profitAudit(); ui.more = true; }
      else if (act === 'tradelookup') { ui.tradeInfo = tradeLookup(val('tfp-tq')); ui.more = true; }
      else if (act === 'w3bcheck') {
        if (ui.busy) return;
        ui.busy = true; ui.w3bReport = null; render();
        try { ui.w3bReport = await weaverAudit(); } finally { ui.busy = false; }
      }
      else if (act === 'w3bimport') {
        if (ui.busy) return;
        ui.busy = true; render();
        try { const r = await weaverImport(); state.lastSyncDetail = Object.assign({}, state.lastSyncDetail, { weaver: r.text }); ui.msg = r.attached ? r.attached + ' receipt' + (r.attached === 1 ? '' : 's') + ' attached' + (r.left ? ' · tap again for more' : '') : r.left ? 'More receipts waiting: tap again.' : 'Up to date.'; } finally { ui.busy = false; }
      }
      else if (act === 'setting') { const d = document.getElementById('tfp-days'); if (d) sset('startDays', Number(d.value) || 30); }
      else if (act === 'edit') ui.editing = ui.editing === id ? null : id;
      else if (act === 'dir') state.txs[id].dir = v, save();
      else if (act === 'saveval') {
        const n = firstNumber(val('tfp-val-' + id));
        if (n == null) throw new Error('Enter a number.');
        const tx = state.txs[id]; tx.amount = n; tx.gift = false; tx.src = 'manual'; tx.locked = true; ui.editing = null; save();
      }
      else if (act === 'giftolder') {
        if (!ui.armOlder) { ui.armOlder = true; render(); return; }
        ui.armOlder = false;
        computeFlips(state.txs, flipOpts()).pending.filter(t => t.channel === 'send' && t.dir === 'sell' && state.pawnhubSince && t.ts < state.pawnhubSince - PH_LAG).forEach(t => { const x = state.txs[t.id]; x.amount = 0; x.gift = true; x.src = 'manual'; x.locked = true; });
        save();
      }
      else if (act === 'giftall') {
        if (!ui.armGift) { ui.armGift = true; render(); return; }
        ui.armGift = false;
        computeFlips(state.txs, flipOpts()).pending.filter(t => t.channel === 'send' || t.channel === 'recv').forEach(t => { const x = state.txs[t.id]; x.amount = 0; x.gift = true; x.src = 'manual'; x.locked = true; });
        save();
      }
      else if (act === 'gift') { const tx = state.txs[id]; tx.amount = 0; tx.gift = true; tx.src = 'manual'; tx.locked = true; save(); }
      else if (act === 'usemoney') {
        const m = state.moneyEvents[v], tx = state.txs[id];
        if (!m || !tx) throw new Error('That payment is no longer available.');
        tx.amount = m.amount; tx.gift = false; tx.src = 'manual'; tx.locked = true; save();
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
        if (act === 'resync') { state.lastSync = 0; state.seenTitles = {}; state.tradeParts = {}; state.sendParts = {}; state.moneyEvents = {}; state.listEvents = {}; state.resume = null; save(); }
        if (ui.busy) return;
        { const d = document.getElementById('tfp-days'); if (d) sset('startDays', Number(d.value) || 30); }
        ui.busy = true; render();
        try { ui.msg = await syncAll(); }
        finally { ui.busy = false; }
      }
      else if (act === 'addrc') { ui.msg = await addReceiptInput(val('tfp-rc')); }
      else if (act === 'attach') { attachReceipt(ui.pendingReceipt, state.txs[id]); ui.pendingReceipt = null; ui.candidates = []; ui.msg = 'Receipt attached.'; }
      else if (act === 'newtrade') { createFromReceipt(ui.pendingReceipt); ui.pendingReceipt = null; ui.candidates = []; ui.msg = 'Added as a new trade.'; }
      else if (act === 'inbox') ui.msg = (await processInbox(true)) || 'Nothing new to add.';
      else if (act === 'export') { const t = document.getElementById('tfp-bk'); t.value = JSON.stringify(state); await copyText(t.value); ui.msg = 'Exported (also copied).'; render(); document.getElementById('tfp-bk').value = JSON.stringify(state); return; }
      else if (act === 'import') {
        const incoming = JSON.parse(val('tfp-bk'));
        if (!incoming || !incoming.txs) throw new Error('That does not look like a backup.');
        if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'Tap again to replace data'; return; }
        state = incoming; save(); ui.msg = 'Backup imported.';
      }
      else if (act === 'debug') {
        const tb = document.querySelector('#topHeaderBanner .toolbar, .header-buttons-wrapper');
        let cats = null; try { cats = await api('torn/logcategories'); } catch (e) { cats = String(e.message || e); }
        const sample = { version: VERSION, itemSample: state.itemSample || null, nameSample: state.nameSample || null, phApiSample: state.phApiSample || null, itemValueCount: Object.keys(itemValues).length, storage: { hasGM, hasIDB, idbErr, boot: bootInfo, lastSaveOk, stateBytes: JSON.stringify(state).length, gmBytes: hasGM ? String((() => { try { return GM_getValue(NS + 'state') || ''; } catch (e) { return 'err'; } })()).length : null, lsBytes: (() => { try { return (localStorage.getItem(NS + 'state') || '').length; } catch (e) { return 'err'; } })() }, syncInfo: lastSyncInfo, lastSyncDetail: state.lastSyncDetail || null, inboxWaiting: ui.inboxN || 0, nativeStorage: !!nat(), lastInbox: state.lastInbox || null, lastInboxDetail: state.lastInboxDetail || null, lastError: state.lastError || null, resume: state.resume || null, txCount: Object.keys(state.txs).length, pendingCount: computeFlips(state.txs, flipOpts()).pending.length, logCategories: cats, rawEntries: lastRaw, seenTitles: state.seenTitles, seenExamples: state.seenExamples, lastSync: state.lastSync, sampleTxs: Object.values(state.txs).slice(-5), headerPath: tb ? [tb.tagName, tb.id, tb.className, tb.parentElement && tb.parentElement.className].join(' | ') : null };
        const ok = await copyText(JSON.stringify(sample, null, 1));
        ui.msg = ok ? 'Debug sample copied. Paste it to Claude.' : 'Could not copy. Sync first, then try again.';
      }
    } catch (err) { ui.msg = String(err.message || err); }
    render();
    if (act === 'toggle' && /^tx_/.test(v || '') && ui[v]) fetchNames();
  }

  bootP.then(() => { migrateSetup(); booted = true; updateBtn(); setInterval(updateBtn, 30000); if (ui.open) render(); });
  function openPanel() { ui.open = true; document.getElementById('tfp-wrap').classList.add('open'); render(); bootP.then(() => render()); }
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

  // Today's profit shown on the button itself (green up, red down, grey at 0; amber dot when something needs attention).
  const shortMoney = n => { const a = Math.abs(n); return a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a)); };
  function updateBtn() {
    const b = document.getElementById('tfp-btn'); if (!b || !booted) return;
    try {
      const today = Math.floor(Date.now() / 86400000) * 86400, p = getRes().flips.filter(f => f.profit != null && f.tx.ts >= today).reduce((a, f) => a + f.profit, 0), at = attention();
      const t = Math.round(p) === 0 ? '$0' : (p < 0 ? '−$' : '+$') + shortMoney(p);
      if (b.textContent !== t) b.textContent = t;
      b.classList.toggle('up', p > 0); b.classList.toggle('dn', p < 0); b.classList.toggle('zero', Math.round(p) === 0);
      b.classList.toggle('att', at.pend.length + at.skip.length > 0);
      b.title = 'Arbitrage · today ' + (p < 0 ? '−' : '+') + fmt(Math.abs(p));
    } catch (e) { /* keep the last text */ }
  }
  function mountTornUI() {
    if (!document.getElementById('tfp-style')) {
      const st = document.createElement('style'); st.id = 'tfp-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    if (!document.getElementById('tfp-wrap')) {
      const w = document.createElement('div'); w.id = 'tfp-wrap'; if (IS_PDA_ENV) w.classList.add('pda'); w.innerHTML = '<div id="tfp-card"></div>';
      w.addEventListener('click', ev => { if (ev.target === w) { w.classList.remove('open'); ui.open = false; } else if (!ev.target.closest('select, input, textarea')) onAction(ev); });
      const gprobe = ev => {
        const svg = ev.target && ev.target.closest ? ev.target.closest('svg.tfp-graph') : null; if (!svg) return;
        let g; try { g = JSON.parse(svg.getAttribute('data-g')); } catch (e) { return; }
        const r = svg.getBoundingClientRect(), n = g.v.length, x = r.width ? Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) : 1, i = Math.round(x * (n - 1)), px = n > 1 ? i / (n - 1) * 300 : 300;
        const ln = svg.querySelector('.gl'), dt = svg.querySelector('.gd'), cap = svg.parentNode.querySelector('.tfp-gcap');
        ln.setAttribute('x1', px); ln.setAttribute('x2', px); dt.setAttribute('cx', px); dt.setAttribute('cy', g.y[i]); ln.style.display = dt.style.display = '';
        if (cap) cap.textContent = g.l[i] + ' · running profit ' + (g.v[i] < 0 ? '−' : '+') + fmt(Math.abs(g.v[i]));
      };
      ['pointermove', 'pointerdown'].forEach(t => w.addEventListener(t, gprobe));
      ['change', 'input'].forEach(t => w.addEventListener(t, ev => { if (ev.target.matches('select[data-act]') || (t === 'change' && ev.target.matches('input[data-act]'))) onAction(ev); }));
      document.body.appendChild(w);
    }
    if (!document.getElementById('tfp-btn')) {
      const b = document.createElement('button'); b.id = 'tfp-btn'; b.textContent = '💰'; b.title = 'Arbitrage';
      const phone = window.innerWidth < 700, hw = !phone && document.querySelector('.header-buttons-wrapper');
      if (phone) { // phones: fixed spot, not draggable
        placeBtn(b, { left: 124, top: 4 });
        b.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); openPanel(); });
        ['mousedown', 'touchstart'].forEach(t => b.addEventListener(t, ev => ev.stopPropagation()));
        document.body.appendChild(b);
      } else if (hw) { // PC: in Torn's header icon row
        b.classList.add('hdr'); b.style.cssText = '';
        b.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); openPanel(); });
        hw.insertBefore(b, hw.firstChild);
      } else { // PC fallback if the header is not found: floating and draggable
        placeBtn(b, sget('btnpos2', null) || { left: Math.max(8, window.innerWidth - 110), top: 8 });
        attachDrag(b);
        document.body.appendChild(b);
      }
      updateBtn();
    }
  }

  /* ===================== receipt pages (tornexchange / weav3r) ===================== */
  let phOn = false;
  function mountReceiptButton() {
    const old = document.getElementById('tfp-rbtn');
    if (old && phOn && /z0cl\.eu$/i.test(location.hostname)) { old.remove(); return; }
    if (old) return;
    const onBalance = /(^|\.)z0cl\.eu$/i.test(location.hostname) && /^\/pawnhub\/balance\.php/i.test(location.pathname) && !phOn, onTE = /(^|\.)tornexchange\.com$/i.test(location.hostname);
    if (!onBalance && !onTE) return; // the manual button is only for the PawnHub Balance page and TornExchange (no API there); other receipt pages add themselves
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
      if (hasGM || nat()) { const inbox = (await inboxGet()).filter(x => x.url !== rc.url); inbox.push(rc); await inboxSet(inbox); msg = 'Saved. '; }
      const ok = await copyText(json);
      toast(msg + (ok ? 'Copied to clipboard too.' : 'Could not copy automatically.'));
    });
    document.body.appendChild(b);
  }

  /* ===================== init ===================== */
  function init() {
    if (/tornexchange\.com|weav3r\.dev|z0cl\.eu/.test(location.hostname)) {
      if (window.top !== window && /tfp-frame/.test(location.hash)) { // loaded by the tracker in a hidden frame: read the receipt and send it back
        try { window.parent.postMessage({ tfpHello: 1 }, '*'); } catch (e) { /* parent gone */ }
        let tries = 0, count = -1, stable = 0; const t = setInterval(() => {
          const rc = parseReceiptDoc(document, location.href.split('#')[0]);
          if (rc) {
            const n = rc.events ? rc.events.length : 0;
            if (n !== count) { count = n; stable = 0; } else stable++;
            if (!rc.events || stable >= 3) { clearInterval(t); try { window.parent.postMessage({ tfpReceipt: rc }, '*'); } catch (e) { /* parent gone */ } } // the Balance page fills in as it loads
          }
          if (++tries > 22) clearInterval(t);
        }, 1000);
        return;
      }
      const refreshBtn = () => phKeyOn().then(v => { phOn = v; mountReceiptButton(); });
      refreshBtn(); setInterval(refreshBtn, 3000);
      { // any receipt page you open is added by itself once it has loaded (nothing is sent anywhere; it is saved on this device)
        // The Balance page fills in as it loads, so keep re-reading it until the number of rows stops growing.
        let tries = 0, count = -1, stable = 0, banner = null;
        let busy = false;
        const t = setInterval(async () => {
          if (busy) return; busy = true;
          try {
          const rc = parseReceiptDoc(document, location.href.split('#')[0]);
          if (rc && rc.source === 'pawnhub-balance' && await phKeyOn()) { clearInterval(t); return; } // the PawnHub API already covers this page
          if (rc && rc.source === 'weaver' && await w3bKeyOn()) { clearInterval(t); return; } // the Weaver API already covers this receipt
          if (rc && (hasGM || nat())) {
            const n = rc.events ? rc.events.length : 0, grow = rc.source === 'pawnhub-balance';
            if (n !== count) {
              count = n; stable = 0;
              const inbox = (await inboxGet()).filter(x => x.url !== rc.url); inbox.push(rc); await inboxSet(inbox);
              if (!banner) { banner = document.createElement('div'); banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;font:14px Arial,sans-serif;padding:10px;text-align:center'; document.body.appendChild(banner); }
              banner.style.background = '#1b5e20';
              if (!banner.firstChild || banner.firstChild.nodeType !== 3) banner.insertBefore(document.createTextNode(''), banner.firstChild);
              banner.firstChild.textContent = '✅ Receipt read' + (grow ? ' (' + n + ' rows)' : '') + '. Tap to add it to Arbitrage:';
              if (!banner.querySelector('a')) { const go = document.createElement('a'); go.textContent = 'Send to Arbitrage ▸'; go.href = '#'; go.style.cssText = 'color:#fff;font-weight:bold;text-decoration:underline;margin-left:6px'; go.addEventListener('click', async ev => { ev.preventDefault(); try { location.href = 'https://www.torn.com/index.php#tfp=' + await packReceipt(rc); } catch (e) { go.textContent = ' could not prepare it'; } }); banner.appendChild(go); }
              banner.firstChild.textContent = banner.firstChild.textContent; // keep the text node in place when rows update
            }
            if (!grow || ++stable >= 5) clearInterval(t);
          } else if (++tries > 30 && count < 0) { clearInterval(t); if (/tfp-add/.test(location.hash)) toast("Couldn't read this receipt. Let the page finish loading, then tap the 💰 button."); }
          if (tries++ > 90) clearInterval(t);
          } catch (e) { /* try again on the next tick */ } finally { busy = false; }
        }, 1000);
      }
    } else {
      mountTornUI();
      setInterval(mountTornUI, 2500);
      bootP.then(() => { if (sget('phkey', '')) phFlagSet(true); if (sget('w3bkey', '')) w3bFlagSet(true); setTimeout(autoInbox, 2500); setTimeout(importFromHash, 1200); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) bootP.then(() => { // another page may have saved newer data while this one slept
        (hasIDB ? idb.get('state').catch(() => null) : Promise.resolve(sget('state', null))).then(st => { if (st && st.txs && (st.savedAt || 0) > lastWrite && !ui.busy) { const mine = state; state = mergeState(Object.assign(STATE_DEFAULTS(), st), mine); lastWrite = st.savedAt; if (ui.open) render(); } }).catch(() => {});
        autoInbox(); }); });
      // PDA keeps Torn in its own tab, and a tab you left may not report that it came back, so also look at the inbox every few seconds and when the page gets focus.
      setInterval(() => { if (!document.hidden) bootP.then(autoInbox); }, 4000);
      setTimeout(() => bootP.then(autoPawnhub), 60000); setInterval(() => bootP.then(autoPawnhub), 5 * 60 * 1000);
      window.addEventListener('focus', () => bootP.then(autoInbox));
      window.addEventListener('pageshow', () => bootP.then(autoInbox));
    }
  }

  if (typeof module !== 'undefined') {
    module.exports = { mergeState, LOG_RULES, parsePawnHubBalance, matchPawnHubEvents, buildSendTxs, parsePawnHub, buildTradeTxs, tradeIdOf, computeFlips, parseTornExchange, parseWeaver, roleFor, rankCandidates, parseLogEntry, firstNumber, parseTimeText };
  }
  if (typeof document !== 'undefined' && !globalThis.__TFP_TEST) init();
})();
