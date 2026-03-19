# Leaf Brothers Cigars — Project Status
**Last updated:** 2026-03-18 (Session 3)

---

## ✅ FULLY WORKING AS OF SESSION 3

The end-to-end membership flow is **live in production**:

1. User fills out signup modal (with T&C checkboxes) → POST `/api/checkout`
2. Square customer searched by email — reuse existing or create new with `referenceId: tier`
3. Square hosted checkout URL returned → user redirected
4. User pays on Square's page (card, Apple Pay, Cash App)
5. Square fires `subscription.created` + `payment.updated` webhooks
6. Webhook checks `referenceId` (skips non-membership events), creates/activates member in Supabase
7. Supabase Auth user created → invite email sent with password-set link
8. User redirected to `/?welcome=1` → welcome toast + login modal opens
9. Member logs in via Supabase Auth → redirected to `/member` portal
10. Member record visible in admin dashboard at `/admin` (Supabase Auth, admin-only)

---

## Session 3 Completed (2026-03-18)

1. **Real member auth** — `submitLogin()` replaced with Supabase `signInWithPassword()`, redirects to `/member` on success
2. **Member portal** — `member.html` created with name, tier, status, renewal date, locker number, cancel button, logout
3. **Cancel API** — `api/cancel.js` created, validates Supabase JWT, calls Square `subscriptions.cancel()`
4. **Admin dashboard auth** — Replaced hardcoded JS password with Supabase Auth login. Only `ongebub@gmail.com` can access. Session persists across reloads.
5. **RLS policies** — Enabled on `members` table. Anon blocked, service role bypasses, admin (`ongebub@gmail.com`) has full CRUD.
6. **Formspree contact form** — Wired to `https://formspree.io/f/meervvad`. JSON POST via fetch, success toast, form clear, validation.
7. **Terms & Conditions** — Scrollable T&C box in signup modal with 3 required checkboxes. `terms_agreed_at` timestamptz stored in Supabase.
8. **Removed pending insert from checkout** — Member rows now only created by webhook on confirmed payment. `checkout.js` no longer touches Supabase.
9. **POS transaction guard** — All webhook handlers (payment.updated/completed, subscription.created/updated/deleted) check for `referenceId` on the Square customer before touching Supabase. In-store POS sales are ignored.
10. **Reuse existing Square customers** — `checkout.js` searches for existing customer by email before creating. Updates `referenceId` if missing.
11. **Field-level checkout errors** — `checkout.js` parses Square error `field` values and returns `fieldErrors` object. Frontend shows inline messages next to phone/email/name fields.
12. **Member route** — Added `/member` rewrite to `vercel.json`
13. **Debug logging** — Phone formatter logging in `checkout.js`, Supabase query logging in `member.html`
14. **Forgot Password** — Added reset password flow to login modal. Calls `supabase.auth.resetPasswordForEmail()` with redirect to `/member`.
15. **Password recovery handler** — `member.html` checks URL hash for `type=recovery` on page load (not `onAuthStateChange`), immediately shows reset form, skips dashboard load. Calls `updateUser()`, redirects to `/member` on success.

---

## Session 2 Completed (2026-03-11)

1. CommonJS import error — converted ESM → CommonJS in both API files
2. node_modules in Git — removed from tracking
3. Webhook snake_case bug — fixed all field access
4. Webhook signature verification — added `SQUARE_WEBHOOK_URL` env var, `timingSafeEqual`
5. `cards.list()` API — v44 uses `cards.list({ customerId })`
6. Silent Supabase failures — added error logging
7. Webhook wrong event type — added `payment.updated` handling
8. Checkout 500 — added `quickPay` alongside `subscriptionPlanId`
9. Phone number format — E.164 formatter
10. Wrong plan ID type — switched to variation IDs
11. Supabase upsert error — switched to `.insert()`
12. Welcome redirect — `?welcome=1` triggers toast + login modal
13. Nav login button styling fix

---

## Critical Technical Details

