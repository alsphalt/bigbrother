import "dotenv/config";
import express from "express";
import helmet from "helmet";
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const production = process.env.NODE_ENV === "production";

// Wallets, ledgers and sessions all live in this directory. Point DATABASE_DIR at a
// mounted volume (or a persistent server) or every deposit is lost on redeploy.
const dataDir = process.env.DATABASE_DIR || path.join(__dirname, "data");
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (e) {
  throw new Error(`Cannot create the data directory at ${dataDir}. Set DATABASE_DIR to a writable, persistent path. ${e.message}`);
}
const dbFile = process.env.DATABASE_FILE || path.join(dataDir, "darknote-cloud.db");
const db = new Database(dbFile);

// ---------- M-Pesa (Safaricom Daraja) configuration ----------
const mpesa = {
  env: (process.env.MPESA_ENV || "sandbox").toLowerCase(),
  consumerKey: process.env.MPESA_CONSUMER_KEY || "",
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || "",
  shortcode: process.env.MPESA_SHORTCODE || "",
  passkey: process.env.MPESA_PASSKEY || "",
  transactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
  callbackUrl: process.env.MPESA_CALLBACK_URL || "",
  callbackSecret: process.env.MPESA_CALLBACK_SECRET || "",
  // Local end-to-end testing only; never active in production.
  simulate: !production && process.env.MPESA_SIMULATE === "1"
};
mpesa.baseUrl = process.env.MPESA_BASE_URL || (mpesa.env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");
mpesa.configured = Boolean(mpesa.consumerKey && mpesa.consumerSecret && mpesa.shortcode && mpesa.passkey && mpesa.callbackUrl);
mpesa.live = mpesa.configured;

const DEPOSIT_MIN_KES = 1;
const DEPOSIT_MAX_KES = 150000; // Safaricom per-transaction ceiling
const DEPOSIT_WINDOW_MS = 3 * 60 * 1000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (production) throw new Error("Set a SESSION_SECRET of at least 32 characters.");
  console.warn("WARNING: Set SESSION_SECRET in .env before deployment.");
}

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')),
  google_id TEXT UNIQUE,
  github_id TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'KES'
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('deposit','purchase','refund','adjustment')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
  reference TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS hosting_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK(price_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  billing_period TEXT NOT NULL DEFAULT 'month',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES hosting_plans(id),
  status TEXT NOT NULL DEFAULT 'pending_provisioning',
  service_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reference TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'KES',
  msisdn TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','failed','cancelled')),
  merchant_request_id TEXT,
  checkout_request_id TEXT UNIQUE,
  provider_receipt TEXT,
  result_code INTEGER,
  result_desc TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
`);

const planCount = db.prepare("SELECT COUNT(*) AS n FROM hosting_plans").get().n;
if (!planCount) {
  const addPlan = db.prepare("INSERT INTO hosting_plans (name,description,price_minor,currency,billing_period) VALUES (?,?,?,?,?)");
  addPlan.run("Bot Starter", "Entry hosting package for one supported bot.", 50000, "KES", "month");
  addPlan.run("Bot Pro", "More resources for a busier bot.", 120000, "KES", "month");
  addPlan.run("Bot Plus", "Higher-capacity hosting package.", 250000, "KES", "month");
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.db", dir: dataDir }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret-now",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    // Stay signed in for 30 days; every visit rolls the window forward.
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare("SELECT id,email,display_name,role,email_verified FROM users WHERE id=?").get(id);
    done(null, user || false);
  } catch (e) { done(e); }
});

function ensureWallet(userId) {
  db.prepare("INSERT OR IGNORE INTO wallets (user_id) VALUES (?)").run(userId);
}
function safeUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role, emailVerified: !!user.email_verified };
}
function loginRequired(req, res, next) {
  if (!req.isAuthenticated?.()) return res.status(401).json({ error: "Please sign in first." });
  next();
}
function adminRequired(req, res, next) {
  if (!req.isAuthenticated?.() || req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function makeReference(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeMsisdn(raw) {
  let n = String(raw || "").replace(/\D/g, "");
  if (n.startsWith("254")) n = n.slice(3);
  else if (n.length === 10 && n.startsWith("0")) n = n.slice(1);
  if (!/^[17]\d{8}$/.test(n)) return null;
  return `254${n}`;
}
function mpesaTimestamp(d = new Date()) {
  const p = v => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function callbackUrl() {
  if (!mpesa.callbackSecret) return mpesa.callbackUrl;
  const u = new URL(mpesa.callbackUrl);
  u.searchParams.set("k", mpesa.callbackSecret);
  return u.toString();
}
function sqliteTimeMs(value) {
  if (!value) return Date.now();
  return new Date(`${value}`.replace(" ", "T") + "Z").getTime();
}

let tokenCache = { value: "", expiresAt: 0 };
async function darajaToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const auth = Buffer.from(`${mpesa.consumerKey}:${mpesa.consumerSecret}`).toString("base64");
  const r = await fetch(`${mpesa.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!r.ok) throw new Error(`M-Pesa authentication failed (${r.status}). Check the consumer key and secret.`);
  const data = await r.json().catch(() => ({}));
  if (!data.access_token) throw new Error("M-Pesa did not return an access token.");
  tokenCache = { value: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return data.access_token;
}

function stkCredentials() {
  const ts = mpesaTimestamp();
  return {
    ts,
    body: {
      BusinessShortCode: mpesa.shortcode,
      Password: Buffer.from(`${mpesa.shortcode}${mpesa.passkey}${ts}`).toString("base64"),
      Timestamp: ts
    }
  };
}

async function stkPush({ amountKes, msisdn, reference }) {
  const token = await darajaToken();
  const { body } = stkCredentials();
  const r = await fetch(`${mpesa.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      TransactionType: mpesa.transactionType,
      Amount: amountKes,
      PartyA: msisdn,
      PartyB: mpesa.shortcode,
      PhoneNumber: msisdn,
      CallBackURL: callbackUrl(),
      AccountReference: `DN${reference.slice(-10)}`,
      TransactionDesc: "Wallet top-up"
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || String(data.ResponseCode) !== "0") {
    throw new Error(data.errorMessage || data.ResponseDescription || `M-Pesa rejected the request (${r.status}).`);
  }
  return data;
}

async function stkQuery(checkoutRequestId) {
  const token = await darajaToken();
  const { body } = stkCredentials();
  const r = await fetch(`${mpesa.baseUrl}/mpesa/stkpushquery/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, CheckoutRequestID: checkoutRequestId })
  });
  return r.json().catch(() => ({}));
}

