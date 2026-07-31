# Leaf Brothers Cigars — Project Status
**Last updated:** 2026-07-31 (Session 13)

---

## Session 13 Updates (2026-07-31)

1. **Footer "Apply Here" link** — Added `/jobs` link labeled "Apply Here" to the Navigate column in the footer on all pages that have one: `index.html`, `leafbrothers_v6.html`, `privacy.html`, `sms.html`.

2. **Site-wide 16px minimum font size** — Audited and raised all font-size values below 16px (1rem) to at least 16px/1rem across all pages: `index.html`, `leafbrothers_v6.html`, `privacy.html`, `sms.html`, `jobs.html`, `member.html`, `admin.html`. `menu.html` (TV display) left unchanged per request.
   - **Exceptions (decorative, not readable text):**
     - `.tier-perks li::before` (0.45rem) — decorative ✦ bullet character in `index.html` and `leafbrothers_v6.html`
     - `.tier-evt-perk span` (0.45rem) — decorative bullet in `index.html`
   - All `clamp()` values left untouched (they have their own responsive floors).

3. **Ankeny/Waukee on job application** — Already present. `jobs.html` has a required "Preferred Location" field with Waukee, Ankeny, and "Either location works" options, submitted to Formspree as the `Preferred Location` field.

4. **Removed Bartender from /jobs application** — Removed the "Weekend Bartender" position card and dropdown option. Remaining positions: Daytime Sales Associate (Part-Time), Evening Sales Associate (Part-Time).

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

## Session 10 Updates (2026-07-07)

1. **SMS opt-in page (`/sms`)** — New `sms.html` for collecting SMS marketing opt-ins with full TCPA/SHAFT-C compliance:
   - Form: first name (optional), phone (required, tel input), location preference (Waukee/Ankeny/Both select), consent checkbox (not pre-checked, required)
   - Consent checkbox label includes full disclosure: recurring automated marketing messages, not a condition of purchase, msg frequency varies, msg & data rates apply, STOP/HELP instructions
   - Required disclaimer text displayed below form verbatim per carrier requirements
   - Inline "SMS Terms & Privacy" section on same page covering program name, purpose, frequency, rates, STOP/HELP, and mobile data sharing prohibition
   - JS fetch POST to `/api/sms-signup` — inline success state, button disable, error handling
   - Matches site branding: Cinzel/Cormorant Garamond/Raleway fonts, gold/dark color scheme, responsive mobile layout
   - `/sms` rewrite added to `vercel.json`

2. **SMS signup API endpoint (`/api/sms-signup`)** — CommonJS serverless function matching existing API patterns:
   - Accepts POST with `{ first_name, phone, location, consent, consent_text }`
   - Reuses E.164 phone formatter from `checkout.js` (10-digit → `+1...`, 11-digit starting with 1 → `+1...`)
   - Validates consent === true, phone normalization, location in allowed list
   - Inserts into Supabase `sms_subscribers` table with full consent record: phone, location_preference, consent, consent_text, source='web_form', ip_address (x-forwarded-for), user_agent
   - Handles unique phone conflict gracefully: returns `{ ok: true, already: true }` instead of error
   - Logging with `[sms-signup]` prefix matching webhook convention
   - Uses existing `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` env vars

3. **Supabase `sms_subscribers` table** — Schema defined in `supabase/sms_subscribers.sql`:
   - Columns: `id` (bigint identity PK), `first_name` (text), `phone` (text unique not null), `location_preference` (text), `consent` (boolean not null), `consent_text` (text), `source` (text default 'web_form'), `ip_address` (text), `user_agent` (text), `created_at` (timestamptz default now())
   - Table must be created via Supabase dashboard (SQL file is for reference)

4. **Home page CTA** — Added "Text Alerts" link in two places on `index.html`:
   - Nav bar: new `<li>` before "Member Login" linking to `/sms`
   - Hero buttons: third button (ghost style, gold text, smaller) linking to `/sms`

5. **SMS sending NOT yet wired** — This is the collection front-end only. Actual message sending is pending 10DLC registration and SHAFT-C provider approval. No SMS provider SDK is integrated yet.

