# VoxTheBoxTheCallingPilot — Render-ready standalone build

AI contact-center software, **bundled calling model**: customers bring no
telephony account. Vox provides calling through one platform carrier
account, cost included in the subscription.

**Tagline:** "Smarter conversations. Greater results."
**Motto:** "Every call, cleared for takeoff." / "If you never miss a call, you never miss a customer."
**Theme:** black `#0B0B0B` + red `#E10600` + gray `#BABABA`, faint gold-tinted
dollar signs + faint gold-outlined headsets, red glow deeper at top/bottom
and softer in the middle. Wordmark in Montserrat: Vox, Box, and Pilot red;
The and Calling silver/gray. App text in Outfit.

## This build is NOT the published demo

The published demo artifact is untouched. This is a separate codebase
assembled to **match** that demo for hosting on Render. It is also not a
live calling product yet: no live calls are placed, no live payments are
charged, and HIPAA / SOC 2 / SLA are roadmap-only, never claimed.

## Pricing (settled)

- Monthly: **$99/month base + $112/agent/month** (5 agents = **$659/mo**).
- Yearly: **$990/year base** (10 × $99, two months free) + **$1,025/agent/year**
  (5 agents = $6,115/yr).
- Proration: **$112 ÷ days in month × days active** (halfway through a
  30-day month = **$56**, three-quarters = **$84**). Deactivation keeps the
  agent listed as Inactive with the prorated breakdown; reactivation
  restores the seat; removal drops the seat. Proration is recorded as a
  credit — no automatic Stripe refunds. Per-agent work time is
  tracking/reporting only, never hourly billing.
- Calling is included. The only telephony line a customer sees is that
  they don't need their own telephony account.

## Lead Pool (settled)

9 categories, sizes 1,000 / 2,500 / 5,000 / 10,000 / 20,000 / 40,000 /
60,000 / 100,000. Clicking a category reprices everything instantly.

| Category | Prices by size |
|---|---|
| Home Improvement | 500 / 1100 / 1900 / 3200 / 5000 / 8000 / 9000 / 10000 |
| Insurance | 600 / 1300 / 2200 / 3600 / 6000 / 9500 / 10800 / 12000 |
| Solar | 700 / 1500 / 2600 / 4400 / 7000 / 11200 / 12600 / 14000 |
| Real Estate | 800 / 1700 / 2800 / 4800 / 8000 / 12800 / 14400 / 16000 |
| Auto | 400 / 900 / 1500 / 2400 / 4000 / 6400 / 7200 / 8000 |
| Healthcare | 600 / 1300 / 2200 / 3600 / 6000 / 9500 / 10800 / 12000 |
| Legal | 1000 / 2200 / 3800 / 6400 / 10000 / 16000 / 18000 / 20000 |
| Electric Suppliers | 650 / 1400 / 2400 / 4100 / 6500 / 10400 / 11700 / 13000 |
| Natural Gas Suppliers | 550 / 1200 / 2000 / 3500 / 5500 / 8800 / 9900 / 11000 |

- "customers can buy leads anywhere including from us but wherever they buy them those leads will work in the dialer."
- Free Import My Own Leads path — leads from ANY source work in the dialer.
- **Owner hold:** every Lead Pool order lands in `pending_owner`
  ("awaiting owner review") and is NEVER auto-delivered. The owner
  releases it; only then does fulfillment begin (provider pull, dedupe,
  DNC scrub). **No scrub, no delivery.**

## Agent lifecycle

Owner creates agent logins at purchase (agent count plus name/email rows,
one by one or in bulk). Created active logins are the billing record.
Deactivate / Reactivate / Remove as above. Agents log in from any
computer. Incoming-call pop-up shows full caller info with Answer/End
and a timer (demo data in this build).

## Screens in this build

Website; Customer App (Dashboard, Live Dialer with 4 modes, My Leads +
free import, Lead Pool, Seats & Billing, Live Calls, Agents, Supervisor
wallboard with Listen/Whisper/Barge, omnichannel Inbox, IVR & Queues,
CRM Integrations + screen-pop, Workforce, Analytics, Scripts,
Interactions, Recordings & Quality, Campaigns, GenAI Studio, Genius
Routing, Vox AI voice demo, incoming-call pop-up); Owner Console.

## Run locally

```bash
npm install
npm start
# Open http://localhost:3000
```

With no Stripe keys set, billing endpoints answer 503 and everything
else keeps working. With no carrier variables set, `/api/carrier`
reports the carrier as deferred and all call data is sample data.

## Render service settings