### Current Architecture
- **`api/checkout.js`** — Searches/creates Square customer, creates payment link. No Supabase interaction.
- **`api/webhook.js`** — Handles all Square events. Creates member row in Supabase on first confirmed payment. Guards all handlers with `referenceId` check.
- **`api/cancel.js`** — Validates Supabase JWT, cancels Square subscription
- **`member.html`** — Member portal (Supabase Auth protected)
- **`admin.html`** — Admin dashboard (Supabase Auth, `ongebub@gmail.com` only)
- **`index.html`** — Main site with signup modal, login modal, contact form

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
- `SQUARE_WEBHOOK_URL` — `https://www.leafbrotherscigars.com/api/webhook`
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key
- `NEXT_PUBLIC_SITE_URL` — `https://www.leafbrotherscigars.com`

### Supabase `members` Table
Columns: `name, email, phone, tier, home_location, status, join_date, square_customer_id, square_subscription_id, renewal_date, locker_number, terms_agreed_at`
- **No unique constraint on email** — always use `.insert()` not `.upsert(onConflict: email)`
- `home_location` added manually: `ALTER TABLE members ADD COLUMN home_location text;`
- `terms_agreed_at` added: `ALTER TABLE members ADD COLUMN terms_agreed_at timestamptz;`
- **RLS enabled** — anon blocked, service role bypasses, admin (`ongebub@gmail.com`) has full access

### Square Webhook Events (Production — all configured)
All handlers check `referenceId` on the Square customer before acting:
- `payment.created` — logged but no action
- `payment.updated` / `payment.completed` — creates or activates member if `COMPLETED` + has `referenceId`
- `subscription.created` — creates or activates member (checks `PLAN_TO_TIER` map or `referenceId`)
- `subscription.updated` — updates status + renewal_date in Supabase
- `subscription.deleted` — sets status to `cancelled` in Supabase

### Square Loyalty Program
- Leaf Brothers has an active loyalty program in Square
- The checkout page shows a loyalty 404 for new customers — this is **expected** (no account yet)
- After first payment, Square should auto-create a loyalty account
- **Unverified**: whether points accrue on recurring subscription renewals

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
11. Non-membership Square events (POS sales) will fire webhooks too — always guard with `referenceId` check
12. Don't insert member rows at checkout time — wait for confirmed payment via webhook

---

## Next Session Priorities

### 🔴 High Priority
- [ ] **End-to-end signup test** — Real member signup through full flow: form → Square checkout → webhook → Supabase row → login → member portal. Verify all fields populated correctly.
- [ ] **Verify webhook creates full member row** — Check that name, email, phone, tier, status, join_date, square_customer_id, square_subscription_id, renewal_date, terms_agreed_at are all populated on new signup
- [ ] **Test member login** — Verify Supabase Auth invite email arrives, password set works, login redirects to `/member`
- [ ] **Clean up test members** in Supabase from sessions 2-3 (Chris Morrill, Test One, etc.)

### 🟡 Medium Priority
- [ ] **Subscription cancellation flow test** — Cancel from member portal, verify `subscription.deleted` webhook fires, member status → cancelled in Supabase
- [ ] **Renewal date accuracy** — Verify `charged_through_date` is populating `renewal_date` correctly via `subscription.updated` webhook
- [ ] **Verify loyalty point accrual** — Check Square Dashboard → Loyalty → Accounts after real signup
- [ ] **Checkout 500 error** — Last attempt returned 500 from Square; need to reproduce and check logs for specific error detail

### 🟢 Nice to Have
- [ ] **Google Analytics** — Add GA4 tracking tag to `<head>` of index.html
- [ ] **SEO** — Add `og:image` meta tag, structured data for local business
- [ ] **Renewal email notifications** — Trigger via `subscription.updated` webhook
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

## Recent Commits (Session 3)
- `688968c` — Field-level error handling for checkout failures
- `563502f` — Search for existing Square customer by email before creating
- `f1df7ee` — Phone debug logging in checkout.js
- `cfb14c7` — Guard all webhook handlers against non-membership events
- `cdff5a0` — Skip non-membership payments in webhook handler
- `0dbed59` — Use Square payment/subscription timestamp for terms_agreed_at
- `f26f61e` — Move member insert from checkout to webhook
- `89bc529` — Add T&C box and required checkboxes to signup modal
- `301bae4` — Wire contact form to Formspree endpoint
- `497aeab` — Replace admin hardcoded password with Supabase Auth login
- `4d2f855` — Add debug logging to member.html Supabase query
- `a19a8df` — Add /member rewrite route to vercel.json
