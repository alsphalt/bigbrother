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
    $("#walletHistory").innerHTML=wallet.transactions.length ? wallet.transactions.map(t=>`<div>${escapeHtml(t.description)} · ${money(t.amount_minor,t.currency)} · ${escapeHtml(t.status)}</div>`).join("") : "No transactions yet.";
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
document.querySelectorAll("[data-method]").forEach(b=>b.addEventListener("click",()=>{
  if(!currentUser){openAuth();return;}
  selectedMethod=b.dataset.method; $("#depositError").textContent=""; $("#depositModal").showModal();
}));
$("#closeDeposit").addEventListener("click",()=>$("#depositModal").close());
$("#depositForm").addEventListener("submit",async e=>{
  e.preventDefault(); $("#depositError").textContent="";
  try {
    const amount=Number($("#depositAmount").value);
    const result=await api("/api/wallet/deposit-intent",{method:"POST",body:JSON.stringify({amountMinor:Math.round(amount*100),method:selectedMethod})});
    $("#depositError").textContent=result.message;
    await loadAccount();
  } catch(err) { $("#depositError").textContent=err.message; }
});
async function checkout(planId) {
  if(!currentUser){openAuth();return;}
  try { await api("/api/checkout",{method:"POST",body:JSON.stringify({planId})}); }
  catch(e) { alert(e.message); }
}
async function boot(){
  try { const h=await api("/api/health"); $("#projectCount").textContent="0"; }
  catch(e){ $("#projectCount").textContent="—"; }
  await Promise.all([loadPlans(),loadAccount()]);
}
boot();