6. **SMS consent checkboxes updated to exact compliance wording** — Two separate, unchecked, required checkboxes on `/sms`:
   - **Checkbox 1 (SMS Consent):** "By checking this box, you consent to receive text message notifications regarding events and sales from Leaf Brothers Cigars. Reply STOP to opt out. Reply HELP for help. Msg & data rates may apply. Msg frequency may vary."
   - **Checkbox 2 (Terms & Privacy):** "I agree to the Terms and Privacy Policy." — "Privacy Policy" links to `/privacy`; "Terms" is plain text (no terms page exists yet)
   - Both required to submit; backend (`api/sms-signup.js`) rejects with 400 unless both `consent` and `terms_agreed` are true
   - Consent text stored in `consent_text` column is the exact Checkbox 1 string (10DLC proof-of-consent)
   - **New Supabase columns needed:** `terms_agreed` (boolean) and `terms_agreed_text` (text) on `sms_subscribers` — run ALTER TABLE below
   - SQL file updated: `supabase/sms_subscribers.sql`

7. **Menu event slide updated** — `/menu` slide 3 now shows **Foundation Cigar Co. Brand Night** (Thursday July 30, 5-8 PM, Waukee & Ankeny). Full-bleed image (`event-photos/foundation-event.jpg`) with all event details baked in (Buy 5 Get 1 / Buy 10 Get 3 / Buy 20 Get 5 + Swag). Replaced previous 4-Brand (Jake Wyatt/Mayflower/Warfighter/West Tampa) event content. Slide timing unchanged (10s/10s/5s).

7. **Privacy Policy page (`/privacy`)** — New `privacy.html` with full privacy policy covering:
   - Information collection (account, payment via Square, communications, SMS opt-in, automatic/cookies)
   - How information is used (account management, marketing, site operations, legal compliance)
   - SMS/text messaging program privacy (mobile info NOT sold/shared with third parties — required for 10DLC registration)
   - Cookies and analytics disclosure
   - Information sharing (service providers only, legal/safety, business transfers)
   - Data retention, security, user choices/rights, children's privacy
   - Contact information for both locations
   - Effective date: July 10, 2026
   - `/privacy` rewrite added to `vercel.json`
   - Footer "Privacy Policy" link on `index.html` wired to `/privacy` (was dead `#` link)
   - `sms.html` SMS Terms section now links to `/privacy`

---

## Session 9 Updates (2026-07-02)

1. **Per-location Square routing** — Waukee and Ankeny are separate Square merchant accounts. Signups now route to the correct account based on the member's home location selection:
   - **`api/_squareAccounts.js`** — Shared config: account map (token env var, webhook secret env var, webhook URL, location ID, plan variation IDs per tier), tier prices, `resolveAccount()` normalizer, `getClient()` builder, and `PLAN_VARIATION_LOOKUP` reverse map.
   - **`api/checkout.js`** — Reads `home_location`, resolves to account, builds Square client + uses that account's `locationId` and plan variation IDs. No more unsuffixed env vars.
   - **`api/webhook.js`** — Thin wrapper calling shared handler with `'ankeny'`.
   - **`api/webhook-waukee.js`** — New endpoint calling shared handler with `'waukee'`.
   - **`api/_webhookHandler.js`** — Shared webhook logic: signature verification per account, status normalization, activate/update/cancel with `[webhook:ankeny]`/`[webhook:waukee]` log prefixes.
   - **`api/cancel.js`** — Looks up member's `home_location` from Supabase to route cancellation to the correct Square account.
   - **Location picker** — Now shown for ALL five tiers (was hidden for Select/Lounge Premium). "Both" option removed. Required for signup.

2. **Status normalization** — Canonical vocabulary: `active`, `cancelled`, `suspended`.
   - Square `ACTIVE`/`PENDING` → `active`
   - Square `CANCELED`/`DEACTIVATED` → `cancelled`
   - Square `PAUSED` → `suspended`
   - Removed `subscription.deleted` handler (Square no longer fires it).
   - Fixes prior inconsistency where cancelled could be spelled two ways.

---

## Session 8 Updates (2026-06-15)