// Crediting happens only here: one atomic transaction, keyed on the deposit row,
// so a duplicated or replayed callback can never credit twice.
const settleSuccess = db.transaction((depositId, receipt, resultCode, resultDesc) => {
  const dep = db.prepare("SELECT * FROM deposits WHERE id=?").get(depositId);
  if (!dep) return null;
  if (dep.status === "completed") return { deposit: dep, credited: false };
  db.prepare(`UPDATE deposits SET status='completed', provider_receipt=?, result_code=?, result_desc=?,
    completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(receipt, resultCode, resultDesc, depositId);
  ensureWallet(dep.user_id);
  db.prepare("UPDATE wallets SET balance_minor = balance_minor + ? WHERE user_id=?").run(dep.amount_minor, dep.user_id);
  db.prepare(`UPDATE wallet_transactions SET status='completed', description=? WHERE reference=?`)
    .run(`M-Pesa deposit · ${dep.msisdn} · ${receipt}`, dep.reference);
  return { deposit: { ...dep, status: "completed", provider_receipt: receipt }, credited: true };
});

const settleFailure = db.transaction((depositId, resultCode, resultDesc) => {
  const dep = db.prepare("SELECT * FROM deposits WHERE id=?").get(depositId);
  if (!dep || dep.status === "completed") return null;
  db.prepare(`UPDATE deposits SET status='failed', result_code=?, result_desc=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(resultCode, resultDesc, depositId);
  db.prepare("UPDATE wallet_transactions SET status='failed', description=? WHERE reference=?")
    .run(`M-Pesa deposit · ${dep.msisdn} · ${resultDesc}`, dep.reference);
  return dep;
});
function upsertOAuthUser({ email, displayName, provider, providerId }) {
  if (!validEmail(email)) throw new Error("The provider did not return a usable email address.");
  const column = provider === "google" ? "google_id" : "github_id";
  let user = db.prepare(`SELECT * FROM users WHERE ${column}=?`).get(String(providerId));
  if (!user) user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (user) {
    db.prepare(`UPDATE users SET ${column}=?, display_name=? WHERE id=?`).run(String(providerId), displayName || user.display_name, user.id);
    ensureWallet(user.id);
    return db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  }
  const result = db.prepare(`INSERT INTO users (email,display_name,${column},email_verified) VALUES (?,?,?,1)`)
    .run(email.toLowerCase(), displayName || email.split("@")[0], String(providerId));
  ensureWallet(result.lastInsertRowid);
  return db.prepare("SELECT * FROM users WHERE id=?").get(result.lastInsertRowid);
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL || "http://localhost:3000"}/auth/google/callback`
  }, (_at, _rt, profile, done) => {
    try {
      const email = profile.emails?.find(x => x.verified)?.value || profile.emails?.[0]?.value;
      done(null, upsertOAuthUser({ email, displayName: profile.displayName, provider: "google", providerId: profile.id }));
    } catch (e) { done(e); }
  }));
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL || "http://localhost:3000"}/auth/github/callback`,
    scope: ["user:email"]
  }, (_at, _rt, profile, done) => {
    try {
      const email = profile.emails?.find(x => x.primary && x.verified)?.value || profile.emails?.find(x => x.verified)?.value;
      done(null, upsertOAuthUser({ email, displayName: profile.displayName || profile.username, provider: "github", providerId: profile.id }));
    } catch (e) { done(e); }
  }));
}

