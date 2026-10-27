// VoxTheBoxTheCallingPilot — bundled-model server (Render-ready).
//
// What this is: the platform backend for the bundled calling model.
// Customers bring NO telephony account; Vox provides calling through
// one platform carrier account, cost included in the subscription
// (see carrier.js — unconfigured/deferred in this build, demo data
// only). The old per-customer telephony-connect layer is superseded
// and is NOT in this build: no per-customer telephony credentials,
// no per-customer connect endpoints, no per-customer webhooks.
//
// What this is not: a live calling product. No live calls are placed,
// no live payments are charged (Stripe test mode only, live keys
// refused), and HIPAA / SOC 2 / SLA claims are roadmap-only.
//
// Secrets come only from the environment. Nothing secret is logged or
// returned by an API route.

const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./db");
const billing = require("./billing");
const { carrierStatus } = require("./carrier");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

// --- sessions (stateless signed cookie) ----------------------------------
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("base64");
  console.warn("[vox] SESSION_SECRET is not set; logins will be forgotten on restart. Set SESSION_SECRET in the environment.");
}

function signCookie(userId) {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(userId).digest("base64url");
  return userId + "." + sig;
}

function verifyCookie(value) {
  if (!value) return null;
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const userId = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(userId).digest("base64url");
  try {
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  return userId;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// --- passwords (scrypt, same convention as the starter) -------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return "scrypt:" + salt + ":" + hash;
}

function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split(":");
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}

// --- owner login (environment only, hashed at boot) -----------------------
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";
const OWNER_PASSWORD_HASH = process.env.OWNER_PASSWORD ? hashPassword(process.env.OWNER_PASSWORD) : null;
const ownerEnabled = Boolean(OWNER_EMAIL && OWNER_PASSWORD_HASH);

// --- app ------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");

// Stripe webhook FIRST (needs the raw body for signature verification).
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = billing.verifyStripeWebhook(req.body, req.headers["stripe-signature"]);
    if (event.type === "checkout.session.completed") {
      const { customerId, subscriptionChange } = await billing.applyCheckoutCompleted(event, {
        findOrderBySessionId: db.findOrderBySessionId,
        updateOrder: db.updateOrder,
      });
      if (subscriptionChange && customerId) await db.updateUserSubscription(customerId, subscriptionChange);
      return res.json({ received: true });
    }
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const change = billing.applySubscriptionEvent(event);
      if (change) {
        // Sync status only; seat counts change through a new checkout.
        const orders = await db.allOrders();
        const match = orders.find((o) => o.stripeSubscriptionId === change.stripeSubscriptionId);
        if (match) await db.updateUserSubscription(match.customerId, {
          status: change.status, billingPeriod: (await db.getUserById(match.customerId))?.billingPeriod || null,
          agentCount: (await db.getUserById(match.customerId))?.agentCount || 0,
          stripeSubscriptionId: change.stripeSubscriptionId, stripeCustomerId: null,
        });
      }
      return res.json({ received: true });
    }
    return res.json({ received: true, ignored: event.type });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function requireCustomer(req, res, next) {
  const userId = verifyCookie(parseCookies(req).vox_session);
  if (!userId) return res.status(401).json({ error: "Please log in." });
  const user = await db.getUserById(userId);
  if (!user) return res.status(401).json({ error: "Please log in." });
  req.user = user;
  next();
}

function customerView(user) {
  return {
    id: user.id, businessName: user.businessName, email: user.email,
    subscriptionStatus: user.subscriptionStatus, billingPeriod: user.billingPeriod,
    agentCount: user.agentCount,
  };
}

function orderView(order) {
  return {
    id: order.id, kind: order.kind, status: order.status, paid: order.paid,
    createdAt: order.createdAt, paidAt: order.paidAt, releasedAt: order.releasedAt,
    details: order.details,
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: db.dbKind(), billing: billing.billingConfigured ? "test" : "not_configured", carrier: carrierStatus() });
});

app.get("/api/carrier", (req, res) => res.json(carrierStatus()));

