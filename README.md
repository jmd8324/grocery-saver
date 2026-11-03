# CartCompare

Same groceries, smaller bill. CartCompare compares your shopping list across
nearby stores and shows which one gives you the cheapest cart.

## What's here

| File | What it does |
| --- | --- |
| `index.html` | The landing page: short description, how it works, and the waitlist form. |
| `api/waitlist.js` | A Vercel serverless function. The form sends emails here and it saves them to the database. |

No build step: Vercel serves `index.html` as-is and runs anything in `api/` as a function.

## Turning on the waitlist (one-time setup)

The form needs somewhere to store emails. We use **Upstash Redis** (free tier) through Vercel:

1. Open the project in the [Vercel dashboard](https://vercel.com/dashboard).
2. Go to **Storage** → **Create Database** (or **Marketplace**) → pick **Upstash Redis** → choose the free plan.
3. Connect it to the CartCompare project. Vercel adds the needed environment
   variables (`KV_REST_API_URL` and `KV_REST_API_TOKEN`) for you.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks up the new variables.
5. Visit the site, sign up with your own email, and check you see "You're on the list!".

Until this is done, the form will show "The waitlist isn't set up yet."

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

**Phase 2: Get price data**
- [ ] Pick 1 city and 2–3 stores to start with
- [ ] Research where prices can come from (store APIs, Instacart/Kroger developer APIs, weekly ads, manual entry)
- [ ] Define a simple data model: stores, products, prices, date checked

**Phase 3: First working version (MVP)**
- [ ] Let a user build a grocery list
- [ ] Total the list at each store and show the cheapest
- [ ] Handle "no exact match" items (e.g. suggest the store brand)

**Phase 4: Launch**
- [ ] Email the waitlist when the MVP is ready
- [ ] Collect feedback and add more stores and cities