app.get("/auth/google", (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send("Google sign-in is not configured yet.");
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});
app.get("/auth/google/callback", (req, res, next) => passport.authenticate("google", { failureRedirect: "/?login=failed" })(req, res, next), (_req, res) => res.redirect("/"));
app.get("/auth/github", (req, res, next) => {
  if (!process.env.GITHUB_CLIENT_ID) return res.status(503).send("GitHub sign-in is not configured yet.");
  passport.authenticate("github")(req, res, next);
});
app.get("/auth/github/callback", (req, res, next) => passport.authenticate("github", { failureRedirect: "/?login=failed" })(req, res, next), (_req, res) => res.redirect("/"));

app.post("/api/auth/register", async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!validEmail(email) || typeof password !== "string" || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: "Enter a valid email and a password between 12 and 128 characters." });
  }
  const name = typeof displayName === "string" ? displayName.trim().slice(0, 60) : "";
  if (!name) return res.status(400).json({ error: "Enter your display name." });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (email,password_hash,display_name) VALUES (?,?,?)").run(email.toLowerCase(), hash, name);
    ensureWallet(result.lastInsertRowid);
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(result.lastInsertRowid);
    req.login(user, err => err ? res.status(500).json({ error: "Could not create session." }) : res.status(201).json({ user: safeUser(user) }));
  } catch (e) {
    if (String(e.code).includes("CONSTRAINT")) return res.status(409).json({ error: "An account with this email already exists." });
    res.status(500).json({ error: "Registration failed." });
  }
});
app.post("/api/auth/login", (req, res, next) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || typeof password !== "string") return res.status(400).json({ error: "Enter your email and password." });
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user?.password_hash) return res.status(401).json({ error: "Invalid email or password." });
  bcrypt.compare(password, user.password_hash, (err, ok) => {
    if (err || !ok) return res.status(401).json({ error: "Invalid email or password." });
    req.login(user, loginErr => loginErr ? next(loginErr) : res.json({ user: safeUser(user) }));
  });
});
app.post("/api/auth/logout", loginRequired, (req, res) => req.logout(err => {
  if (err) return res.status(500).json({ error: "Could not sign out." });
  req.session.destroy(() => res.json({ ok: true }));
}));
app.get("/api/me", (req, res) => res.json({ user: req.user ? safeUser(req.user) : null }));

