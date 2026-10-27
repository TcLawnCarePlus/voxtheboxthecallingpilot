// VoxTheBoxTheCallingPilot — frontend logic (demo build).
// Lead Pool tables match the settled prices; clicking a category
// reprices everything instantly.

const LP_SIZES = [1000, 2500, 5000, 10000, 20000, 40000, 60000, 100000];
const LP_PRICES = {
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
let lpCategory = "Home Improvement";

function showPage(name) {
  document.querySelectorAll("section.page").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById("page-" + name);
  if (el) el.classList.add("active");
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  window.scrollTo(0, 0);
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...(opts || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Request failed: " + res.status));
  return data;
}

function money(n) { return "$" + Number(n).toLocaleString("en-US"); }

// --- Lead Pool ------------------------------------------------------------
function renderLpCats() {
  const wrap = document.getElementById("lp-cats");
  wrap.innerHTML = "";
  Object.keys(LP_PRICES).forEach((cat) => {
    const el = document.createElement("span");
    el.className = "pill" + (cat === lpCategory ? " active" : "");
    el.textContent = cat;
    el.onclick = () => { lpCategory = cat; renderLpCats(); renderLpTable(); };
    wrap.appendChild(el);
  });
}
function renderLpTable() {
  const table = LP_PRICES[lpCategory];
  const tbody = document.querySelector("#lp-table tbody");
  tbody.innerHTML = "";
  LP_SIZES.forEach((size, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + size.toLocaleString("en-US") + "</td><td>" + money(table[i]) + "</td>";
    tbody.appendChild(tr);
  });
  const size = Number(document.getElementById("lp-size").value);
  const idx = LP_SIZES.indexOf(size);
  document.getElementById("lp-price").textContent = money(table[idx]) + " for " + size.toLocaleString("en-US") + " " + lpCategory + " leads";
}
document.getElementById("lp-size").addEventListener("change", renderLpTable);
renderLpCats(); renderLpTable();

async function buyLeadPool() {
  try {
    const size = Number(document.getElementById("lp-size").value);
    const res = await api("/api/billing/checkout/lead-pool", { method: "POST", body: JSON.stringify({ category: lpCategory, size }) });
    document.getElementById("lp-msg").textContent = "Checkout created (test mode). Order " + res.order.id + " awaits payment; once paid it lands in pending_owner for owner review.";
  } catch (e) { document.getElementById("lp-msg").textContent = e.message; }
}

// --- Billing ---------------------------------------------------------------
function calcBilling() {
  const period = document.getElementById("bill-period").value;
  const agents = Number(document.getElementById("bill-agents").value) || 0;
  const base = period === "yearly" ? 990 : 99;
  const per = period === "yearly" ? 1025 : 112;
  document.getElementById("bill-total").textContent = money(base + per * agents) + (period === "yearly" ? "/year" : "/month");
}
calcBilling();
document.getElementById("bill-period").addEventListener("change", calcBilling);
document.getElementById("bill-agents").addEventListener("input", calcBilling);

async function checkoutSub() {
  try {
    const period = document.getElementById("bill-period").value;
    const agentCount = Number(document.getElementById("bill-agents").value) || 1;
    const res = await api("/api/billing/checkout/subscription", { method: "POST", body: JSON.stringify({ billingPeriod: period, agentCount }) });
    document.getElementById("bill-msg").textContent = "Checkout created (test mode). Total " + money(res.totalDollars) + ". Open the checkout link to continue in test mode.";
  } catch (e) { document.getElementById("bill-msg").textContent = e.message; }
}

async function calcProration() {
  try {
    const daysActive = Number(document.getElementById("pro-days").value);
    const daysInMonth = Number(document.getElementById("pro-month").value);
    const res = await fetch("/api/billing/proration?daysActive=" + daysActive + "&daysInMonth=" + daysInMonth).then((r) => r.json());
    document.getElementById("pro-msg").textContent = "Owed " + money(res.owedDollars) + " · Credit for unused days " + money(res.creditDollars) + ".";
  } catch (e) { document.getElementById("pro-msg").textContent = e.message; }
}

async function loadOrders() {
  try {
    const orders = await api("/api/billing/orders");
    document.getElementById("orders-list").innerHTML = orders.length
      ? orders.map((o) => "<p>" + o.kind + " — " + o.status + " — " + money((o.details.amountCents || 0) / 100) + "</p>").join("")
      : "<p class='muted'>No orders yet.</p>";
  } catch (e) { document.getElementById("orders-list").textContent = e.message; }
}

// --- Auth ------------------------------------------------------------------
async function signup() {
  try {
    const res = await api("/api/auth/signup", { method: "POST", body: JSON.stringify({
      businessName: document.getElementById("su-business").value,
      email: document.getElementById("su-email").value,
      password: document.getElementById("su-password").value }) });
    document.getElementById("auth-msg").textContent = "Welcome, " + res.businessName + ". You are logged in.";
  } catch (e) { document.getElementById("auth-msg").textContent = e.message; }
}
async function login() {
  try {
    const res = await api("/api/auth/login", { method: "POST", body: JSON.stringify({
      email: document.getElementById("su-email").value,
      password: document.getElementById("su-password").value }) });
    document.getElementById("auth-msg").textContent = "Welcome back, " + res.businessName + ".";
  } catch (e) { document.getElementById("auth-msg").textContent = e.message; }
}
async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  document.getElementById("auth-msg").textContent = "Logged out.";
}

// --- Agents -----------------------------------------------------------------
async function addAgent() {
  try {
    const res = await api("/api/agents", { method: "POST", body: JSON.stringify({
      name: document.getElementById("agent-name").value,
      email: document.getElementById("agent-email").value }) });
    document.getElementById("agent-msg").textContent = "Agent added: " + res.map((a) => a.name).join(", ");
    loadAgents();
  } catch (e) { document.getElementById("agent-msg").textContent = e.message; }
}
async function loadAgents() {
  try {
    const agents = await api("/api/agents");
    document.getElementById("agents-list").innerHTML = agents.length ? agents.map((a) =>
      "<p>" + a.name + " (" + a.email + ") — " + a.status +
      " <button class='secondary' onclick=\"agentAction('" + a.id + "','deactivate')\">Deactivate</button>" +
      " <button class='secondary' onclick=\"agentAction('" + a.id + "','reactivate')\">Reactivate</button>" +
      " <button class='secondary' onclick=\"agentRemove('" + a.id + "')\">Remove</button></p>").join("")
      : "<p class='muted'>No agents yet.</p>";
  } catch (e) { document.getElementById("agents-list").textContent = e.message; }
}
async function agentAction(id, action) {
  try {
    const body = action === "deactivate" ? JSON.stringify({ daysActive: 15, daysInMonth: 30 }) : "{}";
    const res = await api("/api/agents/" + id + "/" + action, { method: "POST", body });
    alert(action === "deactivate"
      ? "Deactivated. Proration owed " + money(res.proration.owedDollars) + ", credit " + money(res.proration.creditDollars) + "."
      : "Reactivated.");
    loadAgents();
  } catch (e) { alert(e.message); }
}
async function agentRemove(id) {
  try { await api("/api/agents/" + id, { method: "DELETE" }); loadAgents(); }
  catch (e) { alert(e.message); }
}

// --- Leads / calls -----------------------------------------------------------
async function addLead() {
  try {
    await api("/api/leads", { method: "POST", body: JSON.stringify({
      name: document.getElementById("lead-name").value,
      phone: document.getElementById("lead-phone").value,
      email: document.getElementById("lead-email").value, source: "import" }) });
    document.getElementById("lead-msg").textContent = "Lead added. It works in the dialer.";
    loadLeads();
  } catch (e) { document.getElementById("lead-msg").textContent = e.message; }
}
async function loadLeads() {
  try {
    const leads = await api("/api/leads");
    document.getElementById("leads-list").innerHTML = leads.length
      ? leads.map((l) => "<p>" + l.name + " — " + (l.phone || "") + " — " + l.source + "</p>").join("")
      : "<p class='muted'>No leads yet.</p>";
  } catch (e) { document.getElementById("leads-list").textContent = e.message; }
}
async function loadCalls() {
  try {
    const res = await api("/api/calls");
    document.getElementById("calls-list").innerHTML = res.calls.map((c) =>
      "<p>" + c.caller + " — " + c.direction + " — " + c.status + " — " + c.durationSeconds + "s</p>").join("");
  } catch (e) { document.getElementById("calls-list").textContent = e.message; }
}

// --- Dialer + incoming pop-up ------------------------------------------------
document.querySelectorAll("#dialer-modes .pill").forEach((p) => p.addEventListener("click", () => {
  document.querySelectorAll("#dialer-modes .pill").forEach((x) => x.classList.remove("active"));
  p.classList.add("active");
  document.getElementById("dialer-mode-title").textContent = p.dataset.mode + " dialing (sample)";
}));
function demoCall() { document.getElementById("dialer-msg").textContent = "Sample call started (demo only — no live call is placed)."; }
let timerId = null, seconds = 0;
async function showCallPopup() {
  try {
    const res = await api("/api/calls/incoming-demo", { method: "POST" });
    document.getElementById("popup-caller").textContent = res.caller.name + " — " + res.caller.reason;
    document.getElementById("popup-notes").textContent = res.caller.notes;
  } catch { /* demo popup still shows */ }
  document.getElementById("call-popup").style.display = "block";
}
function answerCall() {
  seconds = 0;
  clearInterval(timerId);
  timerId = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    document.getElementById("popup-timer").textContent = m + ":" + s;
  }, 1000);
}
function endCall() {
  clearInterval(timerId);
  document.getElementById("popup-timer").textContent = "00:00";
  document.getElementById("call-popup").style.display = "none";
}