// --- customer auth --------------------------------------------------------
app.post("/api/auth/signup", async (req, res) => {
  const { businessName, email, password } = req.body || {};
  if (!businessName || !email || !password) return res.status(400).json({ error: "Business name, email, and password are required." });
  if (String(password).length < 10) return res.status(400).json({ error: "Password must be at least 10 characters." });
  const existing = await db.findUserByEmail(String(email).toLowerCase());
  if (existing) return res.status(400).json({ error: "An account with that email already exists." });
  const user = await db.createUser({
    businessName: String(businessName), email: String(email).toLowerCase(),
    passwordHash: hashPassword(String(password)),
  });
  res.setHeader("Set-Cookie", `vox_session=${encodeURIComponent(signCookie(user.id))}; HttpOnly; Path=/; SameSite=Lax`);
  res.status(201).json(customerView(user));
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await db.findUserByEmail(String(email).toLowerCase()) : null;
  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  res.setHeader("Set-Cookie", `vox_session=${encodeURIComponent(signCookie(user.id))}; HttpOnly; Path=/; SameSite=Lax`);
  res.json(customerView(user));
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", "vox_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireCustomer, (req, res) => res.json(customerView(req.user)));

// --- billing: pricing, proration, checkout, orders ------------------------
app.get("/api/billing/pricing", (req, res) => {
  res.json({
    subscription: billing.SUBSCRIPTION_PRICES,
    exampleMonthly5Agents: billing.subscriptionTotal("monthly", 5),
    exampleYearly5Agents: billing.SUBSCRIPTION_PRICES.yearly.base + billing.SUBSCRIPTION_PRICES.yearly.perAgent * 5,
    leadPoolSizes: billing.LEAD_POOL_SIZES,
    leadPoolPrices: billing.LEAD_POOL_PRICES,
    billingConfigured: billing.billingConfigured,
  });
});

app.get("/api/billing/proration", (req, res) => {
  try {
    const daysActive = Number(req.query.daysActive);
    const daysInMonth = Number(req.query.daysInMonth);
    const owed = billing.prorationOwedCents({ daysActive, daysInMonth });
    const credit = billing.prorationCreditCents({ daysActive, daysInMonth });
    res.json({ daysActive, daysInMonth, owedCents: owed, owedDollars: owed / 100, creditCents: credit, creditDollars: credit / 100 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/billing/checkout/subscription", requireCustomer, async (req, res) => {
  try {
    const { billingPeriod, agentCount } = req.body || {};
    const total = billing.subscriptionTotal(billingPeriod, Number(agentCount));
    const { order, checkoutUrl, sessionId } = await billing.createSubscriptionCheckout({
      customer: req.user, billingPeriod, agentCount: Number(agentCount),
      baseUrl: PUBLIC_BASE_URL || ("http://localhost:" + PORT),
      createOrder: db.createOrder,
    });
    await db.updateOrder(order.id, { stripeSessionId: sessionId, updatedAt: new Date().toISOString() });
    res.json({ order: orderView({ ...order, stripeSessionId: sessionId }), checkoutUrl, totalDollars: total });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.post("/api/billing/checkout/lead-pool", requireCustomer, async (req, res) => {
  try {
    const { category, size } = req.body || {};
    const price = billing.leadPoolPrice(category, Number(size));
    const { order, checkoutUrl, sessionId } = await billing.createLeadPoolCheckout({
      customer: req.user, category, size: Number(size),
      baseUrl: PUBLIC_BASE_URL || ("http://localhost:" + PORT),
      createOrder: db.createOrder,
    });
    await db.updateOrder(order.id, { stripeSessionId: sessionId, updatedAt: new Date().toISOString() });
    res.json({ order: orderView({ ...order, stripeSessionId: sessionId }), checkoutUrl, priceDollars: price });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.get("/api/billing/orders", requireCustomer, async (req, res) => {
  res.json((await db.ordersForCustomer(req.user.id)).map(orderView));
});

app.get("/api/billing/status", requireCustomer, (req, res) => {
  res.json({
    subscriptionStatus: req.user.subscriptionStatus, billingPeriod: req.user.billingPeriod,
    agentCount: req.user.agentCount, billingConfigured: billing.billingConfigured,
    note: billing.billingConfigured
      ? "Stripe test mode is configured."
      : "Stripe is not configured on this server yet (test keys only).",
  });
});

// --- agents ---------------------------------------------------------------
app.get("/api/agents", requireCustomer, async (req, res) => {
  res.json(await db.listAgents(req.user.id));
});

app.post("/api/agents", requireCustomer, async (req, res) => {
  const rows = Array.isArray(req.body.agents) ? req.body.agents : [req.body];
  const created = [];
  for (const row of rows) {
    if (!row || !row.name || !row.email) return res.status(400).json({ error: "Each agent needs a name and an email." });
    created.push(await db.createAgent(req.user.id, { name: String(row.name), email: String(row.email) }));
  }
  res.status(201).json(created);
});

function daysInCurrentMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

app.post("/api/agents/:id/deactivate", requireCustomer, async (req, res) => {
  const agent = await db.getAgent(req.user.id, req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found." });
  if (agent.status !== "active") return res.status(400).json({ error: "Only an active agent can be deactivated." });
  const daysInMonth = Number(req.body.daysInMonth) || daysInCurrentMonth();
  let daysActive = Number(req.body.daysActive);
  if (!Number.isInteger(daysActive)) {
    const created = new Date(agent.createdAt);
    const now = new Date();
    daysActive = Math.max(1, Math.min(daysInMonth, Math.ceil((now - created) / 86400000)));
  }
  let owed, credit;
  try {
    owed = billing.prorationOwedCents({ daysActive, daysInMonth });
    credit = billing.prorationCreditCents({ daysActive, daysInMonth });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const updated = await db.updateAgent(req.user.id, agent.id, {
    status: "inactive", deactivatedAt: new Date().toISOString(),
    prorationOwedCents: owed, prorationCreditCents: credit,
  });
  res.json({
    ...updated,
    proration: {
      daysActive, daysInMonth, owedDollars: owed / 100, creditDollars: credit / 100,
      note: "Proration is recorded as a credit; no automatic refund is issued. The operator applies any credit in the Stripe dashboard.",
    },
  });
});

app.post("/api/agents/:id/reactivate", requireCustomer, async (req, res) => {
  const agent = await db.getAgent(req.user.id, req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found." });
  const updated = await db.updateAgent(req.user.id, agent.id, {
    status: "active", deactivatedAt: null, prorationOwedCents: null, prorationCreditCents: null,
  });
  res.json(updated);
});

app.delete("/api/agents/:id", requireCustomer, async (req, res) => {
  const agent = await db.getAgent(req.user.id, req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found." });
  await db.deleteAgent(req.user.id, agent.id);
  res.json({ ok: true, removed: agent.id });
});

// --- leads ----------------------------------------------------------------
app.get("/api/leads", requireCustomer, async (req, res) => {
  res.json(await db.listLeads(req.user.id));
});

app.post("/api/leads", requireCustomer, async (req, res) => {
  const { name, phone, email, source } = req.body || {};
  if (!name) return res.status(400).json({ error: "Lead name is required." });
  res.status(201).json(await db.addLead(req.user.id, { name: String(name), phone, email, source }));
});

app.post("/api/leads/import", requireCustomer, async (req, res) => {
  // Free Import My Own Leads path: leads from ANY source work in the
  // dialer. Accepts an array of { name, phone, email } rows.
  const rows = Array.isArray(req.body.leads) ? req.body.leads : [];
  if (!rows.length) return res.status(400).json({ error: "Provide leads as an array." });
  const created = [];
  for (const row of rows) {
    if (row && row.name) created.push(await db.addLead(req.user.id, { name: String(row.name), phone: row.phone, email: row.email, source: row.source || "import" }));
  }
  res.status(201).json({ imported: created.length, leads: created });
});

// --- calls (demo-safe sample data; no live calls are placed) --------------
const SAMPLE_CALLS = [
  { id: "call_1", caller: "Sample Caller A", direction: "inbound", status: "completed", durationSeconds: 187, agent: "Sample Agent", startedAt: "2026-10-27T14:02:00Z" },
  { id: "call_2", caller: "Sample Caller B", direction: "outbound", status: "completed", durationSeconds: 243, agent: "Sample Agent", startedAt: "2026-10-27T14:19:00Z" },
  { id: "call_3", caller: "Sample Caller C", direction: "inbound", status: "missed", durationSeconds: 0, agent: null, startedAt: "2026-10-27T14:41:00Z" },
];

app.get("/api/calls", requireCustomer, (req, res) => {
  res.json({ demo: true, carrier: carrierStatus(), calls: SAMPLE_CALLS });
});

app.post("/api/calls/incoming-demo", requireCustomer, (req, res) => {
  // Demo incoming-call pop-up payload (sample caller, not a real call).
  res.json({
    demo: true,
    caller: { name: "Sample Caller", phone: "Sample number", reason: "Sample inquiry", notes: "Demo pop-up only — no live call is connected." },
    actions: ["Answer", "End"],
  });
});

// --- owner console --------------------------------------------------------
function requireOwner(req, res, next) {
  if (!ownerEnabled) return res.status(503).json({ error: "Owner access is not enabled on this server (OWNER_EMAIL / OWNER_PASSWORD are not set)." });
  const userId = verifyCookie(parseCookies(req).vox_owner);
  if (userId !== "owner") return res.status(401).json({ error: "Owner login required." });
  next();
}

app.post("/api/owner/login", (req, res) => {
  if (!ownerEnabled) return res.status(503).json({ error: "Owner access is not enabled on this server." });
  const { email, password } = req.body || {};
  if (String(email).toLowerCase() !== OWNER_EMAIL.toLowerCase() || !verifyPassword(String(password || ""), OWNER_PASSWORD_HASH)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  res.setHeader("Set-Cookie", `vox_owner=${encodeURIComponent(signCookie("owner"))}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ ok: true, owner: true });
});

app.get("/api/owner/summary", requireOwner, async (req, res) => {
  const customers = await db.listUsers();
  const orders = await db.allOrders();
  res.json({
    customers: customers.length,
    orders: orders.length,
    pendingOwner: orders.filter((o) => o.status === "pending_owner").length,
    carrier: carrierStatus(),
  });
});

app.get("/api/owner/customers", requireOwner, async (req, res) => res.json(await db.listUsers()));

app.get("/api/owner/orders", requireOwner, async (req, res) => {
  const orders = await db.allOrders();
  const customers = await db.listUsers();
  const byId = Object.fromEntries(customers.map((c) => [c.id, c.email]));
  res.json(orders.map((o) => ({ ...orderView(o), customerId: o.customerId, customerEmail: byId[o.customerId] || null })));
});

app.post("/api/owner/orders/:id/release", requireOwner, async (req, res) => {
  const order = await db.findOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.kind !== "lead_pool") return res.status(400).json({ error: "Only Lead Pool orders go through owner release." });
  if (!order.paid || order.status !== "pending_owner") {
    return res.status(400).json({ error: "This order cannot be released yet — it must be paid and awaiting owner review first." });
  }
  const now = new Date().toISOString();
  const released = await db.updateOrder(order.id, { status: "released", releasedAt: now, updatedAt: now });
  res.json(orderView(released));
});

// --- billing result pages --------------------------------------------------
app.get("/billing/success", (req, res) => {
  res.send("<h1>Payment received (test mode)</h1><p>Thank you. Lead Pool orders wait for owner review before delivery — no scrub, no delivery.</p>");
});

app.get("/billing/cancel", (req, res) => {
  res.send("<h1>Checkout canceled</h1><p>No charge was made. You can return and try again.</p>");
});

// SPA fallback (after API + static).
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function main() {
  await db.init();
  if (billing.stripeHasLiveKey) {
    console.warn("[vox] A live Stripe key was found and REFUSED. Billing is disabled; use test-mode keys only.");
  }
  if (!billing.billingConfigured) {
    console.warn("[vox] Stripe is not configured (test keys only). Billing endpoints answer 503 until test keys are set.");
  }
  app.listen(PORT, () => {
    console.log(`[vox] Listening on port ${PORT} (db: ${db.dbKind()}, carrier: ${carrierStatus().configured ? "configured" : "deferred"})`);
  });
}

if (require.main === module) main();

module.exports = { app, hashPassword, verifyPassword };