Create ONE web service (free plan is fine to start):

| Setting | Value |
|---|---|
| Environment | Node (22 or newer) |
| Build command | `npm install` |
| Start command | `npm start` |
| Plan | Free |

Or deploy from the included `render.yaml` Blueprint (dashboard → New →
Blueprint), which also provisions the Postgres database below.

> Note from a sibling deployment: Render has required a card on file
> before ANY deploy, even on the free plan (a small temporary
> authorization was stated, with no charge). If that dialog appears, it
> is Render's requirement, not this app's — no card details belong in
> this repo or in any environment file here.

### Database

With `DATABASE_URL` set (Render Postgres attached), all customers,
agents, orders, leads, and settings persist in Postgres. Without it, the
app falls back to a local SQLite file — for local testing only. On
Render's free plan the web service sleeps when idle and the free
Postgres database is time-limited, so a persistent database is worth
confirming before relying on it for real bookings.

### Environment variables (Render dashboard → Environment)

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes on Render | Postgres connection string (set automatically when the Render database is attached). |
| `SESSION_SECRET` | Yes | Long random value signing login cookies. |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | For Owner Console | Owner login; password is hashed at boot and never stored. |
| `PUBLIC_BASE_URL` | For Stripe redirects | Public HTTPS address, no trailing slash. |
| `STRIPE_SECRET_KEY` | For billing | **Test key only** (`sk_test_`). A live `sk_live_` key is refused at startup. |
| `STRIPE_PUBLISHABLE_KEY` | For billing | Test key only (`pk_test_`). |
| `STRIPE_WEBHOOK_SECRET` | For billing | Test-mode webhook secret (`whsec_`) for `/webhooks/stripe`. |
| `AI_PROVIDER_API_KEY` / `AI_MODEL` / `AI_API_BASE_URL` | No | OpenAI-compatible AI provider; empty = scripted fallback replies. |
| `PLATFORM_CARRIER_API_KEY` / `PLATFORM_CARRIER_ACCOUNT_ID` | Deferred | Platform carrier account. **Leave empty** until the operator creates the carrier account themselves. |

## API summary

- `GET /api/health` — `{ ok, db, billing, carrier }`.
- `POST /api/auth/signup` — business name, email, password (10+ chars). Logs in immediately.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- `GET /api/billing/pricing` — subscription + Lead Pool tables.
- `GET /api/billing/proration?daysActive=&daysInMonth=` — owed + credit.
- `POST /api/billing/checkout/subscription` — base + per-agent × agent count (test checkout).
- `POST /api/billing/checkout/lead-pool` — category + size (test checkout).
- `GET /api/billing/orders`, `GET /api/billing/status`.
- `GET/POST /api/agents`, `POST /api/agents/:id/deactivate`, `POST /api/agents/:id/reactivate`, `DELETE /api/agents/:id`.
- `GET/POST /api/leads`, `POST /api/leads/import` (free import path).
- `GET /api/calls`, `POST /api/calls/incoming-demo` (sample data only).
- `POST /webhooks/stripe` — signature-verified; checkout completion moves Lead Pool orders to `pending_owner`, never to delivered.
- Owner: `POST /api/owner/login`, `GET /api/owner/summary`, `GET /api/owner/customers`, `GET /api/owner/orders`, `POST /api/owner/orders/:id/release`.

## What is still needed before a live deploy (none done here)

1. **Code home / repo** — push this folder to a Git repo so Render can pull it.
2. **Render service** — create the web service from the repo or `render.yaml` (free plan to start).
3. **Database** — attach Render Postgres so `DATABASE_URL` is set (step 3 of the go-live plan).
4. **Stripe test keys + webhook** — a computer step: test keys and the test-mode webhook secret go in Render's environment (keys never in chat), then a test charge with card 4242 4242 4242 4242. Live activation is a separate operator step (identity verification + payout/bank details inside Stripe) and is NOT done here.
5. **Carrier account** — deferred. The operator creates the platform carrier account themselves when ready; until then, calling stays demo-only.
6. **Domain** — point the company domain at the service afterward, if wanted.
7. **Owner setup** — owner opens the Owner Console once on the live site and sets the owner login via environment (already documented above).

## What was deliberately left out (superseded)

The old per-customer telephony-connect layer from the starter zips —
per-customer telephony credentials, per-customer connect endpoints, and
per-customer webhook verification — is NOT in this build. It belongs to
the old model (customers bring their own telephony account) and was
replaced by the bundled model (Vox provides calling through one
platform carrier account). Nothing in this build asks a customer for a
telephony account, key, or number.
