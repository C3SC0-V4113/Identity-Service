# User App Integration Guide

How a portfolio front-end (for example `other-gpt` or `cost-console`) delegates
authentication to `identity-service`. This guide covers the public, end-user
auth surface only. Administrative/machine integration lives in
[Admin & MCP Integration Guide](./integration-admin-mcp.md).

Related decisions: [ADR 0002](./adrs/0002-adopt-session-based-portfolio-identity.md),
[ADR 0007](./adrs/0007-scope-auth-to-project-and-move-session-control-to-admins.md).

## Using the published SDK (recommended)

You do **not** have to hand-write the HTTP client. The cookie surface is published
as a typed client:

```bash
npm install @cesco_valle/identity-auth-sdk
```

```ts
import { createUserAuthClient } from '@cesco_valle/identity-auth-sdk/user';

const auth = createUserAuthClient({ baseUrl: process.env.IDENTITY_URL! });
await auth.login('other-gpt', { email, password }); // sets the session cookie
const ok = await auth.hasValidSession('other-gpt'); // 204 → true, 401 → false
```

The SDK ships ready-made Next.js patterns (Server Action, Route Handler, Server
Component, edge middleware) and reuses the same Zod contracts in
[`@cesco_valle/identity-contracts`](https://www.npmjs.com/package/@cesco_valle/identity-contracts)
that this service validates against, so client and server cannot drift. See the
[SDK README](https://www.npmjs.com/package/@cesco_valle/identity-auth-sdk) for the
full method table and runtime-specific examples.

The rest of this document is the **wire reference** behind that client — read it to
understand the endpoints, error codes, and deployment caveats, or to integrate
without the SDK.

## Mental model

- **Centralized identity, project-scoped access.** A `User` (identified by email)
  is shared across the portfolio, but access, roles, and sessions are scoped to a
  single project. Being a member of `other-gpt` grants nothing in `cost-console`.
- **Your app is a project.** Each app maps to a project `slug` (e.g. `other-gpt`,
  `cost-console`). Every endpoint is mounted under `/projects/:slug/auth/*`, so
  the slug is part of the URL.
- **Stateful, cookie-based sessions.** On register/login the service sets an
  `httpOnly` session cookie. The browser sends it automatically; your JavaScript
  cannot (and should not) read it. There is no JWT and no token for the SPA to
  store.
- **Sessions are project-bound.** A session issued for `other-gpt` cannot
  authenticate requests for `cost-console`, even for the same user.

## The session cookie

| Property   | Value                                                               |
| ---------- | ------------------------------------------------------------------- |
| Name       | `identity_service_session` (configurable via `SESSION_COOKIE_NAME`) |
| `httpOnly` | `true` (not readable from JS)                                       |
| `sameSite` | `lax`                                                               |
| `path`     | `/`                                                                 |
| `secure`   | `true` in production (HTTPS only)                                   |
| Lifetime   | 24 hours (`maxAge` 86400s)                                          |

Because the cookie is `httpOnly`, the integration is simply: send requests with
credentials, and the browser handles the cookie. From `fetch`, always set
`credentials: 'include'`.

### Cross-origin / deployment caveats

The cookie defaults assume the front-end and the API are served on the **same
site**. If your app is on a different origin than `identity-service`, the cross-site
path is supported **by configuration** on the API (no code change):

- **CORS:** disabled by default (`CORS_ORIGIN` unset). Set `CORS_ORIGIN` to your
  front-end origin(s) (comma-separated) to allow cross-origin browser calls;
  `CORS_CREDENTIALS` (default `true`) keeps cookies flowing.
- **`sameSite`:** set `COOKIE_SAMESITE=none` for genuinely cross-site requests;
  this automatically forces the cookie to `secure`. The default `lax` covers
  same-site usage.
- **HTTPS:** `sameSite=none` (and production) makes the cookie `secure`, so the API
  must be served over HTTPS.

See the [Deployment Guide](./deployment.md) for the exact env values. Same-origin
deployment (front-end and API behind one domain/reverse proxy, e.g. the BFF
pattern) avoids all of the above and is the simplest setup.

## Error format

Every error is JSON with a stable machine code:

```json
{ "error": { "code": "AUTHENTICATION_REQUIRED", "message": "Authentication required" } }
```

Validation failures use `400` with `code: "VALIDATION_ERROR"` and an `issues`
array. Codes your app should handle: `VALIDATION_ERROR` (400),
`AUTHENTICATION_REQUIRED` (401), `USER_BANNED` (403), `PROJECT_DISABLED` (403),
`PROJECT_NOT_FOUND` (404), and `409` conflicts on registration.

## Endpoints

All paths are relative to the API base URL; replace `:slug` with your project
slug. Send `credentials: 'include'` (or `curl -c/-b` cookie jar) on every call.

### Check an email before registering — `POST /projects/:slug/auth/register/email-check`

Registration is two-step. Call this first to find out whether the email already
belongs to an ecosystem user.

- **Auth:** none.
- **Request body:** `{ "email": "person@example.com" }`
- **Response `200`:**

```json
{ "email": "person@example.com", "exists": false, "nextStep": "REGISTER" }
```

`nextStep` is `REGISTER` when the email is new (continue to register) or `LOGIN`
when the email already exists (redirect the user to log in instead).

### Register a new user — `POST /projects/:slug/auth/register`

Creates a **new ecosystem user**, an `ACTIVE` membership in this project with the
default role `user`, and a session. Use it only when `email-check` returned
`REGISTER`.

- **Auth:** none.
- **Request body:** `{ "email", "password" (min 8), "displayName?" }`
- **Response `201`:** sets the session cookie and returns the auth payload:

```json
{
  "user": {
    "id": "...",
    "email": "Person@Example.com",
    "displayName": "Person",
    "status": "ACTIVE",
    "createdAt": "..."
  },
  "project": { "id": "...", "slug": "other-gpt", "name": "Other GPT" },
  "membership": {
    "id": "...",
    "status": "ACTIVE",
    "roles": [{ "id": "...", "code": "user", "name": "User" }]
  }
}
```

- **Errors:** `409` if the email already exists (the client should have gone to
  login), `403 PROJECT_DISABLED`, `400 VALIDATION_ERROR`.

### Log in — `POST /projects/:slug/auth/login`

Authenticates an existing user against the shared credential.

- **Auth:** none.
- **Request body:** `{ "email", "password" }`
- **Behavior:** if the user has no membership in this project yet, login
  auto-creates an `ACTIVE` membership with the default `user` role. If the
  membership exists but is `SUSPENDED` or `REVOKED`, login is rejected — it never
  reactivates membership.
- **Response `200`:** sets the session cookie and returns the same auth payload as
  register.
- **Errors:** `401 AUTHENTICATION_REQUIRED` (bad credentials), `403 USER_BANNED`,
  `403 PROJECT_DISABLED`, plus rejection for suspended/revoked membership.

### Log out — `POST /projects/:slug/auth/logout`

Revokes the current session and clears the cookie.

- **Auth:** session cookie.
- **Response `204`:** no body. Safe to call even if already logged out.

### Validate the current session — `GET /projects/:slug/auth/session`

The lightweight, middleware-friendly check. It does **not** return a body or
update activity metadata — use it from route guards / middleware to decide
whether the user is still authenticated.

- **Auth:** session cookie.
- **Response `204`:** the session is valid for this project.
- **Response `401`:** missing, expired, revoked, wrong-project, or banned-user
  session. Treat as "redirect to login".

### Get the current user profile — `GET /projects/:slug/auth/me`

Returns the authenticated user, the project, and the membership/roles for this
project. May refresh session activity (`lastSeenAt`).

- **Auth:** session cookie.
- **Response `200`:** same shape as the register/login auth payload.
- **Response `401`:** not authenticated for this project.

### Get the current user's project access — `GET /projects/:slug/me`

A focused access/authorization view (useful to decide what the UI may show).

- **Auth:** session cookie.
- **Response `200`:**

```json
{
  "project": { "id": "...", "slug": "other-gpt", "name": "Other GPT" },
  "access": {
    "isMember": true,
    "membershipId": "...",
    "status": "ACTIVE",
    "roles": [{ "id": "...", "code": "user", "name": "User" }],
    "isAdmin": false
  }
}
```

## Recommended client flows

### Sign-up

1. User submits email → `POST .../auth/register/email-check`.
2. If `nextStep === "LOGIN"`, route to the login form (email already exists).
3. If `nextStep === "REGISTER"`, collect password/displayName →
   `POST .../auth/register`. The cookie is set; the user is signed in.

### Sign-in

1. `POST .../auth/login` with email + password. On `200` the cookie is set.
2. On `401`/`403`, show the relevant message (bad credentials, banned, disabled,
   suspended/revoked).

### Session-gated routes (middleware)

1. On protected navigations/requests, call `GET .../auth/session`.
2. `204` → proceed. `401` → clear local UI state and redirect to login.
3. Load `GET .../auth/me` (or `GET /projects/:slug/me`) when you actually need the
   profile/roles, not on every request.

### Example (browser `fetch`)

```javascript
// Always include credentials so the browser sends/stores the session cookie.
await fetch(`${API}/projects/other-gpt/auth/login`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const session = await fetch(`${API}/projects/other-gpt/auth/session`, {
  credentials: 'include',
});
if (session.status === 401) {
  // redirect to login
}
```

### Example (`curl` with a cookie jar)

```bash
curl -c jar.txt -X POST "$API/projects/other-gpt/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"person@example.com","password":"supersecret"}'

curl -b jar.txt -i "$API/projects/other-gpt/auth/session"   # 204 or 401
curl -b jar.txt "$API/projects/other-gpt/auth/me"
```

## Operational notes

- **Rate limiting:** the API rate-limits to 100 requests/minute. Handle `429` with
  backoff on noisy clients.
- **Suspended/revoked membership:** the user keeps their ecosystem identity but
  cannot log in to this project until an admin reactivates/readmits them. Surface
  a clear message rather than a generic auth error.
- **Banned user:** `403 USER_BANNED` everywhere; a global block, not project-local.
- **Disabled project:** all project endpoints return `403 PROJECT_DISABLED`.
- **No self-service session list:** a normal user can only end their current
  session via logout. Managing other sessions is an admin/operator concern.
- **Seeded projects:** `other-gpt` (roles `user`, `pro`, `admin`) and
  `cost-console` (roles `user`, `admin`). New self-service signups always get
  `user`.
