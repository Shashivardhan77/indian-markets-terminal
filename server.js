// Indian Markets Terminal — standalone market terminal for Indian markets.
// Run: node server.js   (env PORT overrides, default 4173)
// Stack: Node.js built-in modules only (http, fs, path) + global fetch. No npm deps.
// Data is fetched at runtime from public sources; nothing is invented. If a source
// fails, the API returns an honest "unavailable" state instead of fabricated numbers.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '4173', 10);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CACHE_TTL_MS = 60 * 1000; // ~60s server-side cache
const cache = new Map(); // key -> { at, value }

// ---------- helpers ----------
function istFmt(d, opts) {
  const base = { timeZone: 'Asia/Kolkata', ...opts };
  return new Intl.DateTimeFormat('en-IN', base).format(d);
}
function istNow() {
  return istFmt(new Date(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
function istTime(epochSec) {
  if (!epochSec) return null;
  return istFmt(new Date(epochSec * 1000), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
  return await res.text();
}
function getCached(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < (e.ttl || CACHE_TTL_MS)) return e.value;
  return null;
}
function setCached(key, value, ttlMs) { cache.set(key, value, { at: Date.now(), value, ttl: ttlMs || CACHE_TTL_MS }); }

// ---------- NSE session (cookie warm-up) ----------
let nseCookies = '', nseCookieAt = 0;
async function nseSession() {
  if (nseCookies && Date.now() - nseCookieAt < 10 * 60 * 1000) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(12000),
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    nseCookies = sc.map(c => c.split(';')[0]).join('; ');
    nseCookieAt = Date.now();
  } catch (e) { /* session warm-up failure is non-fatal */ }
  return nseCookies;
}

// ---------- Yahoo Finance (chart endpoint works without auth) ----------
async function yahooChartRaw(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta) throw new Error('No data from Yahoo for ' + symbol);
  return result;
}
// Resolve a user-typed equity symbol to a Yahoo symbol: try .NS then .BO.
async function resolveEquitySymbol(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.startsWith('^') || raw.includes('=') || raw.includes('.')) {
    try { await yahooChartRaw(raw, '1d', '1d'); return raw; } catch (e) { return null; }
  }
  for (const sfx of ['.NS', '.BO']) {
    try { await yahooChartRaw(raw + sfx, '1d', '1d'); return raw + sfx; } catch (e) { /* try next */ }
  }
  return null;
}
function quoteFromMeta(symbol, meta) {
  const price = meta.regularMarketPrice;
  const prev = (meta.chartPreviousClose != null) ? meta.chartPreviousClose : meta.previousClose;
  const change = (price != null && prev != null) ? price - prev : null;
  const changePct = (change != null && prev) ? (change / prev) * 100 : null;
  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    available: price != null,
    price: price != null ? round2(price) : null,
    prevClose: prev != null ? round2(prev) : null,
    change: change != null ? round2(change) : null,
    changePct: changePct != null ? round2(changePct) : null,
    dayHigh: meta.regularMarketDayHigh != null ? round2(meta.regularMarketDayHigh) : null,
    dayLow: meta.regularMarketDayLow != null ? round2(meta.regularMarketDayLow) : null,
    yearHigh: meta.fiftyTwoWeekHigh != null ? round2(meta.fiftyTwoWeekHigh) : null,
    yearLow: meta.fiftyTwoWeekLow != null ? round2(meta.fiftyTwoWeekLow) : null,
    volume: meta.regularMarketVolume != null ? meta.regularMarketVolume : null,
    currency: meta.currency || 'INR',
    marketTime: istTime(meta.regularMarketTime),
    marketCap: null, // Yahoo's no-auth endpoints do not expose market cap
  };
}
function round2(x) { return Math.round(x * 100) / 100; }

// ---------- RSS parsing (ET + Livemint) ----------
function parseRss(xml, srcName, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const b = m[1];
    const pick = (tag) => {
      const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(b);
      if (!r) return null;
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    const title = pick('title'), link = pick('link'), pub = pick('pubDate') || pick('dc:date');
    if (title && link) items.push({ title: stripTags(title), link, source: srcName, published: pub || null });
  }
  return items;
}
function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

