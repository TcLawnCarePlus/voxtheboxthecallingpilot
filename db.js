// VoxTheBoxTheCallingPilot — data store.
//
// Postgres when DATABASE_URL is set (Render), otherwise a local SQLite
// file (local testing only). Same tables and same function shapes on
// both backends. Nothing secret lives here; passwords are scrypt-hashed
// by server.js before they reach these functions.

const path = require("path");
const crypto = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL || "";
const usePostgres = Boolean(DATABASE_URL);

let pgPool = null;
let sqliteDb = null;

const TABLES_SQL = {
  users: `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, business_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
    subscription_status TEXT NOT NULL DEFAULT 'trial',
    billing_period TEXT, agent_count INTEGER NOT NULL DEFAULT 0,
    stripe_subscription_id TEXT, stripe_customer_id TEXT)`,
  agents: `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT NOT NULL,
    email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, deactivated_at TEXT,
    proration_owed_cents INTEGER, proration_credit_cents INTEGER,
    work_minutes INTEGER NOT NULL DEFAULT 0)`,
  orders: `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
    stripe_session_id TEXT, stripe_subscription_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    paid_at TEXT, released_at TEXT, details_json TEXT NOT NULL DEFAULT '{}')`,
  leads: `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT NOT NULL,
    phone TEXT, email TEXT, source TEXT NOT NULL DEFAULT 'import',
    status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL)`,
  settings: `CREATE TABLE IF NOT EXISTS settings (
    customer_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL DEFAULT '""',
    PRIMARY KEY (customer_id, key))`,
};

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(9).toString("base64url");
}

function toOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    kind: row.kind,
    status: row.status,
    paid: row.paid === 1 || row.paid === true,
    stripeSessionId: row.stripe_session_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at || null,
    releasedAt: row.released_at || null,
    details: JSON.parse(row.details_json || "{}"),
  };
}

function toAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at || null,
    prorationOwedCents: row.proration_owed_cents,
    prorationCreditCents: row.proration_credit_cents,
    workMinutes: row.work_minutes || 0,
  };
}

async function init() {
  if (usePostgres) {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: DATABASE_URL });
    for (const sql of Object.values(TABLES_SQL)) await pgPool.query(sql);
  } else {
    const { DatabaseSync } = require("node:sqlite");
    const file = process.env.SQLITE_FILE || path.join(__dirname, "data.sqlite");
    sqliteDb = new DatabaseSync(file);
    for (const sql of Object.values(TABLES_SQL)) sqliteDb.exec(sql);
  }
}

function dbKind() {
  return usePostgres ? "postgres" : "sqlite";
}

// --- tiny query helpers -------------------------------------------------
async function pgQuery(sql, params) {
  return pgPool.query(sql, params);
}

function sqlRows(sql, params) {
  return sqliteDb.prepare(sql).all(...params);
}

function sqlRow(sql, params) {
  return sqliteDb.prepare(sql).get(...params) || null;
}

function sqlRun(sql, params) {
  sqliteDb.prepare(sql).run(...params);
}

// --- users --------------------------------------------------------------
async function createUser({ businessName, email, passwordHash }) {
  const id = newId("cus");
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgQuery(
      "INSERT INTO users (id, business_name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, businessName, email, passwordHash, now]
    );
  } else {
    sqlRun("INSERT INTO users (id, business_name, email, password_hash, created_at) VALUES (?,?,?,?,?)",
      [id, businessName, email, passwordHash, now]);
  }
  return { id, businessName, email, createdAt: now, subscriptionStatus: "trial", billingPeriod: null, agentCount: 0 };
}

async function findUserByEmail(email) {
  const row = usePostgres
    ? (await pgQuery("SELECT * FROM users WHERE email = $1", [email])).rows[0]
    : sqlRow("SELECT * FROM users WHERE email = ?", [email]);
  if (!row) return null;
  return {
    id: row.id, businessName: row.business_name, email: row.email,
    passwordHash: row.password_hash, createdAt: row.created_at,
    subscriptionStatus: row.subscription_status, billingPeriod: row.billing_period,
    agentCount: row.agent_count, stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
  };
}

async function getUserById(id) {
  const row = usePostgres
    ? (await pgQuery("SELECT * FROM users WHERE id = $1", [id])).rows[0]
    : sqlRow("SELECT * FROM users WHERE id = ?", [id]);
  if (!row) return null;
  return {
    id: row.id, businessName: row.business_name, email: row.email,
    createdAt: row.created_at, subscriptionStatus: row.subscription_status,
    billingPeriod: row.billing_period, agentCount: row.agent_count,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCustomerId: row.stripe_customer_id,
  };
}

