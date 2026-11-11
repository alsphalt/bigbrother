const $ = s => document.querySelector(s);
let authMode = "login", currentUser = null, selectedMethod = "mpesa";

function money(minor, currency="KES") {
  return new Intl.NumberFormat("en-KE",{style:"currency",currency,maximumFractionDigits:2}).format(minor/100);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
async function api(url, options={}) {
  const response = await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function loadPlans() {
  try {
    const plans = await api("/api/plans");
    $("#plans").innerHTML = plans.map(p=>`<article class="plan"><span class="eyebrow">HOSTED BOT SERVICE</span><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(p.description)}</p><div class="price">${money(p.price_minor,p.currency)} <small>/ ${escapeHtml(p.billing_period)}</small></div><button class="cta buy" data-plan="${p.id}">Choose hosting</button></article>`).join("");
    document.querySelectorAll(".buy").forEach(b=>b.addEventListener("click",()=>checkout(Number(b.dataset.plan))));
  } catch(e) { $("#plans").textContent=e.message; }
}
async function loadAccount() {
  try {
    const me=await api("/api/me"); currentUser=me.user;
    $("#accountBtn").textContent=currentUser ? currentUser.displayName : "Sign in";
    if (!currentUser) {
      $("#walletBalance").textContent="Sign in";
      $("#walletLarge").textContent="Sign in to view your balance";
      $("#walletHistory").textContent="Sign in to see transactions.";
      $("#serviceList").textContent="Sign in to view services.";
      return;
    }
    const [wallet,services]=await Promise.all([api("/api/wallet"),api("/api/subscriptions")]);
    $("#walletBalance").textContent=money(wallet.wallet.balance_minor,wallet.wallet.currency);
    $("#walletLarge").textContent=money(wallet.wallet.balance_minor,wallet.wallet.currency);
    $("#serviceCount").textContent=services.length;
    const pending=(wallet.deposits||[]).filter(d=>d.status==="pending"||d.status==="processing");
    const rows=[...pending.map(d=>`<div class="row pending"><span>${money(d.amount_minor,d.currency)} · ${escapeHtml(d.msisdn)}</span><b>waiting for PIN</b></div>`),
      ...wallet.transactions.filter(t=>t.status!=="pending").map(t=>`<div class="row"><span>${escapeHtml(t.description)} · ${money(t.amount_minor,t.currency)}</span><b>${escapeHtml(t.status)}</b></div>`)];
    $("#walletHistory").innerHTML=rows.length?rows.join(""):"No transactions yet.";
    if(!wallet.mpesa?.enabled){ $("#depositNote").textContent="M-Pesa is not configured on this server yet — set the Daraja credentials to enable deposits."; }
    $("#serviceList").innerHTML=services.length ? services.map(s=>`<div>${escapeHtml(s.service_name)} · ${escapeHtml(s.plan_name)} · ${escapeHtml(s.status)}</div>`).join("") : "No hosted services yet.";
  } catch(e) { console.error(e); }
}
function openAuth(){ $("#authError").textContent=""; $("#authModal").showModal(); }
function setAuthMode(mode) {
  authMode=mode;
  $("#authTitle").textContent=mode==="login"?"Sign in":"Create account";
  $("#authSubmit").textContent=mode==="login"?"Sign in":"Create account";
  $("#nameWrap").hidden=mode==="login";
  $("#password").autocomplete=mode==="login"?"current-password":"new-password";
  $("#switchAuth").textContent=mode==="login"?"Create an account":"I already have an account";
  $("#authError").textContent="";
}
$("#accountBtn").addEventListener("click",()=>currentUser ? api("/api/auth/logout",{method:"POST"}).then(()=>loadAccount()) : openAuth());
$("#closeAuth").addEventListener("click",()=>$("#authModal").close());
$("#switchAuth").addEventListener("click",()=>setAuthMode(authMode==="login"?"register":"login"));
$("#authForm").addEventListener("submit",async e=>{
  e.preventDefault(); $("#authError").textContent="";
  const body={email:$("#email").value,password:$("#password").value,displayName:$("#displayName").value};
  try {
    await api(authMode==="login"?"/api/auth/login":"/api/auth/register",{method:"POST",body:JSON.stringify(body)});
    $("#authModal").close(); await loadAccount();
  } catch(err) { $("#authError").textContent=err.message; }
});
/* ---------------- wallet deposit sheet ---------------- */
const sheet = $("#depositSheet"), backdrop = $("#sheetBackdrop");
let pollTimer = null, pollStart = 0, activeRef = null;

function prettyPhone(p) {
  const d = String(p || "").replace(/\D/g, "").slice(-9);
  return d.length === 9 ? `+254 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : p;
}
function showStep(name) {
  ["stepAmount", "stepWait", "stepDone"].forEach(id => { $("#" + id).hidden = id !== name; });
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function resetSheet() {
  stopPolling(); activeRef = null;
  $("#sheetError").textContent = "";
  $("#amountInput").value = ""; $("#phoneInput").value = "";
  document.querySelectorAll(".presets button").forEach(b => b.classList.remove("on"));
  $("#payBtn").disabled = false; $("#payBtn").textContent = "Send payment prompt";
  showStep("stepAmount");
}
function openSheet() {
  if (!currentUser) { openAuth(); return; }
  resetSheet();
  backdrop.hidden = false; sheet.hidden = false;
  document.body.classList.add("sheet-open");
  requestAnimationFrame(() => sheet.classList.add("open"));
  setTimeout(() => $("#amountInput").focus(), 320);
}
function closeSheet() {
  stopPolling();
  sheet.classList.remove("open");
  document.body.classList.remove("sheet-open");
  setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 300);
}
function depositFail(message) {
  showStep("stepAmount");
  $("#sheetError").textContent = message;
  $("#payBtn").disabled = false;
  $("#payBtn").textContent = "Try again";
}
function depositDone(d) {
  $("#doneText").textContent = `${money(d.amount_minor, d.currency)} added from ${prettyPhone(d.phone)}`
    + (d.receipt ? ` · receipt ${d.receipt}` : "");
  $("#doneBalance").textContent = money(d.balance.balance_minor, d.balance.currency);
  showStep("stepDone");
  loadAccount();
}
async function pollDeposit() {
  stopPolling();
  const tick = async () => {
    const secs = Math.floor((Date.now() - pollStart) / 1000);
    $("#waitTimer").textContent = `Waiting ${secs}s — keep this screen open`;
    if (secs > 155) { stopPolling(); depositFail("No confirmation arrived. If you entered your PIN, give it a minute and check your wallet. Nothing is credited twice."); return; }
    try {
      const d = await api(`/api/wallet/deposit/${activeRef}`);
      if (d.status === "completed") { stopPolling(); depositDone(d); }
      else if (d.status === "failed") { stopPolling(); depositFail(d.message || "The payment did not go through. Nothing was deducted."); }
    } catch (e) { /* transient network error: keep waiting */ }
  };
  tick();
  pollTimer = setInterval(tick, 2500);
}
async function startDeposit() {
  $("#sheetError").textContent = "";
  const amount = Number($("#amountInput").value);
  let digits = $("#phoneInput").value.replace(/\D/g, "");
  if (digits.startsWith("254")) digits = digits.slice(3);
  else if (digits.startsWith("0")) digits = digits.slice(1);
  if (!Number.isInteger(amount) || amount < 1) return void ($("#sheetError").textContent = "Enter an amount of at least KSh 1.");
  if (amount > 150000) return void ($("#sheetError").textContent = "M-Pesa caps a single payment at KSh 150,000. Send a smaller amount.");
  if (!/^[17]\d{8}$/.test(digits)) return void ($("#sheetError").textContent = "Enter a valid Safaricom number, for example 0712 345 678.");
  $("#payBtn").disabled = true; $("#payBtn").textContent = "Sending prompt…";
  try {
    const res = await api("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ amount, phone: digits }) });
    activeRef = res.reference;
    $("#waitAmount").textContent = money(amount * 100);
    $("#waitPhone").textContent = prettyPhone(digits);
    $("#waitText").textContent = res.message || "Enter your M-Pesa PIN to confirm the deposit.";
    showStep("stepWait");
    pollStart = Date.now();
    pollDeposit();
  } catch (e) {
    $("#payBtn").disabled = false; $("#payBtn").textContent = "Send payment prompt";
    $("#sheetError").textContent = e.message;
  }
}

$("#openDeposit").addEventListener("click", openSheet);
$("#closeSheet").addEventListener("click", closeSheet);
$("#cancelWait").addEventListener("click", closeSheet);
$("#doneClose").addEventListener("click", closeSheet);
backdrop.addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
$("#payBtn").addEventListener("click", startDeposit);
$("#presets").addEventListener("click", e => {
  const b = e.target.closest("button[data-amt]"); if (!b) return;
  $("#amountInput").value = b.dataset.amt;
  document.querySelectorAll(".presets button").forEach(x => x.classList.toggle("on", x === b));
});
document.querySelectorAll("[data-method]").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.method === "card") { alert("Card deposits are not enabled yet. Use M-Pesa."); return; }
  openSheet();
}));

async function checkout(planId) {
  if(!currentUser){openAuth();return;}
  try { await api("/api/checkout",{method:"POST",body:JSON.stringify({planId})}); }
  catch(e) { alert(e.message); }
}
/* ---------------- Android app: install entry point ---------------- */
const androidBridge = window.DarknoteApp || null;
const inAndroidApp = Boolean(androidBridge) || /DarknoteCloud\//.test(navigator.userAgent);

function humanSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
function humanDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
  catch { return ""; }
}

function describeApk(apk) {
  if (!apk) return "No APK published yet — the build workflow attaches it to the first release.";
  const bits = [`v${apk.versionName || "1.0.0"}`];
  if (apk.sizeBytes) bits.push(humanSize(apk.sizeBytes));
  if (apk.publishedAt) bits.push(`updated ${humanDate(apk.publishedAt)}`);
  return bits.join(" · ");
}

async function loadAppMeta() {
  let meta = null;
  try { meta = await api("/api/app/version"); } catch (e) { console.warn("version feed unavailable:", e.message); }

  const apk = meta?.apk || null;
  const label = describeApk(apk);
  if ($("#apkVersion")) $("#apkVersion").textContent = label;
  if ($("#installMeta")) {
    $("#installMeta").textContent = apk
      ? `${label} · direct download from GitHub Releases`
      : label;
  }

  // No release yet: keep the link, but say so instead of offering a broken download.
  for (const id of ["#downloadApk", "#downloadApk2"]) {
    const el = $(id);
    if (!el) continue;
    if (!apk) {
      el.removeAttribute("href");
      el.setAttribute("aria-disabled", "true");
      el.classList.add("disabled");
      el.textContent = "Not published yet";
    } else {
      el.href = "/api/app/download";
      el.classList.remove("disabled");
      el.textContent = "Download APK";
    }
  }

  if (inAndroidApp) {
    document.body.classList.add("in-app");
    const installed = $("#appInstalled");
    if (installed) {
      installed.hidden = false;
      const v = androidBridge?.getVersionName?.();
      installed.textContent = v ? `Installed ✓ v${v}` : "Installed ✓";
    }
    const note = $("#apkNote");
    if (note) note.textContent = "You are using the installed app. Website updates load automatically — no reinstall needed.";
  }
  return meta;
}

function openInstall() {
  loadAppMeta();
  $("#installModal").showModal();
}

if ($("#installApp")) $("#installApp").addEventListener("click", openInstall);
if ($("#installHelp")) $("#installHelp").addEventListener("click", openInstall);
if ($("#closeInstall")) $("#closeInstall").addEventListener("click", () => $("#installModal").close());

async function boot(){
  try { const h=await api("/api/health"); $("#projectCount").textContent="0"; }
  catch(e){ $("#projectCount").textContent="—"; }
  await Promise.all([loadPlans(),loadAccount(),loadAppMeta()]);
}
boot();