// ---------- data file helpers ----------
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
const WATCHLIST_FILE = path.join(DATA, 'watchlist.json');
const INSTRUCTIONS_FILE = path.join(DATA, 'instructions.json');
ensureDir(DATA);
if (!fs.existsSync(WATCHLIST_FILE)) {
  writeJson(WATCHLIST_FILE, [
    { symbol: 'RELIANCE', yahoo: 'RELIANCE.NS', name: 'Reliance Industries Ltd', addedAt: istNow() },
    { symbol: 'HDFCBANK', yahoo: 'HDFCBANK.NS', name: 'HDFC Bank Ltd', addedAt: istNow() },
    { symbol: 'TCS', yahoo: 'TCS.NS', name: 'Tata Consultancy Services', addedAt: istNow() },
    { symbol: 'INFY', yahoo: 'INFY.NS', name: 'Infosys Ltd', addedAt: istNow() },
    { symbol: 'SBIN', yahoo: 'SBIN.NS', name: 'State Bank of India', addedAt: istNow() },
    { symbol: 'ICICIBANK', yahoo: 'ICICIBANK.NS', name: 'ICICI Bank Ltd', addedAt: istNow() },
  ]);
}
if (!fs.existsSync(INSTRUCTIONS_FILE)) writeJson(INSTRUCTIONS_FILE, []);

// ---------- API handlers ----------
const NSE_WANT = ['NIFTY 50', 'NIFTY NEXT 50', 'NIFTY BANK', 'NIFTY FINANCIAL SERVICES', 'NIFTY IT', 'NIFTY MIDCAP 100', 'INDIA VIX'];
const YAHOO_INDEX = { SENSEX: '^BSESN' };

const YAHOO_INDEX_FALLBACK = {
  'NIFTY 50': '^NSEI', 'NIFTY BANK': '^NSEBANK', 'NIFTY FINANCIAL SERVICES': '^CNXFIN',
  'NIFTY IT': '^CNXIT', 'INDIA VIX': '^INDIAVIX',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchNseIndices() {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await nseSession();
      const text = await fetchText('https://www.nseindia.com/api/allIndices', {
        'Cookie': nseCookies, 'Referer': 'https://www.nseindia.com/', 'Accept': 'application/json',
      });
      const data = JSON.parse(text).data;
      if (Array.isArray(data) && data.length) return data;
      throw new Error('NSE returned no index data');
    } catch (e) { lastErr = e; if (attempt === 0) await sleep(800); }
  }
  throw lastErr || new Error('NSE unreachable');
}
async function apiIndices() {
  const key = 'api:indices';
  const cached = getCached(key);
  if (cached) return cached;
  const indices = [];
  const source = [];
  let pe = null, breadth = null, nseOk = false;
  try {
    const data = await fetchNseIndices();
    for (const want of NSE_WANT) {
      const row = data.find(r => (r.index || '').toUpperCase() === want);
      if (!row) continue;
      indices.push({
        name: row.index, last: row.last, change: row.variation, changePct: row.percentChange,
        open: row.open, high: row.high, low: row.low, yearHigh: row.yearHigh, yearLow: row.yearLow,
        source: 'NSE', asOf: istNow(),
      });
      if (want === 'NIFTY 50') {
        pe = row.pe || null;
        breadth = { advances: row.advances, declines: row.declines, unchanged: row.unchanged };
      }
    }
    if (indices.length) { nseOk = true; source.push('NSE India'); }
  } catch (e) { /* fall back to Yahoo for the indices it carries */ }
  if (!nseOk) {
    for (const want of NSE_WANT) {
      const ysym = YAHOO_INDEX_FALLBACK[want];
      if (!ysym) continue;
      try {
        const q = quoteFromMeta(ysym, (await yahooChartRaw(ysym, '1d', '1d')).meta);
        if (q.available) {
          indices.push({ name: want, last: q.price, change: q.change, changePct: q.changePct, source: 'Yahoo Finance', asOf: istNow() });
        }
      } catch (e) { /* skip this index */ }
    }
    if (indices.length && !source.includes('Yahoo Finance')) source.push('Yahoo Finance');
  }
  // Sensex comes from BSE (not in NSE's list) via Yahoo.
  try {
    const q = quoteFromMeta('^BSESN', (await yahooChartRaw('^BSESN', '1d', '1d')).meta);
    if (q.available) {
      indices.unshift({ name: 'S&P BSE SENSEX', last: q.price, change: q.change, changePct: q.changePct, source: 'Yahoo Finance', asOf: istNow() });
      if (!source.includes('Yahoo Finance')) source.push('Yahoo Finance');
    }
  } catch (e) { /* Sensex unavailable this round */ }
  const result = {
    source: source.length ? source.join(' + ') : 'No source reachable',
    asOf: istNow(),
    indices: indices.length ? indices : null,
    niftyPE: pe, breadth,
    degraded: !nseOk,
    note: nseOk ? null : 'NSE index feed unreachable this round; showing Yahoo-carried indices instead. P/E and breadth come only from NSE.',
  };
  setCached(key, result, nseOk ? CACHE_TTL_MS : 15000);
  return result;
}

