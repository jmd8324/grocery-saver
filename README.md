# CartCompare

Same groceries, smaller bill. CartCompare has two sides:

- **Share a receipt** (`/upload.html`): anyone can upload a grocery receipt. Free, no account.
  Claude reads the prices, you approve them, and they go into the price sheet.
- **Compare your cart** (`/list.html`): build a shopping list and see which store has the cheapest total.
  Public during early access; a login can be added later.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The landing page: two big choices (share a receipt / compare your cart), how it works, and an email updates form. |
| `upload.html` | Public receipt upload. Shows the shopper what was read; prices wait for your approval. |
| `api/submit-receipt.js` | Reads a shopper's receipt with Claude and queues it for review. Keeps item names and prices only, never the photo. |
| `api/submissions.js` | Lists and clears the review queue (password protected). |
| `api/_reader.js` | Shared receipt-reading code used by both upload paths. |
| `list.html` | The list builder: ZIP code, type or upload a photo/screenshot of a list, review items, pick loyalty programs and stores. |
| `prices.csv` | The price sheet: one row per product, one column per store. Fill this in to power the comparison (see below). |
| `compare.js` | Matches list items to the price sheet, applies member prices and totals each store. |
| `update-prices.html` | Owner-only page: approve shopper receipts, or upload your own photo, and save the prices to `prices.csv`. |
| `sheet.js` | Reads, writes and updates `prices.csv` (shared by the update page and `api/save-prices.js`). |
| `api/read-prices.js` | Reads prices from a photo with Claude and matches them to sheet rows (password protected). |
| `api/save-prices.js` | Saves reviewed prices to `prices.csv` on GitHub, which redeploys the site (password protected). |
| `stores.json` | The State College, PA stores and loyalty programs shown on the list builder. Edit this to add or fix stores. |
| `styles.css` | Colors and styles shared by every page (light and dark mode). |
| `api/waitlist.js` | Saves waitlist emails to the database. |
| `api/parse-list.js` | Reads a typed list or a photo/screenshot of one using Claude and returns the items. |
| `api/_redis.js` | Shared database helper (also limits how often one visitor can use the list reader). |

No build step: Vercel serves the HTML files as-is, installs the packages in `package.json`, and runs anything in `api/` as a function.

## How items are matched

- **No brand written → generic.** `milk`, `ketchup`, `paper towels` compare the cheapest version at each store, store brands included.
- **Brand written → that brand only.** `Heinz ketchup`, `Cheerios`, `Coke` compare only that brand.
- Shoppers can switch any item between "Any brand" and "Brand only" before comparing.

The list reader (`api/parse-list.js`) sends the list to Claude, which returns each item as
`{ name, brand, quantity, original }`, with `brand` set to null unless the shopper actually named one.
If the reader isn't set up, typed lists still work using a simpler built-in reader in the page;
photos need the reader.

## Filling in prices

`prices.csv` is a spreadsheet. Open it in Numbers, Excel or Google Sheets.

- **One row per product.** `item` is the product name; `also_called` lists other names shoppers use,
  separated by `;` (e.g. `whole milk; gallon of milk`).
- **`brand` blank = the cheapest generic/store-brand version.** Fill `brand` only for name-brand rows
  (e.g. `Heinz`). Lists that say just "ketchup" use the cheapest of all ketchup rows; "Heinz ketchup" uses only Heinz rows.
- **`size`** is the size you priced (e.g. `1 gallon`, `1 dozen`, `5 lb bag`). Use the same size at every store.
  If a store doesn't sell that size, leave its cell blank.
- **Store columns** are the regular shelf price, like `3.99`. The `_member` columns are the loyalty-card price,
  used only for shoppers who pick that card. Leave blank if there's no card price.
- **`checked_on`**: the date you checked, like `2026-11-03`. Shoppers see this.
- Each store has one price column in `prices.csv` (GIANT uses the `giant` columns).

Blank cells are fine. Each store's results show how many items were priced, and stores with more of
the list priced are ranked first so missing items can't make a store look cheaper.

**Faster: update prices from photos.** Open `/update-prices.html` (setup below), upload a photo of a
receipt, shelf tag, weekly ad, or a screenshot of the store's app, check what it found, and save.
One receipt can fill 20–40 prices.

To edit by hand instead: when you're done, save or export it as **CSV** with the same name, `prices.csv`, and replace the file
in the project (GitHub → the file → ✏️ edit, or **Add file → Upload files**). Vercel updates the site in about a minute.

To add a product, add a row. To add a store, add it to `stores.json` with a `priceColumn`, then add that column here.

## Shopper receipt uploads

Needs **`ANTHROPIC_API_KEY`** and **Upstash Redis** (see "Turning on the waitlist"). Without Redis,
the upload page says uploads aren't open yet. Redis holds the review queue.

- **No upload limits yet.** Each upload is a small paid Claude request, so set a monthly spend limit in the
  Claude Console (platform.claude.com → Settings → Limits) as a safety net.
- Uploaded receipts wait on `/update-prices.html` under **Shopper receipts**. Tap **Review**, fix or untick
  anything wrong, then **Save**, or **Discard** junk. Waiting receipts are deleted after 60 days.
- Privacy: the photo is never stored. Only item lines, prices, store and date are kept.

## Turning on the photo price updater (one-time setup)