1. **`/jobs` job application page** — New `jobs.html` for prospective hires to apply online:
   - Submits applications to Formspree endpoint `meervvad` (`https://formspree.io/f/meervvad`)
   - **Math CAPTCHA** and **honeypot field** for bot protection
   - `/jobs` rewrite added to `vercel.json`

2. **Events section updated for Dunbarton June 25th event** — Replaced all prior events in `index.html` (`#events`) with a single **Dunbarton Tobacco & Trust** event:
   - **Thursday, June 25th, 5:00 PM – 8:00 PM**
   - Header banner uses two DTT cigar photos (`event-photos/20190315_150514.jpg`, `event-photos/20220120_125052.jpg`) with a gold/dark overlay
   - Four purchase tiers, each with its matching giveaway photo from `event-photos/`:
     - Tier 1 — Spend $100: 1 Free Umbagog Cigar
     - Tier 2 — Spend $200: 2 Free Umbagog Cigars + Saka Kahn Statue (`DTT SKA KAHN Statue.jpeg`)
     - Tier 3 — Spend $300: 3 Free Umbagog Cigars + DTT Mug or Beanie (`DTT MUG.jpeg`)
     - Tier 4 — Spend $400: 5 Free Umbagog Cigars + DTT Hat (`DTT Hat.jpeg`)
   - New `.dtt-banner` / `.tier-grid` CSS styled to the existing black-and-gold branding (Cinzel/Cormorant fonts, gold `#C9A84C`), responsive down to 1 column on mobile

---

## Session 7 Updates (2026-05-22)

1. **`/menu` TV display page** — New `menu.html` for 40" Fire Stick displays at 1920×1080. Three auto-rotating slides (10s/10s/5s loop, instant cut transitions):
   - **Slide 1**: Bourbon, Scotch, Vodka with single/double pricing
   - **Slide 2**: Tequila, Whiskey, Rum, Wine, Beer, Cocktails
   - **Slide 3**: 4-Brand Cigar Event (May 28) — Jake Wyatt, Mayflower, Warfighter, West Tampa with 2×2 photo grid and buy-in deal tiers
   - Auto-refreshes hourly via `<meta http-equiv="refresh">` to pick up menu edits
   - Event images copied to `assets/` directory for clean referencing
   - `/menu` rewrite added to `vercel.json`
   - Font sizes doubled across all slides for Fire Stick legibility at 40" viewing distance

---

## Session 7 Updates (2026-06-24)

1. **Dunbarton (DTT) event photos** — Added three photos to `event-photos/` for the Dunbarton Tobacco & Trust event:
   - `DTT_MUG.jpg` — DTT mug photo
   - `DTT_SKA_KAHN_STATUE.jpg` — Ska Kahn statue photo
   - `20260106_173115.jpg` — Event photo
   - All accessible at `https://www.leafbrotherscigars.com/event-photos/<filename>` after deploy.

---

## Session 6 Updates (2026-05-21)

1. **Mid-Cap All Stars event brand images** — Added four brand images to `event-photos/` for the upcoming Mid-Cap All Stars event:
   - `jake-wyatt-lineup.jpg` — Jake Wyatt 5-cigar lineup shot (converted from PNG)
   - `mayflower.jpg` — Mayflower cigars with chocolate/salt
   - `warfighter.jpg` — Warfighter cigars on tactical pack
   - `west-tampa.jpg` — West Tampa Tobacco Co. cigars
   - All accessible at `https://www.leafbrotherscigars.com/event-photos/<filename>` after deploy.

---

## Session 5 Updates (2026-04-27)

1. **RyJ event day fix** — Corrected "Wednesday, April 30th" to "Thursday, April 30th" (April 30, 2026 is a Thursday).
2. **Event Card 3 updated** — Renamed "Giveaways & Raffle" to "Buy-In Tiers & Raffle". Replaced generic description with structured buy-in tiers (5/10/20 cigars with escalating rewards), a note limiting tiers to featured event cigars, and a closing line about the premium ashtray raffle. Uses ✦ bullet styling consistent with membership tier perks.
3. **RyJ image for email campaign** — Added `event-photos/ryj-reserva-real-profundo.png` in a new lowercase, hyphenated `event-photos/` directory. Accessible at `https://www.leafbrotherscigars.com/event-photos/ryj-reserva-real-profundo.png` after deploy. Original `Event Photos/` folder left untouched for existing event card references.

