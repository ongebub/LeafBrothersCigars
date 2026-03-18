# Leaf Brothers Cigars — Project Status
**Last updated:** 2026-03-18 (Session 3)

---

## ✅ FULLY WORKING AS OF THIS SESSION

The end-to-end membership flow is **live in production**:

1. User fills out signup modal → POST `/api/checkout`
2. Square customer created with `referenceId: tier`
3. Square hosted checkout URL returned → user redirected
4. User pays on Square's page (card, Apple Pay, Cash App)
5. Square fires `subscription.created` + `payment.updated` webhooks
6. Webhook activates member in Supabase with `status: active` + `square_subscription_id`
7. User redirected to `/?welcome=1` → welcome toast + login modal opens
8. Member record visible in admin dashboard at `/admin`

**Verified working:** Test member "Test One" — Select Member, $15/mo, Active since 03/11/2026, renews 04/11/2026. Supabase record confirmed. Square subscription confirmed.

---

## Session 3 Changes (2026-03-18)

1. **Member route** — Added `/member` rewrite to `vercel.json` so `member.html` is accessible at `/member`
2. **Debug logging** — Added `console.log` in `member.html` after Supabase query to log data, error, and email
3. **Admin real auth** — Replaced hardcoded password in `admin.html` with Supabase Auth login. Only `ongebub@gmail.com` can access the dashboard. Session persists across page reloads.
4. **Contact form** — Wired contact form in `index.html` to Formspree (`meervvad`). JSON POST via fetch, success toast, form clear, validation.
5. **Terms & Conditions** — Added scrollable T&C box + 3 required checkboxes to signup modal. Checkout button disabled until all checked. `terms_agreed_at` timestamptz saved to Supabase on checkout.
6. **Move member insert to webhook** — Removed Supabase insert from `checkout.js`. `activateMember()` in `webhook.js` now does a full INSERT (name, email, phone, tier, status, join_date, square_customer_id, square_subscription_id, renewal_date, terms_agreed_at) if no row exists, or updates to active if one does.

---

## What Was Fixed in Session 2 (in order)

1. **CommonJS import error** — `Environment` was undefined; converted ESM → CommonJS in both API files
2. **node_modules in Git** — Removed from tracking with `git rm -r --cached node_modules/`
3. **Webhook snake_case bug** — Square payloads use `customer_id` not `customerId`; fixed all field access
4. **Webhook signature verification** — Added `SQUARE_WEBHOOK_URL` env var, switched to `timingSafeEqual`
5. **`cards.list()` API** — v44 uses `cards.list({ customerId })` not `customers.cards.list()`
6. **Silent Supabase failures** — Added error logging throughout checkout and webhook
7. **Webhook wrong event type** — Was only handling `subscription.*` events; Square sends `payment.updated` which was silently ignored. Fixed to handle both.
8. **Checkout 500 error** — `MISSING_REQUIRED_PARAMETER`: Square requires `quickPay` or `order` alongside `subscriptionPlanId`. Added `quickPay` with tier name + amount.
9. **Phone number format** — Square requires E.164 (`+15155550100`); added formatter.
10. **Wrong plan ID type** — `subscriptionPlanId` must be a **variation ID**, not parent plan ID. Created variations via raw `fetch()` (SDK v44 converts field names and breaks it).
11. **Supabase upsert error** — No unique constraint on email; switched from `.upsert()` to `.insert()`
12. **Welcome redirect** — After Square checkout, `?welcome=1` triggers toast + login modal, then URL cleaned to `/`
13. **Nav login button styling** — Fixed CSS alignment in navbar

---

## Files Changed This Session
- **api/checkout.js** — Full rewrite: CommonJS, Square SDK v44, quickPay, phone E.164, plan variation IDs, Supabase insert
- **api/webhook.js** — Full rewrite: snake_case fields, payment.updated/completed handling, subscription handlers, activateMember() shared function, logging prefix `[webhook]`
- **index.html** — Welcome redirect toast, login modal trigger, nav button CSS fix
- **api/debug-plans.js** — Created and deleted (used to create plan variations)
- **vercel.json** — No changes needed

---

## Critical Technical Details

### Square SDK v44 (Breaking Changes)
- Use `SquareClient` / `SquareEnvironment` (not `Client` / `Environment`)
- Use `token:` (not `accessToken:`)
- Flat API: `client.customers.create()`, `client.checkout.paymentLinks.create()`
- No `.result` wrapper on responses
- **Webhook payloads are snake_case** (`customer_id`, `card_details`, `source_type`)
- SDK v44 converts request field names — use raw `fetch()` for catalog object creation
- Vercel `/api` folder is CommonJS — no `import`/`export`

### Plan Variation IDs (Production) — USE THESE
These are `SUBSCRIPTION_PLAN_VARIATION` IDs for `checkoutOptions.subscriptionPlanId`:

| Tier | Variation ID | Price |
|------|-------------|-------|
| select | WXS3UVFGTJ7Z5TOYUSMGX2GE | $15/mo |
| lounge | TS5DUW65745CEVANPELUKWBY | $39/mo |
| lounge-premium | 6YKSAN7WUNPA37ZQZEO7T5NJ | $49/mo |
| half-locker | O3R7YN4EPFTZXIXJKAHKJUEC | $59/mo |
| locker | H2ELZFYJ35ZOYRQ5BGD36LVL | $69/mo |

