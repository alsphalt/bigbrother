# Darknote Cloud v0.2

Cyber-themed hosted-bot marketplace and account/wallet foundation.

## Run locally
1. Install Node.js 20+.
2. Extract the ZIP.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Set a random `SESSION_SECRET` (at least 32 characters).
6. Run `npm run dev`.
7. Open `http://localhost:3000`.

## Deploy on Vercel

The app follows Vercel's Express preset: `app.js` exports the Express instance, `server.js` only adds the port listener for local runs, and `vercel.json` pins the framework so a stale project-level preset cannot break the build.

1. Import the repository at [vercel.com/new](https://vercel.com/new) and leave the build settings empty — no build command, no output directory.
2. Add the environment variables: `SESSION_SECRET` (32+ characters), `BASE_URL`, and any `MPESA_*` / OAuth values you use.
3. Deploy.

Notes for the Vercel runtime:

- `public/**` is served by the CDN; `express.static()` is ignored there, which is fine because the files live at the same paths.
- The code bundle is read-only, so SQLite falls back to `/tmp/darknote-cloud` when `DATABASE_DIR` is unwritable. That filesystem is wiped on every cold start: wallets, sessions and deposits do not survive. Point `DATABASE_DIR` at a mounted volume, or move the tables to Postgres, before anyone deposits real money.
- Sessions are signed with `SESSION_SECRET`; without it the app boots with an ephemeral key and signs everyone out on each restart.
- A full deploy of an empty commit fails in Vercel's Express builder, so redeploy the branch that actually contains the app.

## Android app (installable APK)

`android/` holds a thin WebView shell. It loads the deployed site, so **features ship to the app the moment they ship to the website** — no new APK for a new dashboard, setting or button. An APK is only needed when the shell itself changes (icon, permissions, native hooks).

### Install
The site has an **Install app** button in the header and a *Install the app* section. Both lead to `GET /api/app/download`, which redirects to the APK on the newest GitHub release. Android asks for permission to install from that source — nothing is installed silently.

### How the app stays in sync
- `GET /api/app/version` returns `{ website: { version }, apk: { versionCode, versionName, ... } }`.
- The website stamp is `APP_VERSION`, else the Vercel commit SHA, else a hash of `public/index.html`, `app.js`, `style.css`. It is stable per deployment, so cold starts never fake a new release.
- On launch and on resume the app compares that stamp with the last one it saw. If it moved, it shows **NEW VERSION AVAILABLE — A new Darknote Cloud update is ready!** with **UPDATE NOW** (clears the WebView cache and reloads) and **UPDATE LATER** (keep using the current page, ask again next launch).
- If the release carries a higher `versionCode`, the app offers **APP UPDATE AVAILABLE** and opens the APK download. Installing is always the user's tap.
- Sessions live in WebView cookies (the 30-day rolling session cookie), so signing in once survives restarts.

### Build locally
```bash
JAVA_HOME=/path/to/jdk17 ANDROID_HOME=/path/to/android-sdk \
  gradle -p android assembleDebug assembleRelease \
  -PappVersionName=1.0.1 -PappVersionCode=101 \
  -PappBaseUrl=https://brutality-theta.vercel.app
```
Outputs land in `android/app/build/outputs/apk/{debug,release}/`.

### Releases
`.github/workflows/android.yml` builds both flavours on every push that touches `android/` and uploads them as artifacts (debug and release kept separate, 90 days). To publish:

```bash
git tag v1.0.2 && git push origin v1.0.2
```

The tag triggers the build and attaches `darknote-cloud-<version>-release.apk`, the debug APK, and `app-version.json` to the GitHub release. The website's download button and the in-app update check read that release, so they update themselves — no file to edit.

Release signing uses repository secrets when present (`SIGNING_KEYSTORE_BASE64`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`). Without them the release APK is signed with the debug key: fine for sideloading, **not** for Play.

Set the repository variable `APP_BASE_URL` if you fork this to another domain; the default is `https://brutality-theta.vercel.app`.

### Known limits
- Google refuses OAuth inside embedded WebViews, so "Continue with Google" may fail in the app. Email/password and GitHub sign-in work; the browser flow remains available.
- Offline shows a retry screen, not a cached copy of the dashboard.
- The WebView needs the site to be reachable; there is no bundled copy of the site by design.

## Wallet deposits (M-Pesa STK push)

Signed-in customers tap **Deposit to wallet** and a sheet rises from the bottom of the screen:

1. Enter any whole-shilling amount from KSh 1 to KSh 150,000.
2. Enter the Safaricom number that should pay.
3. Tap **Send payment prompt** — M-Pesa shows a PIN prompt on that phone.
4. The sheet waits, polling `GET /api/wallet/deposit/:reference` until the PIN is confirmed.
5. M-Pesa calls `POST /api/mpesa/callback`; only then is the wallet credited and the ledger row completed.

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/wallet/deposit` | Validate amount + number, create a deposit, send the STK push |
| GET | `/api/wallet/deposit/:reference` | Poll status; also re-queries Daraja if the callback is slow |
| POST | `/api/mpesa/callback` | Daraja result webhook — the only path that credits a wallet |

Safety properties:

- A deposit is credited inside one SQLite transaction, guarded by the deposit status, so a replayed or duplicated callback cannot credit twice.
- The callback path accepts an optional shared secret (`MPESA_CALLBACK_SECRET`) in `?k=`; comparison is timing-safe.
- Amounts and phone numbers are re-validated on the server; the browser cannot set the credited amount.
- Unpaid deposits expire after 3 minutes and are marked failed with nothing deducted.

## Staying signed in and keeping data

Sessions are stored in SQLite, not memory, and the cookie is rolling with a 30-day lifetime — close the tab, come back in a week, and the same email, balance and history are still there.

That only holds if `DATABASE_DIR` (or `DATABASE_FILE`) points at storage that survives a deploy. On a serverless host with a read-only or ephemeral filesystem, every restart wipes the database; mount a volume, or move the two tables to Postgres before real users arrive.

## Included
- Responsive cyber-themed customer portal
- Email registration and login with bcrypt password hashing
- Session persistence in SQLite
- Google and GitHub OAuth routes (require provider credentials)
- Customer wallet ledger, M-Pesa STK-push deposits and live balance
- Hosting plan catalogue
- Customer subscription listing
- Admin summary endpoint (requires an admin role in the database)
- Health endpoint

## Deliberately not enabled
- Card collection (M-Pesa only, and only when Daraja credentials are set)
- Wallet crediting from browser requests (only the signed provider callback credits)
- Paid checkout
- Bot process start/stop/restart
- Arbitrary shell terminal
- Automatic server provisioning

Deposits credit the wallet only after M-Pesa confirms the customer's PIN. Before taking real money at scale, still add reconciliation against the M-Pesa statement, refunds, and an audit trail; and have an eligible adult or registered business own the Daraja shortcode and comply with applicable rules.

## OAuth setup
Set `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` in `.env`. Configure callback URLs:
- `${BASE_URL}/auth/google/callback`
- `${BASE_URL}/auth/github/callback`

For production, use HTTPS, rotate secrets, add CSRF protection and rate limiting, verify email ownership, implement account recovery, and use a production session store. Review OAuth account-linking policy before launch.

## Important production hardening
This is a development starter, not a public production hosting panel. Do not expose it publicly with default settings. Add CSRF protection, rate limiting, secure reverse-proxy configuration, backups, email verification, password recovery, audit trails, admin bootstrap procedure, and a dedicated least-privilege runner before enabling deployments or process controls. Keep project processes isolated from the control plane using containers or equivalent OS isolation.