---

## Session 4 Completed (2026-04-21)

1. **Admin subscription cancellation** — Admins can now cancel a member's Square subscription from the admin dashboard:
   - **Cancel button** in edit modal, visible only for active members with a `square_subscription_id`. Confirmation dialog warns it cannot be undone from admin UI.
   - **`api/cancel.js` hardened** — Server-side admin check (`ongebub@gmail.com` can cancel any subscription). Non-admin users can only cancel subscriptions matching their own email in the members table. Previously any authenticated user could cancel any subscription ID.
   - **Removed "cancelled" from admin status dropdown** — Prevents the footgun of setting status to "cancelled" in Supabase without actually cancelling the Square billing. Admins must use the Cancel Subscription button for real cancellations.
   - **Status update handled by webhook** — The cancel button does NOT manually flip status in Supabase. Square fires `subscription.deleted` → webhook sets status to cancelled. This keeps Supabase in sync with Square's actual state.
   - **Testing note**: End-to-end cancel flow (admin cancel → Square webhook → Supabase status update) should be tested by Chris against a test subscription. The `subscription.deleted` webhook path has been implemented but not fully tested in production.

2. **Home location feature** — Added `home_location` to the full membership flow:
   - **Signup form** — Location selector shown for all tiers. Required Ankeny/Waukee choice (no "Both" option). *(Updated in Session 9: was hidden for Select/Lounge Premium.)*
   - **Checkout API** — Resolves `home_location` to account key via `resolveAccount()`. Routes to correct Square merchant. Stores in customer `note` field as `home_location:Ankeny`. *(Updated in Session 9: per-location routing.)*
   - **Webhook** — New `parseHomeLocation()` reads customer note on member creation, writes to `home_location` column. Invalid/missing values → `null` + warning log.
   - **Admin dashboard** — Editable `Home Location` dropdown (Ankeny, Waukee, Both) in add/edit modal. Table display handles all three values with styled badges (green for Both).

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
15. **Password recovery handler** — `member.html` checks URL hash for `type=recovery` on page load (not `onAuthStateChange`), immediately shows reset form, skips dashboard load. Calls `updateUser()`, confirms session via `getSession()`, redirects to `/member` with clean URL. Member data load retries session up to 3x to handle async token exchange.

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

### Current Architecture (Per-Location Routing)
- **`api/_squareAccounts.js`** — Shared config: `ACCOUNTS` map (waukee/ankeny), `TIER_PRICES`, `resolveAccount()`, `getClient()`, `PLAN_VARIATION_LOOKUP`
- **`api/checkout.js`** — Resolves account from `home_location`, builds per-account Square client, uses account-specific `locationId` + plan variation IDs. No Supabase interaction.
- **`api/_webhookHandler.js`** — Shared webhook logic: per-account signature verification, status normalization (`active`/`cancelled`/`suspended`), member activation/update
- **`api/webhook.js`** — Ankeny webhook endpoint → calls shared handler with `'ankeny'`
- **`api/webhook-waukee.js`** — Waukee webhook endpoint → calls shared handler with `'waukee'`
- **`api/cancel.js`** — Validates Supabase JWT, looks up member's `home_location` to route cancellation to correct Square account
- **`member.html`** — Member portal (Supabase Auth protected)
- **`admin.html`** — Admin dashboard (Supabase Auth, `ongebub@gmail.com` only)
- **`index.html`** — Main site with signup modal, login modal, contact form
- **`menu.html`** — TV display page for Fire Stick (bar menu + event slide, auto-rotating, hourly refresh)