// --- Owner console -------------------------------------------------------------
async function ownerLogin() {
  try {
    await api("/api/owner/login", { method: "POST", body: JSON.stringify({
      email: document.getElementById("owner-email").value,
      password: document.getElementById("owner-password").value }) });
    document.getElementById("owner-msg").textContent = "Owner logged in.";
  } catch (e) { document.getElementById("owner-msg").textContent = e.message; }
}
async function ownerSummary() {
  try {
    const s = await api("/api/owner/summary");
    document.getElementById("owner-summary").innerHTML = "<p>Customers: " + s.customers + " · Orders: " + s.orders + " · Awaiting owner review: " + s.pendingOwner + "</p>";
  } catch (e) { document.getElementById("owner-summary").textContent = e.message; }
}
async function ownerOrders() {
  try {
    const orders = await api("/api/owner/orders");
    document.getElementById("owner-orders").innerHTML = orders.length ? orders.map((o) =>
      "<p>" + o.kind + " — " + o.status + " — " + (o.customerEmail || o.customerId) +
      (o.status === "pending_owner" ? " <button class='secondary' onclick=\"releaseOrder('" + o.id + "')\">Release</button>" : "") + "</p>").join("")
      : "<p class='muted'>No orders yet.</p>";
  } catch (e) { document.getElementById("owner-orders").textContent = e.message; }
}
async function releaseOrder(id) {
  try { await api("/api/owner/orders/" + id + "/release", { method: "POST" }); ownerOrders(); }
  catch (e) { alert(e.message); }
}
async function ownerCustomers() {
  try {
    const customers = await api("/api/owner/customers");
    document.getElementById("owner-customers").innerHTML = customers.length
      ? customers.map((c) => "<p>" + c.businessName + " — " + c.email + " — " + c.subscriptionStatus + "</p>").join("")
      : "<p class='muted'>No customers yet.</p>";
  } catch (e) { document.getElementById("owner-customers").textContent = e.message; }
}