async function apiQuotes(symbols) {
  const key = 'api:quotes:' + symbols.join(',');
  const cached = getCached(key);
  if (cached) return cached;
  const items = [];
  for (const sym of symbols) {
    try {
      const meta = (await yahooChartRaw(sym, '1d', '1d')).meta;
      const q = quoteFromMeta(sym, meta);
      q.asOf = istNow();
      items.push(q);
    } catch (e) {
      items.push({ symbol: sym, name: sym, available: false, error: 'Quote unavailable from Yahoo Finance right now.' });
    }
  }
  const result = { source: 'Yahoo Finance', asOf: istNow(), quotes: items };
  setCached(key, result);
  return result;
}

const RANGES = {
  '1D': { range: '1d', interval: '5m' },
  '5D': { range: '5d', interval: '15m' },
  '1M': { range: '1mo', interval: '1d' },
  '6M': { range: '6mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1wk' },
};
const ALIAS = { NIFTY: '^NSEI', SENSEX: '^BSESN', BANKNIFTY: '^NSEBANK', FINNIFTY: '^CNXFIN', INDIAVIX: '^INDIAVIX' };
function resolveChartSymbol(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return null;
  if (ALIAS[raw]) return ALIAS[raw];
  if (raw.startsWith('^') || raw.includes('=') || raw.includes('.')) return raw;
  return raw + '.NS';
}
async function apiChart(symbol, rangeKey) {
  const sym = resolveChartSymbol(symbol);
  if (!sym) throw new Error('No symbol given');
  const r = RANGES[rangeKey] || RANGES['1M'];
  const key = `api:chart:${sym}:${rangeKey}`;
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const res = await yahooChartRaw(sym, r.range, r.interval);
    const ts = res.timestamp || [];
    const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      points.push({ t: ts[i] * 1000, c: round2(c) });
    }
    if (!points.length) throw new Error('empty series');
    const result = {
      symbol: sym, range: rangeKey, points,
      prevClose: res.meta.chartPreviousClose != null ? round2(res.meta.chartPreviousClose) : null,
      currency: res.meta.currency || 'INR',
      source: 'Yahoo Finance', asOf: istNow(), available: true,
    };
    setCached(key, result);
    return result;
  } catch (e) {
    return { symbol: sym, range: rangeKey, available: false, source: 'Yahoo Finance', asOf: istNow(), error: 'Chart unavailable from Yahoo Finance right now.' };
  }
}

