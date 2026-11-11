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
