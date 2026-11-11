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
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
const app = express();
const db = new Database(path.join(dataDirectory, "darknote-cloud.db"));
const SQLiteStore = SQLiteStoreFactory(session);
const production = process.env.NODE_ENV === "production";

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
  store: new SQLiteStore({ db: "sessions.db", dir: path.join(__dirname, "data") }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret-now",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: production, maxAge: 1000 * 60 * 60 * 12 }
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

app.get("/api/wallet", loginRequired, (req, res) => {
  ensureWallet(req.user.id);
  const wallet = db.prepare("SELECT balance_minor,currency FROM wallets WHERE user_id=?").get(req.user.id);
  const transactions = db.prepare("SELECT type,amount_minor,currency,status,reference,description,created_at FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 30").all(req.user.id);
  res.json({ wallet, transactions, note: "Only verified provider callbacks may create completed deposits. No real-money deposits are enabled in this starter." });
});

// Deposit intent only: no balance is credited until a verified payment-provider callback exists.
app.post("/api/wallet/deposit-intent", loginRequired, (req, res) => {
  const amount = Number(req.body?.amountMinor);
  const method = req.body?.method;
  if (!Number.isSafeInteger(amount) || amount < 10000 || amount > 100000000 || !["mpesa","card"].includes(method)) {
    return res.status(400).json({ error: "Choose a supported method and an amount between KSh 100 and KSh 1,000,000." });
  }
  const reference = makeReference("deposit");
  db.prepare("INSERT INTO wallet_transactions (user_id,type,amount_minor,currency,status,reference,description) VALUES (?,?,?,?,?,?,?)")
    .run(req.user.id, "deposit", amount, "KES", "pending", reference, `${method.toUpperCase()} deposit request — awaiting provider integration`);
  res.status(202).json({ status: "pending", reference, message: "Deposit request recorded. No money has been collected or credited. Payment provider integration is required." });
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
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`Darknote Cloud v0.2 listening on ${port}`));
