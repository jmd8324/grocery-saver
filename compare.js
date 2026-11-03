// CartCompare price comparison.
// Pure functions only (no page code), so they can be tested on their own.
// list.html loads this file and calls CartCompare.parseCSV() and CartCompare.compare().

var CartCompare = (function () {
  // ---------- CSV ----------
  // Reads a CSV file (as saved by Excel, Numbers or Google Sheets) into an
  // array of objects keyed by the header row. Handles quoted cells and commas.
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    text = String(text).replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

    const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    return rows
      .filter((r) => r.some((c) => c.trim() !== ''))
      .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
  }

  // "$3.49" -> 349 (cents). Blank or unreadable -> null.
  function toCents(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  }

  // ---------- Words ----------
  // Lowercase, drop punctuation, and make simple plurals singular so
  // "Bananas" matches "banana" and "paper towels" matches "paper towel".
  function norm(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
        : w.length > 3 && w.endsWith('oes') ? w.slice(0, -2)
        : w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
      .join(' ');
  }
  const splitList = (s) => String(s || '').split(';').map(norm).filter(Boolean);
  const words = (s) => s.split(' ');
  const containsAll = (big, small) => { const b = new Set(words(big)); return words(small).every((w) => b.has(w)); };

  // ---------- Amounts ----------
  const UNIT = {
    gal: ['gal', 1], gallon: ['gal', 1], quart: ['gal', 0.25], qt: ['gal', 0.25],
    lb: ['oz', 16], lbs: ['oz', 16], pound: ['oz', 16], oz: ['oz', 1], ounce: ['oz', 1],
    dozen: ['egg', 12], doz: ['egg', 12], egg: ['egg', 1],
    roll: ['roll', 1], ct: ['count', 1], count: ['count', 1],
  };
  const COUNT_WORDS = new Set(['x', 'pack', 'pk', 'bag', 'box', 'bottle', 'can', 'jar', 'loaf', 'carton',
    'head', 'bunch', 'each', 'ea', 'container', 'package', 'pkg', 'tub', 'block', 'piece', 'pc']);

  function parseAmount(s) {
    const m = String(s || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*([a-z]+)?/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return n > 0 ? { n, unit: m[2] ? norm(m[2]) : null } : null;
  }

  // How many of the priced size the shopper needs.
  // "2" or "2 bags" -> 2. "2 dozen" vs size "1 dozen" -> 2. "3 lb" vs "1 lb" -> 3.
  function multiplier(quantity, size) {
    const q = parseAmount(quantity);
    if (!q) return { mult: 1, sizeDiffers: false };
    if (!q.unit || COUNT_WORDS.has(q.unit) || !UNIT[q.unit]) return { mult: Math.max(1, Math.ceil(q.n)), sizeDiffers: false };
    const s = parseAmount(size);
    const qu = UNIT[q.unit];
    const su = s && s.unit && UNIT[s.unit];
    if (!su || su[0] !== qu[0]) return { mult: 1, sizeDiffers: true };
    return { mult: Math.max(1, Math.ceil((q.n * qu[1]) / (s.n * su[1]) - 1e-9)), sizeDiffers: false };
  }

  // ---------- Matching ----------
  function prepareRows(rows) {
    return rows.filter((r) => r.item).map((r) => ({
      raw: r,
      item: r.item,
      size: r.size || '',
      names: [norm(r.item), ...splitList(r.also_called)],
      brands: splitList(r.brand),
    }));
  }

  // Finds the price-sheet rows that can stand in for one list item.
  // Brand items only match rows with that brand. Generic items match every
  // row with that name (generic or branded), and the cheapest one wins per store.
  function matchRows(item, rows) {
    const name = norm(item.name);
    const brand = item.exactBrand && item.brand ? norm(item.brand) : null;
    const pool = brand ? rows.filter((r) => r.brands.includes(brand)) : rows;
    if (!name) return pool.length && brand ? pool : [];

    const exact = pool.filter((r) => r.names.includes(name));
    if (exact.length) return exact;
    // "Cheerios" typed on its own: the brand is the product.
    if (brand && name === brand) return pool;
    // "whole milk" with only "milk" on the sheet, or "eggs" vs "large eggs".
    let best = [], bestLen = 0;
    for (const r of pool) {
      for (const n of r.names) {
        if (containsAll(name, n) || containsAll(n, name)) {
          const len = words(n).length;
          if (len > bestLen) { best = [r]; bestLen = len; }
          else if (len === bestLen && !best.includes(r)) best.push(r);
        }
      }
    }
    return best;
  }

  // ---------- Compare ----------
  // items:   list items from the page ({ name, brand, quantity, exactBrand })
  // rows:    parsed prices.csv
  // stores:  stores.json "stores" entries (each with priceColumn)
  // options: { loyalty: [program ids], programs: stores.json loyaltyPrograms }
  function compare(items, csvRows, stores, options) {
    const rows = prepareRows(csvRows);
    const loyalty = new Set((options && options.loyalty) || []);
    const programs = Object.fromEntries(((options && options.programs) || []).map((p) => [p.id, p]));

    const skipped = [];
    const active = stores.filter((s) => {
      if (!s.priceColumn) return false;
      if (s.membershipRequired && !loyalty.has(s.loyalty)) {
        skipped.push({ store: s, reason: 'Needs a ' + ((programs[s.loyalty] || {}).name || 'membership') });
        return false;
      }
      return true;
    });

    const priceAt = (row, store) => {
      const regular = toCents(row.raw[store.priceColumn]);
      const member = loyalty.has(store.loyalty) ? toCents(row.raw[store.priceColumn + '_member']) : null;
      if (member != null && (regular == null || member < regular)) return { cents: member, member: true };
      return regular != null ? { cents: regular, member: false } : null;
    };

    const results = active.map((store) => ({ store, total: 0, found: 0, lines: [], missing: [] }));
    const unpriced = [];
    const dates = [];

    for (const item of items) {
      const matches = matchRows(item, rows);
      let pricedSomewhere = false;
      for (const res of results) {
        let best = null;
        for (const row of matches) {
          const p = priceAt(row, res.store);
          if (p && (!best || p.cents < best.price.cents)) best = { row, price: p };
        }
        if (!best) { res.missing.push(item); continue; }
        pricedSomewhere = true;
        const { mult, sizeDiffers } = multiplier(item.quantity, best.row.size);
        const cents = best.price.cents * mult;
        res.total += cents;
        res.found += 1;
        res.lines.push({ item, product: (best.row.brands.length ? best.row.raw.brand.split(';')[0].trim() + ' ' : '') + best.row.item,
          size: best.row.size, unitCents: best.price.cents, mult, cents, member: best.price.member, sizeDiffers });
        if (best.row.raw.checked_on) dates.push(best.row.raw.checked_on);
      }
      if (!pricedSomewhere) unpriced.push(item);
    }

    // Stores with more of the list priced come first; then cheapest total.
    const ranked = results.filter((r) => r.found > 0)
      .sort((a, b) => b.found - a.found || a.total - b.total);

    let savings = null;
    if (ranked.length > 1) {
      const peers = ranked.filter((r) => r.found === ranked[0].found);
      const priciest = peers[peers.length - 1];
      if (priciest !== ranked[0]) savings = { cents: priciest.total - ranked[0].total, vs: priciest.store };
    }

    dates.sort();
    return {
      ranked,
      noPrices: results.filter((r) => r.found === 0).map((r) => r.store),
      skipped,
      unpriced,
      itemCount: items.length,
      savings,
      checked: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    };
  }

  const money = (cents) => '$' + (cents / 100).toFixed(2);

  return { parseCSV, toCents, norm, multiplier, matchRows: (item, rows) => matchRows(item, prepareRows(rows)), compare, money };
})();
