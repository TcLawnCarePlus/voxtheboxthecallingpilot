// VoxTheBoxTheCallingPilot — Stripe billing (TEST MODE ONLY).
//
// Subscription Checkout, Lead Pool Checkout, and the Stripe webhook for
// the bundled-model build. Pricing and standing rules match the settled
// product rules (Oct 26, 2026):
//   - Subscription: $99/month base + $112/agent/month, calling bundled
//     in. Yearly base $990/year (10 x $99, two months free).
//     Yearly per-agent $1,025/year. The agent count at checkout is the
//     billing record.
//   - Lead Pool: one-time prices by category and size (table below).
//     A successful payment NEVER auto-delivers a Lead Pool order: the
//     order moves to "pending_owner" ("awaiting owner review") and only
//     the platform owner releases it. No scrub, no delivery.
//   - Deactivation proration: a deactivated seat owes $112 / days in
//     month x days active. This module computes that amount (and the
//     matching credit for prepaid days) and records it; it does not issue
//     Stripe refunds or credits automatically.
//   - Payout destination is NEVER in code. Money goes wherever the
//     operator configures inside their own Stripe dashboard — never put
//     bank, routing, or account numbers in this file.
//
// TEST MODE ONLY. Live keys are refused at boot: if a sk_live_ key is
// pasted in, billing disables itself and logs a warning, so no real
// charge can ever be created from here.

const SUBSCRIPTION_PRICES = {
  monthly: { base: 99, perAgent: 112 },
  yearly: { base: 990, perAgent: 1025 },
};

const LEAD_POOL_SIZES = [1000, 2500, 5000, 10000, 20000, 40000, 60000, 100000];

const LEAD_POOL_PRICES = {
  "Home Improvement": [500, 1100, 1900, 3200, 5000, 8000, 9000, 10000],
  Insurance: [600, 1300, 2200, 3600, 6000, 9500, 10800, 12000],
  Solar: [700, 1500, 2600, 4400, 7000, 11200, 12600, 14000],
  "Real Estate": [800, 1700, 2800, 4800, 8000, 12800, 14400, 16000],
  Auto: [400, 900, 1500, 2400, 4000, 6400, 7200, 8000],
  Healthcare: [600, 1300, 2200, 3600, 6000, 9500, 10800, 12000],
  Legal: [1000, 2200, 3800, 6400, 10000, 16000, 18000, 20000],
  "Electric Suppliers": [650, 1400, 2400, 4100, 6500, 10400, 11700, 13000],
  "Natural Gas Suppliers": [550, 1200, 2000, 3500, 5500, 8800, 9900, 11000],
};

const MAX_AGENTS_PER_CHECKOUT = 500;

function subscriptionTotal(billingPeriod, agentCount) {
  const price = SUBSCRIPTION_PRICES[billingPeriod];
  if (!price) throw Object.assign(new Error("Unknown billing period: " + billingPeriod), { statusCode: 400 });
  if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > MAX_AGENTS_PER_CHECKOUT) {
    throw Object.assign(new Error("Agent count must be a whole number between 1 and " + MAX_AGENTS_PER_CHECKOUT + "."), { statusCode: 400 });
  }
  return price.base + price.perAgent * agentCount;
}

function leadPoolPrice(category, size) {
  const table = LEAD_POOL_PRICES[category];
  if (!table) throw Object.assign(new Error("Unknown Lead Pool category: " + category), { statusCode: 400 });
  const idx = LEAD_POOL_SIZES.indexOf(size);
  if (idx === -1) {
    throw Object.assign(new Error("Unknown Lead Pool size: " + size + " (sizes: " + LEAD_POOL_SIZES.join(", ") + ")."), { statusCode: 400 });
  }
  return table[idx];
}

// Settled proration rule. Returns whole cents, rounded to nearest cent.
function prorationOwedCents({ daysActive, daysInMonth }) {
  if (!Number.isInteger(daysActive) || !Number.isInteger(daysInMonth) || daysInMonth < 28 || daysInMonth > 31) {
    throw new Error("Proration needs whole days and a 28-31 day month.");
  }
  const active = Math.max(0, Math.min(daysActive, daysInMonth));
  return Math.round((11200 * active) / daysInMonth);
}

function prorationCreditCents({ daysActive, daysInMonth }) {
  return 11200 - prorationOwedCents({ daysActive, daysInMonth });
}

// --- Stripe client: test keys only ---------------------------------------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

let stripeSdk = null;
let stripeSdkMissing = false;
try {
  stripeSdk = require("stripe");
} catch {
  stripeSdkMissing = true;
}

