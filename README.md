# CartCompare

Same groceries, smaller bill. CartCompare compares your shopping list across
nearby stores and shows which one gives you the cheapest cart.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The landing page: short description, how it works, and the waitlist form. |
| `list.html` | The list builder: ZIP code, type or upload a photo/screenshot of a list, review items, pick loyalty programs and stores. |
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

## Turning on the waitlist (one-time setup)

The form needs somewhere to store emails. We use **Upstash Redis** (free tier) through Vercel:

1. Open the project in the [Vercel dashboard](https://vercel.com/dashboard).
2. Go to **Storage** → **Create Database** (or **Marketplace**) → pick **Upstash Redis** → choose the free plan.
3. Connect it to the CartCompare project. Vercel adds the needed environment
   variables (`KV_REST_API_URL` and `KV_REST_API_TOKEN`) for you.
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
- [ ] Research where prices can come from (store APIs, Instacart/Kroger developer APIs, weekly ads, manual entry)
- [ ] Define a simple data model: stores, products, prices, date checked

**Phase 4: First working version (MVP)**
- [ ] Match each list item to products at each store (cheapest generic, or the named brand)
- [ ] Apply member prices for the loyalty programs the shopper picked
- [ ] Total the list at each store and show the cheapest
- [ ] Handle "no exact match" items (e.g. suggest the store brand)

**Phase 5: Launch**
- [ ] Email the waitlist when the MVP is ready
- [ ] Collect feedback and add more stores and cities
