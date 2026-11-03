// Vercel serverless function: POST /api/read-prices   (owner only)
// Reads prices from a photo of a receipt, shelf tag, weekly ad or store-app
// screenshot using Claude, and matches each line to a row of prices.csv.
// Nothing is saved here: the page shows the results for review first.
//
// Body: { image: { media_type, data }, rows: [{ item, brand, size }], stores: [{ id, name }] }

import Anthropic from '@anthropic-ai/sdk';
import { requireAdmin } from './_admin.js';
import { overLimit } from './_redis.js';

const client = new Anthropic();

const MAX_IMAGE_B64 = 4_000_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const SYSTEM = `You read grocery prices for CartCompare, a price-comparison site for State College, PA.
You get a photo of a receipt, shelf price tag, weekly ad, or a screenshot of a store's app or website,
plus the numbered rows of our price sheet. Extract every product with a price.

For each product return:
- text: the line as printed (receipt abbreviations kept, e.g. "GNT WHL MLK GAL").
- name: the plain generic product, lowercase (e.g. "whole milk").
- brand: the national brand if it is one (e.g. "Heinz", "Cheerios"), else null. Store brands
  (GIANT, Nature's Promise, Weis Quality, Wegmans, Good & Gather, Great Value, ALDI brands, Trader Joe's,
  Member's Mark, etc.) count as no brand: brand null.
- size: the package size if shown (e.g. "1 gallon", "32 oz"), else null.
- price: the regular shelf price for ONE unit, in dollars. For "2 @ 1.99" use 1.99. For "2 for $5" use 2.50.
  If only a sale or member price is shown, put it in member_price (or price if no card is needed) and leave the other null.
- member_price: the price for ONE unit with the store's free loyalty card, if shown (a card-savings line
  right under the item on a receipt, "with card" on a tag or ad). Ignore personal or manufacturer coupons. Else null.
- row: the number of the price-sheet row that is the same product, or null.
  A name-brand product only matches a row with that brand. A store-brand or generic product only matches a row with a blank brand.
  Match the row even if the size differs a little; we show the size for review.
- weight_priced: true if this is sold by weight (e.g. "1.32 lb @ 0.59/lb"); then price is the per-lb price.

Skip taxes, totals, subtotals, bag fees, bottle deposits, coupons, savings totals and non-product lines.
Also return:
- store: the id of the store from the given store list that this photo is from, or null if you can't tell.
- date: the date shown (YYYY-MM-DD), or null.
- kind: "receipt", "shelf_tag", "weekly_ad", "app_screenshot" or "other".`;

const SCHEMA = {
  type: 'object',
  properties: {
    store: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    kind: { type: 'string', enum: ['receipt', 'shelf_tag', 'weekly_ad', 'app_screenshot', 'other'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          size: { type: ['string', 'null'] },
          price: { type: ['number', 'null'] },
          member_price: { type: ['number', 'null'] },
          row: { type: ['integer', 'null'] },
          weight_priced: { type: 'boolean' },
        },
        required: ['text', 'name', 'brand', 'size', 'price', 'member_price', 'row', 'weight_priced'],
        additionalProperties: false,
      },
    },
  },
  required: ['store', 'date', 'kind', 'items'],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireAdmin(req, res)) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "The reader isn't set up yet (ANTHROPIC_API_KEY)." });
  }
  if (await overLimit(req, 'read-prices', 60, 60 * 60)) {
    return res.status(429).json({ error: 'That is a lot of photos this hour. Try again later.' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const { media_type: mediaType, data } = body.image || {};
  if (!IMAGE_TYPES.includes(mediaType) || typeof data !== 'string' || !data) {
    return res.status(400).json({ error: 'Please upload a JPG, PNG, WebP or GIF image.' });
  }
  if (data.length > MAX_IMAGE_B64) {
    return res.status(413).json({ error: 'That image is too large. Try a smaller photo or crop it.' });
  }
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
  const stores = Array.isArray(body.stores) ? body.stores.slice(0, 50) : [];
  const storeIds = new Set(stores.map((s) => String(s.id)));

  const sheetText = rows.map((r, i) => `${i}. ${clean(r.item)}${r.brand ? ' | brand: ' + clean(r.brand) : ''}${r.size ? ' | size: ' + clean(r.size) : ''}`).join('\n');
  const storeText = stores.map((s) => `${clean(s.id)}: ${clean(s.name)}`).join('\n');

  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: `Stores (id: name):\n${storeText}\n\nPrice sheet rows:\n${sheetText}\n\nRead the prices in this photo.` },
        ],
      }],
    });

    if (response.stop_reason === 'refusal') return res.status(422).json({ error: "We couldn't read that photo." });
    if (response.stop_reason === 'max_tokens') return res.status(413).json({ error: 'Too many items in one photo. Try photographing half at a time.' });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const parsed = safeParse(textBlocks.length ? textBlocks[textBlocks.length - 1].text : '');
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((i) => i && i.name && (i.price > 0 || i.member_price > 0))
      .map((i) => ({ ...i, row: Number.isInteger(i.row) && i.row >= 0 && i.row < rows.length ? i.row : null }));

    return res.status(200).json({
      store: storeIds.has(parsed.store) ? parsed.store : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : null,
      kind: parsed.kind || 'other',
      items,
    });
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError) {
      console.error('read-prices bad request:', error.message);
      return res.status(400).json({ error: "We couldn't read that file. Try a different photo." });
    } else if (error instanceof Anthropic.AuthenticationError) {
      return res.status(503).json({ error: 'The ANTHROPIC_API_KEY is not valid.' });
    } else if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Busy right now. Try again in a minute.' });
    } else if (error instanceof Anthropic.APIError) {
      console.error(`read-prices API error ${error.status}:`, error.message);
      return res.status(502).json({ error: 'The reader had a problem. Try again.' });
    }
    console.error('read-prices unexpected error:', error);
    return res.status(500).json({ error: 'Something went wrong reading that photo.' });
  }
}

const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, 100);

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