async function apiFno() {
  const key = 'api:fno';
  const cached = getCached(key);
  if (cached) return cached;
  const result = { source: 'NSE India', asOf: istNow(), futures: null, chain: null, underlying: null, pcr: null, available: false, errors: [] };
  await nseSession();
  // Futures via quote-derivative
  try {
    const text = await fetchText('https://www.nseindia.com/api/quote-derivative?symbol=NIFTY', {
      'Cookie': nseCookies, 'Referer': 'https://www.nseindia.com/', 'Accept': 'application/json',
    });
    const data = JSON.parse(text);
    const futs = (data.stocks || data.data || []).filter(x => x.metadata && x.metadata.instrumentType === 'FUTIDX');
    if (futs.length) {
      result.futures = futs.slice(0, 3).map(f => ({
        expiry: f.metadata.expiryDate || null,
        last: f.metadata.lastPrice != null ? f.metadata.lastPrice : null,
        change: f.metadata.netChange != null ? f.metadata.netChange : null,
        oi: f.metadata.openInterest != null ? f.metadata.openInterest : null,
        underlying: f.underlyingValue != null ? f.underlyingValue : null,
      }));
    }
  } catch (e) { result.errors.push('futures: ' + e.message); }
  // Options chain
  try {
    const text = await fetchText('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY', {
      'Cookie': nseCookies, 'Referer': 'https://www.nseindia.com/', 'Accept': 'application/json',
    });
    const data = JSON.parse(text);
    const rows = (data.records && data.records.data) || [];
    const spot = (data.records && data.records.underlyingValue) || null;
    result.underlying = spot;
    if (rows.length && spot) {
      const atm = rows.reduce((a, b) => Math.abs(b.strikePrice - spot) < Math.abs(a.strikePrice - spot) ? b : a);
      const idx = rows.indexOf(atm);
      const slice = rows.slice(Math.max(0, idx - 10), idx + 11);
      let ceOI = 0, peOI = 0;
      result.chain = slice.map(r => {
        const ce = r.CE || {}, pe = r.PE || {};
        ceOI += ce.openInterest || 0; peOI += pe.openInterest || 0;
        return {
          strike: r.strikePrice,
          ceOI: ce.openInterest || null, ceLTP: ce.lastPrice != null ? round2(ce.lastPrice) : null, ceChange: ce.change || null,
          peOI: pe.openInterest || null, peLTP: pe.lastPrice != null ? round2(pe.lastPrice) : null, peChange: pe.change || null,
          expiry: r.expiryDate || (data.records && data.records.expiryDates && data.records.expiryDates[0]) || null,
        };
      });
      if (ceOI > 0) result.pcr = round2(peOI / ceOI);
      result.expiry = result.chain[0] && result.chain[0].expiry;
      result.available = true;
    }
  } catch (e) { result.errors.push('options chain: ' + e.message); }
  if (!result.futures && !result.chain) {
    result.message = 'F&O data unavailable from NSE right now — the public NSE API is not responding from this server. Nothing here is estimated.';
  } else if (!result.chain) {
    result.message = 'Options chain unavailable from NSE right now; futures shown below are from NSE.';
    result.available = true;
  }
  setCached(key, result);
  return result;
}