async function listUsers() {
  const rows = usePostgres
    ? (await pgQuery("SELECT id, business_name, email, created_at, subscription_status, billing_period, agent_count FROM users ORDER BY created_at")).rows
    : sqlRows("SELECT id, business_name, email, created_at, subscription_status, billing_period, agent_count FROM users ORDER BY created_at", []);
  return rows.map((r) => ({
    id: r.id, businessName: r.business_name, email: r.email, createdAt: r.created_at,
    subscriptionStatus: r.subscription_status, billingPeriod: r.billing_period, agentCount: r.agent_count,
  }));
}

async function updateUserSubscription(id, change) {
  if (usePostgres) {
    await pgQuery(
      "UPDATE users SET subscription_status = $1, billing_period = $2, agent_count = $3, stripe_subscription_id = COALESCE($4, stripe_subscription_id), stripe_customer_id = COALESCE($5, stripe_customer_id) WHERE id = $6",
      [change.status, change.billingPeriod, change.agentCount, change.stripeSubscriptionId || null, change.stripeCustomerId || null, id]
    );
  } else {
    sqlRun(
      "UPDATE users SET subscription_status = ?, billing_period = ?, agent_count = ?, stripe_subscription_id = COALESCE(?, stripe_subscription_id), stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?",
      [change.status, change.billingPeriod, change.agentCount, change.stripeSubscriptionId || null, change.stripeCustomerId || null, id]
    );
  }
}

// --- agents -------------------------------------------------------------
async function listAgents(customerId) {
  const rows = usePostgres
    ? (await pgQuery("SELECT * FROM agents WHERE customer_id = $1 ORDER BY created_at", [customerId])).rows
    : sqlRows("SELECT * FROM agents WHERE customer_id = ? ORDER BY created_at", [customerId]);
  return rows.map(toAgent);
}

async function createAgent(customerId, { name, email }) {
  const id = newId("agt");
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgQuery("INSERT INTO agents (id, customer_id, name, email, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, customerId, name, email, now]);
  } else {
    sqlRun("INSERT INTO agents (id, customer_id, name, email, created_at) VALUES (?,?,?,?,?)",
      [id, customerId, name, email, now]);
  }
  return { id, customerId, name, email, status: "active", createdAt: now, workMinutes: 0 };
}

async function getAgent(customerId, agentId) {
  const row = usePostgres
    ? (await pgQuery("SELECT * FROM agents WHERE id = $1 AND customer_id = $2", [agentId, customerId])).rows[0]
    : sqlRow("SELECT * FROM agents WHERE id = ? AND customer_id = ?", [agentId, customerId]);
  return toAgent(row);
}

async function updateAgent(customerId, agentId, patch) {
  const sets = [];
  const params = [];
  let i = 1;
  const ph = () => (usePostgres ? "$" + i++ : "?");
  if (patch.status !== undefined) { sets.push("status = " + ph()); params.push(patch.status); }
  if (patch.deactivatedAt !== undefined) { sets.push("deactivated_at = " + ph()); params.push(patch.deactivatedAt); }
  if (patch.prorationOwedCents !== undefined) { sets.push("proration_owed_cents = " + ph()); params.push(patch.prorationOwedCents); }
  if (patch.prorationCreditCents !== undefined) { sets.push("proration_credit_cents = " + ph()); params.push(patch.prorationCreditCents); }
  if (patch.workMinutes !== undefined) { sets.push("work_minutes = " + ph()); params.push(patch.workMinutes); }
  if (!sets.length) return getAgent(customerId, agentId);
  params.push(agentId, customerId);
  const sql = `UPDATE agents SET ${sets.join(", ")} WHERE id = ${ph()} AND customer_id = ${ph()}`;
  if (usePostgres) await pgQuery(sql, params); else sqlRun(sql, params);
  return getAgent(customerId, agentId);
}

async function deleteAgent(customerId, agentId) {
  if (usePostgres) await pgQuery("DELETE FROM agents WHERE id = $1 AND customer_id = $2", [agentId, customerId]);
  else sqlRun("DELETE FROM agents WHERE id = ? AND customer_id = ?", [agentId, customerId]);
}

// --- orders -------------------------------------------------------------
async function createOrder({ customerId, kind, details }) {
  const id = newId("ord");
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgQuery(
      "INSERT INTO orders (id, customer_id, kind, status, paid, created_at, updated_at, details_json) VALUES ($1,$2,$3,'awaiting_payment',0,$4,$4,$5)",
      [id, customerId, kind, now, JSON.stringify(details)]
    );
  } else {
    sqlRun(
      "INSERT INTO orders (id, customer_id, kind, status, paid, created_at, updated_at, details_json) VALUES (?,?,?,'awaiting_payment',0,?,?,?)",
      [id, customerId, kind, now, now, JSON.stringify(details)]
    );
  }
  return { id, customerId, kind, status: "awaiting_payment", paid: false, createdAt: now, updatedAt: now, details };
}