**DO NOT use parent plan IDs** (QAKPMT2OPQMEJ23DPA452PVJ etc.) — Square rejects with "incorrect object type SUBSCRIPTION_PLAN".

### Environment Variables (Vercel — all configured)
- `SQUARE_ACCESS_TOKEN` — Square production API token
- `SQUARE_LOCATION_ID` — `KGBZ7RVNAWRT8`
- `SQUARE_WEBHOOK_SECRET` — Webhook signature key
- `SQUARE_WEBHOOK_URL` — `https://www.leafbrotherscigars.com/api/webhook` ← **added this session**
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key
- `NEXT_PUBLIC_SITE_URL` — `https://www.leafbrotherscigars.com`

### Supabase `members` Table
Columns: `name, email, phone, tier, home_location, status, join_date, square_customer_id, square_subscription_id, renewal_date, locker_number`
- **No unique constraint on email** — always use `.insert()` not `.upsert(onConflict: email)`
- `home_location` added manually: `ALTER TABLE members ADD COLUMN home_location text;`

### Square Webhook Events (Production — all configured)
- `payment.created` — logged but no action (subscription.created handles activation)
- `payment.updated` — activates member if payment.status === 'COMPLETED'
- `subscription.created` — primary activation path
- `subscription.updated` — handled
- `subscription.deleted` — handled (should cancel member in Supabase)

### Square Loyalty Program
- Leaf Brothers has an active loyalty program in Square
- The checkout page shows a loyalty 404 for new customers — this is **expected** (no account yet)
- After first payment, Square should auto-create a loyalty account
- **Unverified**: whether points accrue on recurring subscription renewals (not just first payment)
- To verify: Square Dashboard → Loyalty → Accounts → check for member after signup

---

## Hard-Won Lessons (Don't Repeat These Mistakes)
1. `subscriptionPlanId` needs a **variation ID**, not the parent plan ID
2. Square checkout requires `quickPay` OR `order` alongside `subscriptionPlanId`
3. Webhook payloads are **snake_case** — `customer_id` not `customerId`
4. Square SDK v44 converts field names in requests — use raw `fetch()` for catalog API
5. Phone numbers must be E.164 (`+15155550100`) or Square rejects the checkout
6. Square API 2026-01-22 uses `phases[].pricing.price_money` not `recurring_price_money`
7. Always return 200 from webhooks — errors cause Square to retry 18× over 3 days
8. Vercel serverless functions are CommonJS — no `import`/`export`
9. Square Developer Dashboard defaults to **Sandbox** — always check the Production toggle
10. Webhook `SQUARE_WEBHOOK_URL` env var must match exactly what's in Square Dashboard (no trailing slash, must be `www`)

---

## Next Session Priorities

### 🔴 High Priority
- [ ] **Real member login** — `submitLogin()` in index.html is still a frontend mock (just sets sessionStorage). Needs Supabase Auth or email lookup + token. Members can't actually authenticate.
- [ ] **Admin dashboard real auth** — `/admin` is protected by a JS `prompt()` password check only. Should use at minimum HTTP basic auth or Supabase Auth.
- [ ] **Clean up duplicate/test members** in Supabase from today's testing (Chris Morrill, Test One, etc.)

### 🟡 Medium Priority
- [ ] **Contact form backend** — Form in footer is frontend-only. Sign up at Formspree.io, get endpoint, replace `<form>` action. ~5 min fix.
- [ ] **Verify loyalty points** — Check Square Dashboard → Loyalty → Accounts after a real member signs up to confirm points are accruing
- [ ] **Subscription cancellation flow** — `subscription.deleted` webhook is handled in code but untested. What happens in Supabase when a member cancels?
- [ ] **Renewal date accuracy** — `renewal_date` in Supabase may not be populated correctly. Verify it's being set from Square's `charged_through_date`.

### 🟢 Nice to Have
- [ ] **Google Analytics** — Add GA4 tracking tag to `<head>` of index.html
- [ ] **SEO** — Add `og:image` meta tag, structured data for local business
- [ ] **Renewal email notifications** — Trigger via `subscription.updated` webhook
- [ ] **Member portal** — Real dashboard showing tier, renewal date, locker info post-login
- [ ] **Events section** — Tatuaje, Illusione & Surrogates event (March 26) needs updating after it passes

---

## Git Workflow
```powershell
cd C:\Users\ongeb\Documents\leaf-brothers-cigars
git add .
git commit -m "your message"
git push
```
Auth: HTTPS with GitHub Personal Access Token (Settings → Developer Settings → Personal Access Tokens → Classic)

## Recent Commits This Session
- `75a7de0` — Welcome redirect toast + login modal after Square checkout
- `632acaf` — Switch Supabase upsert → insert (no unique email constraint)
- `1c59f84` — Wire plan variation IDs into checkout + webhook, delete debug files
- `28d208d` — Create plan variations via raw fetch (SDK v44 bypass)
- `5e7a866` — Add quickPay to checkout request
- `d52c6ed` — E.164 phone number formatter
- `f807963` — Fix webhook: snake_case fields, signature verification, event handling
- `401d43e` — Fix Square SDK Environment import