async function apiFx() {
  const key = 'api:fx';
  const cached = getCached(key);
  if (cached) return cached;
  const pairs = ['USDINR=X', 'EURINR=X', 'GBPINR=X', 'JPYINR=X', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X'];
  const labels = { 'USDINR=X': 'USD/INR', 'EURINR=X': 'EUR/INR', 'GBPINR=X': 'GBP/INR', 'JPYINR=X': 'JPY/INR (per ¥1)', 'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD', 'USDJPY=X': 'USD/JPY' };
  const quotes = [];
  for (const s of pairs) {
    try {
      const q = quoteFromMeta(s, (await yahooChartRaw(s, '1d', '1d')).meta);
      quotes.push({ pair: labels[s], price: q.price, change: q.change, changePct: q.changePct, asOf: istNow() });
    } catch (e) {
      quotes.push({ pair: labels[s], available: false });
    }
  }
  let ecb = null;
  try {
    const xml = await fetchText('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    const date = (xml.match(/<Cube time='([^']+)'/) || [])[1] || null;
    const rates = {};
    const re = /<Cube currency='([A-Z]{3})' rate='([0-9.]+)'/g;
    let m;
    while ((m = re.exec(xml))) rates[m[1]] = parseFloat(m[2]);
    if (date && rates.INR) {
      ecb = {
        date,
        eurInr: round2(rates.INR),
        perEur: { USD: rates.USD || null, GBP: rates.GBP || null, JPY: rates.JPY || null, INR: rates.INR },
        source: 'ECB daily reference rates',
      };
    }
  } catch (e) { /* ECB optional */ }
  const result = { source: 'Yahoo Finance' + (ecb ? ' + ECB reference rates' : ''), asOf: istNow(), quotes, ecb };
  setCached(key, result);
  return result;
}

async function apiNews() {
  const key = 'api:news';
  const cached = getCached(key);
  if (cached) return cached;
  const feeds = [
    { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', name: 'Economic Times' },
    { url: 'https://www.livemint.com/rss/markets', name: 'Livemint' },
  ];
  let items = [];
  for (const f of feeds) {
    try {
      const xml = await fetchText(f.url);
      items = items.concat(parseRss(xml, f.name, 15));
    } catch (e) { /* one feed may fail; the other still shows */ }
  }
  items.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  const seen = new Set();
  items = items.filter(i => { if (seen.has(i.title)) return false; seen.add(i.title); return true; }).slice(0, 25);
  const result = {
    source: 'Economic Times RSS + Livemint RSS', asOf: istNow(),
    items: items.length ? items : null,
    message: items.length ? null : 'News feeds unavailable right now.',
  };
  setCached(key, result);
  return result;
}

async function apiWatchlist() {
  const list = readJson(WATCHLIST_FILE, []);
  const symbols = list.map(e => e.yahoo);
  const data = await apiQuotes(symbols);
  const bySymbol = {};
  for (const q of data.quotes) bySymbol[q.symbol] = q;
  return {
    source: data.source, asOf: data.asOf,
    rows: list.map(e => ({ ...(bySymbol[e.yahoo] || { available: false }), symbol: e.symbol, name: e.name || e.symbol, yahoo: e.yahoo, addedAt: e.addedAt })),
  };
}

// ---------- HTTP server ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(text);
}
function notFound(res) { sendText(res, 404, 'Not found', 'text/plain'); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return sendText(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html');
    }
    if (req.method === 'GET' && p.startsWith('/public/')) {
      const file = path.normalize(path.join(PUBLIC, p.slice('/public/'.length)));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return notFound(res);
      return sendText(res, 200, fs.readFileSync(file, 'utf8'), MIME[path.extname(file)] || 'text/plain');
    }
    // API
    if (req.method === 'GET' && p === '/api/indices') return sendJson(res, 200, await apiIndices());
    if (req.method === 'GET' && p === '/api/quotes') {
      const symbols = (u.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
      if (!symbols.length) return sendJson(res, 400, { error: 'symbols required' });
      return sendJson(res, 200, await apiQuotes(symbols));
    }
    if (req.method === 'GET' && p === '/api/chart') {
      return sendJson(res, 200, await apiChart(u.searchParams.get('symbol'), (u.searchParams.get('range') || '1M').toUpperCase()));
    }
    if (req.method === 'GET' && p === '/api/fno') return sendJson(res, 200, await apiFno());
    if (req.method === 'GET' && p === '/api/fx') return sendJson(res, 200, await apiFx());
    if (req.method === 'GET' && p === '/api/news') return sendJson(res, 200, await apiNews());
    if (req.method === 'GET' && p === '/api/watchlist') return sendJson(res, 200, await apiWatchlist());
    if (req.method === 'POST' && p === '/api/watchlist') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const resolved = await resolveEquitySymbol(body.symbol);
      if (!resolved) return sendJson(res, 400, { error: 'Unknown symbol: "' + body.symbol + '". Could not validate it against the quote source.' });
      const list = readJson(WATCHLIST_FILE, []);
      const base = resolved.replace(/\.NS$|\.BO$/, '');
      if (list.some(e => e.symbol === base)) return sendJson(res, 200, { ok: true, note: 'Already on the watchlist.' });
      list.push({ symbol: base, yahoo: resolved, name: base, addedAt: istNow() });
      writeJson(WATCHLIST_FILE, list);
      cache.delete('api:watchlist');
      return sendJson(res, 200, { ok: true, symbol: base });
    }
    if (req.method === 'DELETE' && p === '/api/watchlist') {
      const sym = (u.searchParams.get('symbol') || '').toUpperCase();
      const list = readJson(WATCHLIST_FILE, []).filter(e => e.symbol !== sym);
      writeJson(WATCHLIST_FILE, list);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/instructions') {
      return sendJson(res, 200, { instructions: readJson(INSTRUCTIONS_FILE, []) });
    }
    if (req.method === 'POST' && p === '/api/instructions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'Empty instruction.' });
      const list = readJson(INSTRUCTIONS_FILE, []);
      const entry = {
        id: 'ins_' + Date.now(),
        text,
        sentAt: istNow(),
        sentAtISO: new Date().toISOString(),
        status: 'received',
        steps: [{ t: istNow(), step: 'Instruction saved on this page' }],
        outcome: null,
      };
      list.push(entry);
      writeJson(INSTRUCTIONS_FILE, list);
      return sendJson(res, 201, entry);
    }
    return notFound(res);
  } catch (e) {
    sendJson(res, 500, { error: 'Server error: ' + e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Indian Markets Terminal running at http://localhost:' + PORT);
});
