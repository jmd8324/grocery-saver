// Vercel serverless function: POST /api/parse-list
// Turns a typed grocery list, or a photo/screenshot of one, into structured
// items using Claude. Body: { text: "..." } or { image: { media_type, data } }
// where data is base64 (no "data:" prefix).
//
// Needs the ANTHROPIC_API_KEY environment variable in Vercel.
//
// Claude also gets the product names on the price sheet and returns, for each
// list item, every sheet product that would do ("milk" -> milk, 2% milk), so a
// general word can match the cheapest option at each store.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseCSV } from '../sheet.js';
import { overLimit } from './_redis.js';
import { whoIs, accessStatus } from './_receipts.js';

const client = new Anthropic();

const MAX_TEXT = 5000;            // characters
const MAX_IMAGE_B64 = 4_000_000;  // ~3 MB image; the page shrinks photos well below this
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Unique product names from the price sheet (the "item" column), with brands
// seen for each, e.g. "cereal (Cheerios, Kashi, General Mills)".
function sheetProducts() {
  try {
    const { rows } = parseCSV(readFileSync(join(process.cwd(), 'prices.csv'), 'utf8'));
    const byItem = new Map();
    for (const r of rows) {
      const item = String(r.item || '').trim().toLowerCase();
      if (!item) continue;
      if (!byItem.has(item)) byItem.set(item, new Set());
      for (const b of String(r.brand || '').split(';')) if (b.trim()) byItem.get(item).add(b.trim());
      for (const a of String(r.also_called || '').split(';')) if (a.trim()) byItem.get(item).add('aka ' + a.trim());
    }
    return byItem;
  } catch (err) {
    console.error('parse-list: could not read prices.csv:', err.message);
    return new Map();
  }
}

const SYSTEM = `You read grocery shopping lists for CartCompare, a price-comparison app.
Extract every grocery or household item the shopper wants to buy.

For each item return:
- name: the product as the shopper described it, lowercase, without the brand. Keep general words
  general: "milk" stays "milk", "cereal" stays "cereal" (e.g. "ketchup", "whole milk", "paper towels").
- brand: ONLY if the shopper explicitly wrote a brand or a product that is itself a brand name
  (e.g. "Heinz ketchup" -> "Heinz"; "Cheerios" -> brand "Cheerios", name "cereal"; "Coke" -> brand "Coca-Cola", name "soda").
  Otherwise null. Do not guess a brand for generic words like "milk" or "eggs". Store-brand words
  like "store brand" or "generic" mean brand null.
- quantity: the amount or size if written (e.g. "2", "1 gallon", "2 dozen", "3 lb"), else null.
- original: the item exactly as written on the list.
- matches: every product name from the PRICE SHEET list below that would satisfy this item, so the
  app can pick the cheapest one. A general word matches all its kinds: "milk" -> "milk", "2% milk"
  (not "protein milk shake" or "chocolate chips"); "cereal" -> every cereal product; "cheese" ->
  sliced, shredded and block cheeses but not "cream cheese" or "cheese crackers". A specific item
  matches only that kind: "whole milk" -> "milk" only; "2% milk" -> "2% milk" only. Use the names
  exactly as written in the list. Empty if nothing on the sheet fits.

Fix obvious spelling mistakes in name. Skip headings, dates, prices, crossed-out or checked-off items,
and anything that is not something to buy. If the list is handwritten and a word is unreadable, make
your best guess. If there are no grocery items, return an empty list.`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          quantity: { type: ['string', 'null'] },
          original: { type: 'string' },
          matches: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'brand', 'quantity', 'original', 'matches'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('parse-list: ANTHROPIC_API_KEY is not set.');
    return res.status(503).json({ error: "The list reader isn't set up yet." });
  }

  // Each request costs money, so cap how often one visitor can call this.
  // The list builder is for Pro members (see api/_receipts.js).
  const status = await accessStatus(await whoIs(req)).catch(() => null);
  if (!status || !status.open) {
    return res.status(403).json({ error: 'Comparing your cart is a CartCompare Pro feature.', status });
  }

  if (await overLimit(req, 'parse-list', 30, 60 * 60)) {
    return res.status(429).json({ error: "You've read a lot of lists this hour. Please try again later." });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const content = [];

  if (body.image) {
    const { media_type: mediaType, data } = body.image;
    if (!IMAGE_TYPES.includes(mediaType) || typeof data !== 'string' || !data) {
      return res.status(400).json({ error: 'Please upload a JPG, PNG, WebP or GIF image.' });
    }
    if (data.length > MAX_IMAGE_B64) {
      return res.status(413).json({ error: 'That image is too large. Try a smaller photo or a screenshot.' });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    content.push({ type: 'text', text: 'Here is a photo or screenshot of my grocery list.' });
  } else if (typeof body.text === 'string' && body.text.trim()) {
    if (body.text.length > MAX_TEXT) {
      return res.status(413).json({ error: 'That list is too long. Try splitting it up.' });
    }
    content.push({ type: 'text', text: `Here is my grocery list:\n\n${body.text}` });
  } else {
    return res.status(400).json({ error: 'Send a list as text or an image.' });
  }

  const products = sheetProducts();
  const productList = [...products].map(([item, extra]) => (extra.size ? `${item} (${[...extra].join(', ')})` : item)).join('\n');

  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      system: [
        { type: 'text', text: SYSTEM },
        { type: 'text', text: 'PRICE SHEET products (name, then brands and other names):\n' + productList },
      ],
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: "We couldn't read that list." });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(413).json({ error: 'That list is too long. Try splitting it up.' });
    }

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const last = textBlocks[textBlocks.length - 1];
    const parsed = last ? safeParse(last.text) : {};
    const items = (Array.isArray(parsed.items) ? parsed.items.filter((i) => i && i.name) : [])
      .map((i) => ({ ...i, matches: (Array.isArray(i.matches) ? i.matches : [])
        .map((m) => String(m).trim().toLowerCase()).filter((m) => products.has(m)) }));

    return res.status(200).json({ items });
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError) {
      console.error('parse-list bad request:', error.message);
      return res.status(400).json({ error: "We couldn't read that file. Try a different photo." });
    } else if (error instanceof Anthropic.AuthenticationError) {
      console.error('parse-list: invalid ANTHROPIC_API_KEY');
      return res.status(503).json({ error: "The list reader isn't set up correctly." });
    } else if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'We are a little busy. Please try again in a minute.' });
    } else if (error instanceof Anthropic.APIError) {
      console.error(`parse-list API error ${error.status}:`, error.message);
      return res.status(502).json({ error: 'The list reader had a problem.' });
    }
    console.error('parse-list unexpected error:', error);
    return res.status(500).json({ error: 'Something went wrong reading your list.' });
  }
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