const stripeIsTestKey =
  STRIPE_SECRET_KEY.startsWith("sk_test_") &&
  (STRIPE_PUBLISHABLE_KEY === "" || STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_"));
const stripeHasLiveKey =
  STRIPE_SECRET_KEY.startsWith("sk_live_") || STRIPE_PUBLISHABLE_KEY.startsWith("pk_live_");

let stripe = null;
if (!stripeSdkMissing && STRIPE_SECRET_KEY && stripeIsTestKey) {
  stripe = stripeSdk(STRIPE_SECRET_KEY);
}

const billingConfigured = Boolean(stripe);
const webhookConfigured = Boolean(stripe && STRIPE_WEBHOOK_SECRET);

function billingNotConfiguredMessage() {
  if (stripeSdkMissing) return "Stripe payments are not set up on this server yet: the Stripe SDK is not installed (run `npm install`).";
  if (stripeHasLiveKey) return "Stripe payments are not set up on this server yet: a live Stripe key was found, and this build only runs in test mode. Replace it with a test key (sk_test_...) from the Stripe dashboard's test mode.";
  if (!STRIPE_SECRET_KEY) return "Stripe payments are not set up on this server yet: STRIPE_SECRET_KEY is not set. Add the test-mode keys from the Stripe dashboard (test mode only) and restart the server.";
  return "Stripe payments are not configured on this server.";
}

function checkoutBaseUrl(publicBaseUrl, port) {
  if (publicBaseUrl) return publicBaseUrl;
  return "http://localhost:" + port;
}

async function createSubscriptionCheckout({ customer, billingPeriod, agentCount, baseUrl, createOrder }) {
  if (!billingConfigured) throw Object.assign(new Error(billingNotConfiguredMessage()), { statusCode: 503 });
  const totalCents = subscriptionTotal(billingPeriod, agentCount) * 100;
  const price = SUBSCRIPTION_PRICES[billingPeriod];
  const interval = billingPeriod === "yearly" ? "year" : "month";
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: customer.email,
    line_items: [
      { price_data: { currency: "usd", product_data: { name: "VoxTheCallingPilot platform subscription" }, recurring: { interval }, unit_amount: price.base * 100 }, quantity: 1 },
      { price_data: { currency: "usd", product_data: { name: "VoxTheCallingPilot agent seat" }, recurring: { interval }, unit_amount: price.perAgent * 100 }, quantity: agentCount },
    ],
    success_url: baseUrl + "/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: baseUrl + "/billing/cancel",
    metadata: { kind: "subscription", customerId: customer.id, billingPeriod, agentCount: String(agentCount) },
  });
  const order = await createOrder({ customerId: customer.id, kind: "subscription", details: { billingPeriod, agentCount, amountCents: totalCents } });
  return { order, checkoutUrl: session.url, sessionId: session.id };
}

async function createLeadPoolCheckout({ customer, category, size, baseUrl, createOrder }) {
  if (!billingConfigured) throw Object.assign(new Error(billingNotConfiguredMessage()), { statusCode: 503 });
  const amountCents = leadPoolPrice(category, size) * 100;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: customer.email,
    line_items: [
      { price_data: { currency: "usd", product_data: { name: "VoxTheCallingPilot Lead Pool — " + category + " (" + size.toLocaleString("en-US") + " leads)" }, unit_amount: amountCents }, quantity: 1 },
    ],
    success_url: baseUrl + "/billing/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: baseUrl + "/billing/cancel",
    metadata: { kind: "lead_pool", customerId: customer.id, category, size: String(size) },
  });
  const order = await createOrder({ customerId: customer.id, kind: "lead_pool", details: { category, size, amountCents } });
  return { order, checkoutUrl: session.url, sessionId: session.id };
}

function verifyStripeWebhook(rawBody, signatureHeader) {
  if (!webhookConfigured) throw Object.assign(new Error(billingNotConfiguredMessage()), { statusCode: 503 });
  if (!signatureHeader) throw Object.assign(new Error("Missing Stripe signature header."), { statusCode: 400 });
  try {
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, STRIPE_WEBHOOK_SECRET);
  } catch {
    throw Object.assign(new Error("Invalid Stripe webhook signature."), { statusCode: 400 });
  }
}

// Pure order-state transition for a completed checkout. Takes the order
// store functions so this module stays free of storage details. A paid
// Lead Pool order NEVER jumps straight to released.
async function applyCheckoutCompleted(event, { findOrderBySessionId, updateOrder }) {
  const session = event.data && event.data.object ? event.data.object : {};
  const order = session.id ? await findOrderBySessionId(session.id) : null;
  if (!order) return { order: null, customerId: null, subscriptionChange: null };
  if (order.paid) return { order, customerId: order.customerId, subscriptionChange: null };

  const now = new Date().toISOString();
  const patch = { paid: true, paidAt: now, updatedAt: now };
  if (session.subscription) patch.stripeSubscriptionId = session.subscription;
  let subscriptionChange = null;
  if (order.kind === "lead_pool") {
    patch.status = "pending_owner";
  } else if (order.kind === "subscription") {
    patch.status = "released";
    subscriptionChange = {
      status: "active",
      billingPeriod: order.details.billingPeriod,
      agentCount: order.details.agentCount,
      stripeSubscriptionId: patch.stripeSubscriptionId || order.stripeSubscriptionId || null,
      stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
      updatedAt: now,
    };
  }
  const updated = await updateOrder(order.id, patch);
  return { order: updated, customerId: order.customerId, subscriptionChange };
}

function applySubscriptionEvent(event) {
  const sub = event.data && event.data.object ? event.data.object : {};
  const type = event.type || "";
  if (type === "customer.subscription.deleted") return { status: "canceled", stripeSubscriptionId: sub.id || null };
  if (type === "customer.subscription.updated") return { status: sub.status || "active", stripeSubscriptionId: sub.id || null };
  return null;
}

module.exports = {
  SUBSCRIPTION_PRICES, LEAD_POOL_SIZES, LEAD_POOL_PRICES, MAX_AGENTS_PER_CHECKOUT,
  subscriptionTotal, leadPoolPrice, prorationOwedCents, prorationCreditCents,
  billingConfigured, webhookConfigured, stripeHasLiveKey, stripeSdkMissing,
  billingNotConfiguredMessage, checkoutBaseUrl,
  createSubscriptionCheckout, createLeadPoolCheckout,
  verifyStripeWebhook, applyCheckoutCompleted, applySubscriptionEvent,
};