async function findOrderBySessionId(sessionId) {
  const row = usePostgres
    ? (await pgQuery("SELECT * FROM orders WHERE stripe_session_id = $1", [sessionId])).rows[0]
    : sqlRow("SELECT * FROM orders WHERE stripe_session_id = ?", [sessionId]);
  return toOrder(row);
}

async function findOrderById(id) {
  const row = usePostgres
    ? (await pgQuery("SELECT * FROM orders WHERE id = $1", [id])).rows[0]
    : sqlRow("SELECT * FROM orders WHERE id = ?", [id]);
  return toOrder(row);
}

async function ordersForCustomer(customerId) {
  const rows = usePostgres
    ? (await pgQuery("SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC", [customerId])).rows
    : sqlRows("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC", [customerId]);
  return rows.map(toOrder);
}

async function allOrders() {
  const rows = usePostgres
    ? (await pgQuery("SELECT * FROM orders ORDER BY created_at DESC")).rows
    : sqlRows("SELECT * FROM orders ORDER BY created_at DESC", []);
  return rows.map(toOrder);
}

async function updateOrder(id, patch) {
  const sets = [];
  const params = [];
  let i = 1;
  const ph = () => (usePostgres ? "$" + i++ : "?");
  if (patch.status !== undefined) { sets.push("status = " + ph()); params.push(patch.status); }
  if (patch.paid !== undefined) { sets.push("paid = " + ph()); params.push(patch.paid ? 1 : 0); }
  if (patch.paidAt !== undefined) { sets.push("paid_at = " + ph()); params.push(patch.paidAt); }
  if (patch.releasedAt !== undefined) { sets.push("released_at = " + ph()); params.push(patch.releasedAt); }
  if (patch.updatedAt !== undefined) { sets.push("updated_at = " + ph()); params.push(patch.updatedAt); }
  if (patch.stripeSessionId !== undefined) { sets.push("stripe_session_id = " + ph()); params.push(patch.stripeSessionId); }
  if (patch.stripeSubscriptionId !== undefined) { sets.push("stripe_subscription_id = " + ph()); params.push(patch.stripeSubscriptionId); }
  if (!sets.length) return findOrderById(id);
  params.push(id);
  const sql = `UPDATE orders SET ${sets.join(", ")} WHERE id = ${ph()}`;
  if (usePostgres) await pgQuery(sql, params); else sqlRun(sql, params);
  return findOrderById(id);
}

// --- leads --------------------------------------------------------------
async function listLeads(customerId) {
  const rows = usePostgres
    ? (await pgQuery("SELECT * FROM leads WHERE customer_id = $1 ORDER BY created_at DESC", [customerId])).rows
    : sqlRows("SELECT * FROM leads WHERE customer_id = ? ORDER BY created_at DESC", [customerId]);
  return rows.map((r) => ({
    id: r.id, customerId: r.customer_id, name: r.name, phone: r.phone,
    email: r.email, source: r.source, status: r.status, createdAt: r.created_at,
  }));
}

async function addLead(customerId, { name, phone, email, source }) {
  const id = newId("lead");
  const now = new Date().toISOString();
  if (usePostgres) {
    await pgQuery("INSERT INTO leads (id, customer_id, name, phone, email, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id, customerId, name, phone || null, email || null, source || "import", now]);
  } else {
    sqlRun("INSERT INTO leads (id, customer_id, name, phone, email, source, created_at) VALUES (?,?,?,?,?,?,?)",
      [id, customerId, name, phone || null, email || null, source || "import", now]);
  }
  return { id, customerId, name, phone: phone || null, email: email || null, source: source || "import", status: "new", createdAt: now };
}

// --- settings (per customer, e.g. owner ding email) ----------------------
async function getSetting(customerId, key, fallback) {
  const row = usePostgres
    ? (await pgQuery("SELECT value_json FROM settings WHERE customer_id = $1 AND key = $2", [customerId, key])).rows[0]
    : sqlRow("SELECT value_json FROM settings WHERE customer_id = ? AND key = ?", [customerId, key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

async function setSetting(customerId, key, value) {
  const json = JSON.stringify(value);
  if (usePostgres) {
    await pgQuery(
      "INSERT INTO settings (customer_id, key, value_json) VALUES ($1,$2,$3) ON CONFLICT (customer_id, key) DO UPDATE SET value_json = EXCLUDED.value_json",
      [customerId, key, json]
    );
  } else {
    sqlRun("INSERT INTO settings (customer_id, key, value_json) VALUES (?,?,?) ON CONFLICT(customer_id, key) DO UPDATE SET value_json = excluded.value_json",
      [customerId, key, json]);
  }
  return value;
}

module.exports = {
  init, dbKind, newId,
  createUser, findUserByEmail, getUserById, listUsers, updateUserSubscription,
  listAgents, createAgent, getAgent, updateAgent, deleteAgent,
  createOrder, findOrderBySessionId, findOrderById, ordersForCustomer, allOrders, updateOrder,
  listLeads, addLead, getSetting, setSetting,
};