// ---------- wallet deposits: M-Pesa STK push ----------
app.get("/api/wallet", loginRequired, (req, res) => {
  ensureWallet(req.user.id);
  const wallet = db.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=?").get(req.user.id);
  const transactions = db.prepare(`SELECT type,amount_minor,currency,status,reference,description,created_at
    FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 30`).all(req.user.id);
  const deposits = db.prepare(`SELECT reference,amount_minor,currency,msisdn,status,provider_receipt,result_desc,created_at
    FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 10`).all(req.user.id);
  const pending = deposits.filter(d => d.status === "pending" || d.status === "processing");
  res.json({
    wallet,
    transactions,
    deposits,
    pending,
    mpesa: { enabled: mpesa.live || mpesa.simulate, simulated: mpesa.simulate }
  });
});

// Step 1: the customer enters any amount and the M-Pesa number. This sends the
// PIN prompt to that phone; nothing is credited until M-Pesa confirms.
app.post("/api/wallet/deposit", loginRequired, async (req, res) => {
  const amountKes = Number(req.body?.amount ?? req.body?.amountKes);
  const msisdn = normalizeMsisdn(req.body?.phone ?? req.body?.msisdn);
  if (!Number.isInteger(amountKes) || amountKes < DEPOSIT_MIN_KES || amountKes > DEPOSIT_MAX_KES) {
    return res.status(400).json({
      error: `Enter a whole-shilling amount between KSh ${DEPOSIT_MIN_KES} and KSh ${DEPOSIT_MAX_KES.toLocaleString("en-US")}.`
    });
  }
  if (!msisdn) return res.status(400).json({ error: "Enter a valid Safaricom number, for example 0712 345 678." });
  if (!mpesa.live && !mpesa.simulate) {
    return res.status(503).json({
      error: "M-Pesa is not configured on this server yet. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY and MPESA_CALLBACK_URL.",
      code: "mpesa_not_configured"
    });
  }

  const reference = makeReference("dep");
  const amountMinor = amountKes * 100;
  ensureWallet(req.user.id);
  const info = db.prepare("INSERT INTO deposits (user_id,reference,amount_minor,currency,msisdn,status) VALUES (?,?,?,?,?,?)")
    .run(req.user.id, reference, amountMinor, "KES", msisdn, "pending");
  db.prepare("INSERT INTO wallet_transactions (user_id,type,amount_minor,currency,status,reference,description) VALUES (?,?,?,?,?,?,?)")
    .run(req.user.id, "deposit", amountMinor, "KES", "pending", reference, `M-Pesa deposit · ${msisdn} · awaiting PIN`);
  const depositId = info.lastInsertRowid;

  try {
    if (mpesa.simulate) {
      const checkout = `ws_CO_SIM_${reference.slice(-8).toUpperCase()}`;
      db.prepare("UPDATE deposits SET status='processing', merchant_request_id=?, checkout_request_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(`SIM-${reference.slice(-6)}`, checkout, depositId);
      setTimeout(() => {
        try {
          settleSuccess(depositId, `SIM${Date.now().toString().slice(-8)}`, 0, "Simulated payment confirmed");
        } catch (e) { console.error("simulated settle failed", e); }
      }, 4000);
      return res.status(202).json({
        reference,
        amount: amountKes,
        phone: msisdn,
        status: "processing",
        simulated: true,
        message: "Simulated M-Pesa prompt sent. It confirms in about 4 seconds."
      });
    }

    const push = await stkPush({ amountKes, msisdn, reference });
    db.prepare("UPDATE deposits SET status='processing', merchant_request_id=?, checkout_request_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(push.MerchantRequestID || null, push.CheckoutRequestID || null, depositId);
    return res.status(202).json({
      reference,
      amount: amountKes,
      phone: msisdn,
      status: "processing",
      message: push.CustomerMessage || "Check your phone and enter your M-Pesa PIN."
    });
  } catch (e) {
    settleFailure(depositId, null, `Request failed: ${String(e.message).slice(0, 180)}`);
    return res.status(502).json({ error: String(e.message), reference });
  }
});

// Step 2: the sheet polls this until M-Pesa confirms the PIN.
app.get("/api/wallet/deposit/:reference", loginRequired, async (req, res) => {
  let dep = db.prepare("SELECT * FROM deposits WHERE reference=? AND user_id=?").get(req.params.reference, req.user.id);
  if (!dep) return res.status(404).json({ error: "Deposit not found." });

  const age = Date.now() - sqliteTimeMs(dep.created_at);
  const sinceCheck = Date.now() - sqliteTimeMs(dep.last_checked_at || dep.created_at);
  const inFlight = dep.status === "processing";

  if (inFlight && mpesa.live && dep.checkout_request_id && age > 12000 && sinceCheck > 7000) {
    try {
      const q = await stkQuery(dep.checkout_request_id);
      const code = Number(q.ResultCode);
      db.prepare("UPDATE deposits SET last_checked_at=CURRENT_TIMESTAMP WHERE id=?").run(dep.id);
      if (code === 0) {
        settleSuccess(dep.id, q.MpesaReceiptNumber || `Q${Date.now().toString().slice(-10)}`, 0, "Confirmed by M-Pesa status query");
      } else if (!Number.isNaN(code) && String(q.errorCode) !== "500.001.1001") {
        settleFailure(dep.id, code, q.ResultDesc || "Payment was not completed");
      }
      dep = db.prepare("SELECT * FROM deposits WHERE id=?").get(dep.id);
    } catch (e) {
      console.error("M-Pesa status query failed:", e.message);
    }
  }

  if (dep.status === "processing" && age > DEPOSIT_WINDOW_MS) {
    settleFailure(dep.id, 1037, "No PIN entered in time. Nothing was deducted.");
    dep = db.prepare("SELECT * FROM deposits WHERE id=?").get(dep.id);
  }

  const wallet = db.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=?").get(req.user.id);
  res.json({
    reference: dep.reference,
    status: dep.status,
    amount_minor: dep.amount_minor,
    currency: dep.currency,
    phone: dep.msisdn,
    receipt: dep.provider_receipt,
    message: dep.result_desc,
    balance: wallet
  });
});

// Step 3: M-Pesa posts the result here. Public by design, guarded by a shared
// secret on the query string, and idempotent through settleSuccess().
app.post("/api/mpesa/callback", (req, res) => {
  if (mpesa.callbackSecret) {
    const given = Buffer.from(String(req.query.k || ""));
    const want = Buffer.from(mpesa.callbackSecret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      return res.status(403).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }
  }
  try {
    const cb = req.body?.Body?.stkCallback;
    const checkoutId = cb?.CheckoutRequestID;
    if (!checkoutId) return res.status(400).json({ ResultCode: 1, ResultDesc: "Malformed callback" });
    const dep = db.prepare("SELECT * FROM deposits WHERE checkout_request_id=?").get(checkoutId);
    if (!dep) return res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    const code = Number(cb.ResultCode);
    if (code === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      settleSuccess(dep.id, String(receipt || `MPESA${Date.now().toString().slice(-8)}`), code, cb.ResultDesc || "Success");
    } else {
      settleFailure(dep.id, code, cb.ResultDesc || "Payment failed");
    }
  } catch (e) {
    console.error("M-Pesa callback error:", e);
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.get("/api/plans", (_req, res) => {
  res.json(db.prepare("SELECT id,name,description,price_minor,currency,billing_period FROM hosting_plans WHERE active=1 ORDER BY price_minor").all());
});
app.get("/api/subscriptions", loginRequired, (req, res) => {
  res.json(db.prepare(`SELECT s.id,s.service_name,s.status,s.created_at,p.name AS plan_name,p.price_minor,p.currency,p.billing_period
    FROM subscriptions s JOIN hosting_plans p ON p.id=s.plan_id WHERE s.user_id=? ORDER BY s.id DESC`).all(req.user.id));
});

// Checkout is deliberately blocked until a verified payment and provisioning workflow is installed.
app.post("/api/checkout", loginRequired, (_req, res) => {
  res.status(503).json({ error: "Checkout is not enabled yet. Payment verification, refund handling and hosting provisioning must be configured first." });
});

app.get("/api/admin/summary", loginRequired, adminRequired, (_req, res) => {
  res.json({
    users: db.prepare("SELECT COUNT(*) AS n FROM users").get().n,
    pendingDeposits: db.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type='deposit' AND status='pending'").get().n,
    subscriptions: db.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n
  });
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Darknote Cloud", version: "0.2.0" }));
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON body." });
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`Darknote Cloud v0.2 listening on ${port}`));
