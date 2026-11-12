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
  // "2 milk" ends with "milk"; "protein milk shake" does not.
  const endsWithWords = (big, small) => big !== small && (' ' + big).endsWith(' ' + small);

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
  //
  // item.matches (from the AI list reader) names every sheet product that
  // fits, so "milk" can match both "milk" and "2% milk". Without it (lists
  // typed before this existed), a general word also matches products that end
  // in that word: "milk" -> "2% milk", "cereal" -> "cereal".
  function matchRows(item, rows) {
    const name = norm(item.name);
    const brand = item.exactBrand && item.brand ? norm(item.brand) : null;
    const pool = brand ? rows.filter((r) => r.brands.includes(brand)) : rows;

    if (Array.isArray(item.matches) && item.matches.length) {
      const wanted = new Set(item.matches.map(norm));
      // Plus any row whose "also called" names are exactly what was typed.
      const picked = pool.filter((r) => wanted.has(norm(r.item)) || (name && r.names.includes(name)));
      if (picked.length) return picked;
    }
    if (!name) return pool.length && brand ? pool : [];

    const exact = pool.filter((r) => r.names.includes(name));
    // Kinds of the same thing: the row's name ends in the shopper's words.
    if (exact.length) return exact;
    // Nothing named that: products that end in the shopper's words ("milk" -> "2% milk").
    const kinds = pool.filter((r) => r.names.some((n) => endsWithWords(n, name)));
    if (kinds.length) return kinds;
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

  // Backup matches while the sheet has few prices: any row whose name has all
  // the typed words anywhere ("rice" -> "spanish rice sauce mix"). Used only
  // at a store where no real match has a price, and marked as "similar".
  function looseRows(item, rows) {
    const name = norm(item.name);
    if (!name) return [];
    const brand = item.exactBrand && item.brand ? norm(item.brand) : null;
    const pool = brand ? rows.filter((r) => r.brands.includes(brand)) : rows;
    const similar = pool.filter((r) => r.names.some((n) => containsAll(n, name)));
    // A brand item we have no exact product for ("Mr. Clean magic eraser"): any product of that brand.
    return similar.length || !brand ? similar : pool;
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
      // The AI reader already named every product that fits (item.matches), so the
      // loose "any row containing the word" guess is only for items without that
      // list. It was matching "milk" to a protein milk shake.
      const hasAiMatches = Array.isArray(item.matches) && item.matches.length > 0;
      const loose = hasAiMatches ? [] : looseRows(item, rows).filter((r) => !matches.includes(r));
      let pricedSomewhere = false;
      for (const res of results) {
        const cheapest = (list) => {
          let best = null;
          for (const row of list) {
            const p = priceAt(row, res.store);
            if (p && (!best || p.cents < best.price.cents)) best = { row, price: p };
          }
          return best;
        };
        let best = cheapest(matches);
        let similar = false;
        if (!best) { best = cheapest(loose); similar = Boolean(best); }
        if (!best) { res.missing.push(item); continue; }
        pricedSomewhere = true;
        const { mult, sizeDiffers } = multiplier(item.quantity, best.row.size);
        const cents = best.price.cents * mult;
        res.total += cents;
        res.found += 1;
        res.lines.push({ item, product: (best.row.brands.length ? best.row.raw.brand.split(';')[0].trim() + ' ' : '') + best.row.item,
          size: best.row.size, unitCents: best.price.cents, mult, cents, member: best.price.member, sizeDiffers, similar });
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


  // ---------- Distance and "where should I go?" ----------
  // Straight-line miles between two { lat, lng } points (not driving distance).
  function distanceMiles(a, b) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  }

  // Which store to shop at, given the shopper's distance to each.
  // Only stores that price as much of the list as the best one are compared,
  // since a store missing items always looks cheaper.
  //  1. Start from the cheapest store.
  //  2. If another store is MORE than half a mile closer than it and costs less than
  //     10% more than the cheapest, the saving isn't worth the longer trip: recommend
  //     the closest of those instead.
  //  3. Savings are always shown against the most expensive store.
  const BIG_PRICE_GAP = 0.10;
  const FAR_MILES = 0.5;

  function recommend(ranked, miles) {
    if (!ranked.length) return null;
    const tier = ranked.filter((r) => r.found === ranked[0].found && miles[r.store.id] != null);
    if (!tier.length) return null;
    const cheapest = tier.reduce((a, b) => (b.total < a.total ? b : a));
    const closest = tier.reduce((a, b) => (miles[b.store.id] < miles[a.store.id] ? b : a));
    const priciest = tier.reduce((a, b) => (b.total > a.total ? b : a));
    // Stores that are nearly as cheap as the cheapest but clearly closer to the shopper.
    const nearlyAsCheap = tier.filter((r) => r !== cheapest
      && r.total - cheapest.total < r.total * BIG_PRICE_GAP
      && miles[cheapest.store.id] - miles[r.store.id] > FAR_MILES);
    const pick = nearlyAsCheap.length ? nearlyAsCheap.reduce((a, b) => (miles[b.store.id] < miles[a.store.id] ? b : a)) : cheapest;
    const kind = pick === cheapest ? (pick === closest ? 'both' : 'cheapest') : 'closer';
    return {
      kind, pick, cheapest, closest, priciest,
      savingsVsPriciestCents: priciest.total - pick.total,       // what the pick saves vs the most expensive store
      extraCents: pick.total - cheapest.total,                   // what the pick costs over the cheapest
      milesSaved: miles[cheapest.store.id] - miles[pick.store.id], // how much closer the pick is than the cheapest
    };
  }

  const money = (cents) => '$' + (cents / 100).toFixed(2);

  return { parseCSV, toCents, norm, multiplier, matchRows: (item, rows) => matchRows(item, prepareRows(rows)), compare, money, distanceMiles, recommend };
})();
