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

## Included
- Responsive cyber-themed customer portal
- Email registration and login with bcrypt password hashing
- Session persistence in SQLite
- Google and GitHub OAuth routes (require provider credentials)
- Customer wallet ledger and pending deposit intents
- Hosting plan catalogue
- Customer subscription listing
- Admin summary endpoint (requires an admin role in the database)
- Health endpoint

## Deliberately not enabled
- Real M-Pesa or card collection
- Wallet crediting from browser requests
- Paid checkout
- Bot process start/stop/restart
- Arbitrary shell terminal
- Automatic server provisioning

A deposit intent is only a pending record. It never credits a wallet. Implement a provider-specific server-side callback with signature verification, idempotency, reconciliation, refunds and audit logging before accepting money. Have an eligible adult or registered business own and configure payment-provider accounts and comply with applicable rules.

## OAuth setup
Set `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` in `.env`. Configure callback URLs:
- `${BASE_URL}/auth/google/callback`
- `${BASE_URL}/auth/github/callback`

For production, use HTTPS, rotate secrets, add CSRF protection and rate limiting, verify email ownership, implement account recovery, and use a production session store. Review OAuth account-linking policy before launch.

## Important production hardening
This is a development starter, not a public production hosting panel. Do not expose it publicly with default settings. Add CSRF protection, rate limiting, secure reverse-proxy configuration, backups, email verification, password recovery, audit trails, admin bootstrap procedure, and a dedicated least-privilege runner before enabling deployments or process controls. Keep project processes isolated from the control plane using containers or equivalent OS isolation.
