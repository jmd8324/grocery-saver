// Vercel serverless function: POST /api/parse-list
// Turns a typed grocery list, or a photo/screenshot of one, into structured
// items using Claude. Body: { text: "..." } or { image: { media_type, data } }
// where data is base64 (no "data:" prefix).
//
// Needs the ANTHROPIC_API_KEY environment variable in Vercel.

import Anthropic from '@anthropic-ai/sdk';
import { overLimit, redisConfigured } from './_redis.js';
import { whoIs, accessStatus } from './_receipts.js';

const client = new Anthropic();

const MAX_TEXT = 5000;            // characters
const MAX_IMAGE_B64 = 4_000_000;  // ~3 MB image; the page shrinks photos well below this
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const SYSTEM = `You read grocery shopping lists for CartCompare, a price-comparison app.
Extract every grocery or household item the shopper wants to buy.

For each item return:
- name: the generic product, lowercase, without the brand (e.g. "ketchup", "whole milk", "paper towels").
- brand: ONLY if the shopper explicitly wrote a brand or a product that is itself a brand name
  (e.g. "Heinz ketchup" -> "Heinz"; "Cheerios" -> brand "Cheerios", name "cereal"; "Coke" -> brand "Coca-Cola", name "soda").
  Otherwise null. Do not guess a brand for generic words like "milk" or "eggs". Store-brand words
  like "store brand" or "generic" mean brand null.
- quantity: the amount or size if written (e.g. "2", "1 gallon", "2 dozen", "3 lb"), else null.
- original: the item exactly as written on the list.

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
        },
        required: ['name', 'brand', 'quantity', 'original'],
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
  // The list builder opens after sharing receipts (see api/_receipts.js).
  if (redisConfigured) {
    const status = await accessStatus(await whoIs(req)).catch(() => null);
    if (status && !status.open) {
      return res.status(403).json({ error: 'Share 2 receipts to use the list builder.', status });
    }
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
      system: SYSTEM,
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
    const items = Array.isArray(parsed.items) ? parsed.items.filter((i) => i && i.name) : [];

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