1. **Pick a password.** In Vercel → **Settings** → **Environment Variables**, add `ADMIN_PASSWORD`
   with a long password only you know. (Production and Preview.)
2. **Let it save to GitHub** (optional, but saves you uploading files by hand):
   1. On GitHub: your profile picture → **Settings** → **Developer settings** → **Personal access tokens** →
      **Fine-grained tokens** → **Generate new token**.
   2. Name it `CartCompare prices`, set an expiration, and under **Repository access** pick
      **Only select repositories** → `grocery-saver`.
   3. Under **Permissions** → **Repository permissions**, set **Contents** to **Read and write**. Leave everything else.
   4. **Generate token**, copy it, and add it in Vercel as `GITHUB_TOKEN` (Production and Preview).
3. **Redeploy**, open `/update-prices.html`, and enter your password.

Without `GITHUB_TOKEN`, use **Download updated sheet** and upload the file to GitHub yourself.
Each save is a normal commit to `main` named like "Update 24 prices (GIANT 2026-11-03)", so you can see
or undo any change in the repo's history. Reading a photo uses the same `ANTHROPIC_API_KEY` as the list reader.

## Share receipts to compare

The list builder opens only after a shopper shares receipts (`api/_receipts.js`):

- **Free:** each visit needs **2 new receipts**. That opens the builder for 1 hour.
- **Pro:** **2 receipts once**, then the builder is always open.

A receipt counts only if prices were found on it, and the same photo never counts twice.
Shoppers without an account are tracked by an anonymous browser cookie; when they sign in,
their receipts move to their account. Prices load through `/api/prices`, and the plain
`/prices.csv` link is redirected (see `vercel.json`) so the rule can't be skipped.

## Turning on the waitlist (one-time setup)

The form needs somewhere to store emails. We use **Upstash Redis** (free tier) through Vercel:

1. Open the project in the [Vercel dashboard](https://vercel.com/dashboard).
2. Go to **Storage** → **Create Database** (or **Marketplace**) → pick **Upstash Redis** → choose the free plan.
3. Connect it to the CartCompare project. Vercel adds the needed environment
   variables for you — either `REDIS_URL`, or `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`. The site works with both.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the new variables.
5. Visit the site, sign up with your own email, and check you see "You're on the list!".

Until this is done, the form will show "The waitlist isn't set up yet."

## Turning on the photo/screenshot reader (one-time setup)

1. Create an API key at [platform.claude.com](https://platform.claude.com) (API Keys page). Add a payment method and, ideally, a monthly spend limit.
2. In Vercel: project → **Settings** → **Environment Variables** → add `ANTHROPIC_API_KEY` with the key as the value.
3. **Redeploy.**
4. Open `/list.html`, upload a screenshot of a list, and tap **Read my list**.

Each list read is a small paid request to Claude. Once Upstash Redis is connected, each visitor is
limited to 30 reads per hour. If Claude declines a request for safety reasons, it is automatically
retried on a recommended fallback model (the `fallbacks: "default"` option).

### Seeing who signed up

In the Upstash console for the database, open the **Data Browser** and look at the
`waitlist` key, or run this in its CLI tab:

```
ZRANGE waitlist 0 -1 WITHSCORES
```

Each score is the signup time (milliseconds since 1970).

## Roadmap — next steps

**Phase 1: Validate the idea (now)**
- [x] Landing page with a clear description
- [x] Waitlist form that saves emails
- [ ] Connect Upstash Redis on Vercel (see setup above)
- [ ] Share the page and aim for the first 100 signups
- [ ] Optionally ask signups for their ZIP code to see where demand is

**Phase 2: Collect lists (now)**
- [x] List builder: type a list or upload a photo/screenshot
- [x] Generic-unless-branded matching rule, with a per-item toggle
- [x] Loyalty program and store picker for State College, PA (16801)
- [ ] Add `ANTHROPIC_API_KEY` in Vercel (see setup above)
- [ ] Double-check store addresses and loyalty program names in `stores.json`
- [ ] Save submitted lists (with permission) to learn which items people buy most

**Phase 3: Get price data**
- [x] Pick a starting city: State College, PA
- [x] Start with hand-collected prices (no public price APIs for GIANT, Weis or Wegmans)
- [x] Simple data model: `prices.csv` (products × stores, member prices, date checked)
- [x] Photo price updater: receipts, shelf tags, weekly ads and app screenshots → price sheet
- [ ] Fill in prices for the ~60 starter items (one receipt per store gets most of the way)
- [ ] Later: let shoppers upload their receipts to keep prices fresh
- [ ] Later: apply to official data programs (Walmart, Target, Instacart) once there are users

**Phase 4: First working version (MVP)**
- [x] Match each list item to products at each store (cheapest generic, or the named brand)
- [x] Apply member prices for the loyalty programs the shopper picked
- [x] Total the list at each store and show the cheapest
- [x] Show which items have no price yet
- [ ] Handle "no exact match" items (e.g. suggest the store brand)

**Phase 4b: Two sides**
- [x] Landing page with two choices: share a receipt / compare your cart
- [x] Public receipt uploads with an approval queue
- [ ] Add upload limits if bots or heavy use show up
- [ ] Connect Upstash Redis so uploads open
- [ ] Add login for the compare side
- [ ] Thank contributors (e.g. a count of receipts shared, or perks)

**Phase 5: Launch**
- [ ] Email the waitlist when the MVP is ready
- [ ] Collect feedback and add more stores and cities