### Square SDK v44 (Breaking Changes)
- Use `SquareClient` / `SquareEnvironment` (not `Client` / `Environment`)
- Use `token:` (not `accessToken:`)
- Flat API: `client.customers.create()`, `client.checkout.paymentLinks.create()`
- No `.result` wrapper on responses
- **Webhook payloads are snake_case** (`customer_id`, `card_details`, `source_type`)
- SDK v44 converts request field names — use raw `fetch()` for catalog object creation
- Vercel `/api` folder is CommonJS — no `import`/`export`

### Plan Variation IDs (Production) — USE THESE
All IDs are defined in `api/_squareAccounts.js`. Two separate Square merchant accounts:

**Ankeny** (location `KGBZ7RVNAWRT8`):
| Tier | Variation ID | Price |
|------|-------------|-------|
| select | WXS3UVFGTJ7Z5TOYUSMGX2GE | $15/mo |
| lounge | TS5DUW65745CEVANPELUKWBY | $39/mo |
| lounge-premium | 6YKSAN7WUNPA37ZQZEO7T5NJ | $49/mo |
| half-locker | O3R7YN4EPFTZXIXJKAHKJUEC | $59/mo |
| locker | H2ELZFYJ35ZOYRQ5BGD36LVL | $69/mo |

**Waukee** (location `X3YPTX6YD3SHQ`):
| Tier | Variation ID | Price |
|------|-------------|-------|
| select | 4OM6XF4B2GEX73NJRRYK4TOF | $15/mo |
| lounge | 5JNUPOX5C2QIZASZLZS5TMJV | $39/mo |
| lounge-premium | MMORG7OT4SLP66LB4OBGISJS | $49/mo |
| half-locker | JHT6K3V2ADVVP2LXZJRCUYN6 | $59/mo |
| locker | WCL23Y6XZ4V5MOCSKHNKJACF | $69/mo |

**DO NOT use parent plan IDs** — Square rejects with "incorrect object type SUBSCRIPTION_PLAN".

### Environment Variables (Vercel)
- `SQUARE_ACCESS_TOKEN_WAUKEE` — Waukee Square merchant API token
- `SQUARE_ACCESS_TOKEN_ANKENY` — Ankeny Square merchant API token
- `SQUARE_WEBHOOK_SECRET_WAUKEE` — Waukee webhook signature key
- `SQUARE_WEBHOOK_SECRET_ANKENY` — Ankeny webhook signature key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key
- `NEXT_PUBLIC_SITE_URL` — `https://www.leafbrotherscigars.com`

Webhook URLs (hardcoded in `_squareAccounts.js`, must match Square Dashboard):
- Ankeny: `https://www.leafbrotherscigars.com/api/webhook`
- Waukee: `https://www.leafbrotherscigars.com/api/webhook-waukee`

**Retired** (no longer referenced by code — can be removed from Vercel):
- `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SECRET`, `SQUARE_WEBHOOK_URL`

### Supabase `members` Table
Columns: `name, email, phone, tier, home_location, status, join_date, square_customer_id, square_subscription_id, renewal_date, locker_number, terms_agreed_at`
- **No unique constraint on email** — always use `.insert()` not `.upsert(onConflict: email)`
- `home_location` added manually: `ALTER TABLE members ADD COLUMN home_location text;`
- `terms_agreed_at` added: `ALTER TABLE members ADD COLUMN terms_agreed_at timestamptz;`
- **RLS enabled** — anon blocked, service role bypasses, admin (`ongebub@gmail.com`) has full access

### Square Webhook Events (Two endpoints — one per account)
- **Ankeny**: `POST /api/webhook` → `_webhookHandler('ankeny')`
- **Waukee**: `POST /api/webhook-waukee` → `_webhookHandler('waukee')`

All handlers check `referenceId` on the Square customer before acting:
- `payment.updated` / `payment.completed` — creates or activates member if `COMPLETED` + has `referenceId`
- `subscription.created` — creates or activates member (checks `PLAN_VARIATION_LOOKUP` or `referenceId`)
- `subscription.updated` — normalizes status (`ACTIVE`/`PENDING`→`active`, `CANCELED`/`DEACTIVATED`→`cancelled`, `PAUSED`→`suspended`) + updates `renewal_date`

**Status vocabulary**: `active`, `cancelled`, `suspended` — matches admin dashboard CSS/filters.

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
