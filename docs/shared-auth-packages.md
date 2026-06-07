# Shared Auth Packages (Design Sketch)

> **Status: proposal, not built.** This is a concrete sketch of the two shared
> packages that [`platform-ai-architecture` ADR 0002](../../platform-ai-architecture/docs/adr/0002-adopt-multi-repo-portfolio-with-shared-packages.md)
> envisions (`@org/contracts`, `@org/auth-sdk`), so that whoever creates that
> package/repo has a ready starting point. Nothing here is published yet;
> `identity-service` today exposes only the HTTP surface plus the
> [user](./integration-user-apps.md) and [admin/MCP](./integration-admin-mcp.md)
> integration guides. The shapes below mirror the real contracts in this repo
> (the Zod schemas in `src/modules/**`).

## Why these two packages

The integration guides are the **documentation** form of standardization.
`@org/contracts` and `@org/auth-sdk` are the **code** form: instead of every
consumer (`other-gpt`, `cost-console`, `mcp-server`) hand-writing the same DTOs
and HTTP client, they import them. This reduces drift and duplication, which is
exactly the reuse goal of ADR 0002.

- `@org/contracts` — framework-agnostic types/validation for every request and
  response. The single source of truth for the wire shapes.
- `@org/auth-sdk` — thin, typed HTTP clients built on `@org/contracts`: one for
  the end-user cookie surface, one for the machine admin surface.

## Primary consumers and runtimes

The design is driven by exactly where these run:

- **`identity-service` (this repo) — server, Node + Fastify + Zod.** It is both
  the origin of the contracts and a consumer: it would depend on `@org/contracts`
  and validate requests with the same Zod schemas it publishes, so client and
  server cannot drift. The package must therefore stay framework-agnostic
  (`zod` only — no Fastify/Prisma/Next imports).
- **`other-gpt` — Next.js frontend.** It consumes the **user** client across
  three Next.js runtimes: Client Components (browser), Server Components / Route
  Handlers / Server Actions (Node), and middleware (edge). The user client must
  work in all three, which drives the cookie-handling and edge-safety rules below.
- **`mcp-server` — Node service.** It consumes the **admin** client with a
  service-principal bearer token. This client is **server-only** and must never
  reach a browser/edge bundle.

## Design principles

- **No business logic in the packages.** Mirror the "`mcp-server` is a thin
  facade" rule: the SDK only does transport, typing, and ergonomics; the
  authority stays in `identity-service`.
- **`@org/contracts` is the single source.** Prefer exporting Zod schemas (with
  inferred types) so both `identity-service` (server-side validation) and clients
  can depend on the same definitions. The schemas already exist in this repo and
  would move/copy into the package.
- **Pluggable `fetch`.** Accept a `fetch` implementation for testability and for
  different runtimes (browser, Next.js server, Node).
- **ESM + TypeScript strict, minimal deps** (only `zod` if contracts ship
  schemas).
- **Envelope outcomes are not exceptions.** The admin client returns
  `denied`/`failed` as data; it throws only on transport-level failures.
- **Separate, server-safe entrypoints.** Ship `@org/auth-sdk/user` and
  `@org/auth-sdk/admin` as distinct exports so a frontend bundle can import the
  user client without ever pulling in the admin client. The service-principal
  token is server-only — keep it out of `NEXT_PUBLIC_*` and out of any browser
  bundle.
- **Edge-safe user client.** The user client uses only global `fetch` and web
  APIs (no Node-only modules) so it runs unchanged in the browser, Node, and
  Next.js middleware (edge). The admin client may assume Node.
- **Explicit cookie plumbing for SSR.** The user client never assumes a browser
  cookie jar. Server-side callers pass the incoming session cookie per request,
  and cookie-setting responses expose their `Set-Cookie` so a BFF can relay it
  (see the user client and Next.js patterns below).

## `@org/contracts` — proposed surface

### Shared primitives

```ts
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type UserStatus = 'ACTIVE' | 'BANNED';

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
}
export interface RoleSummary {
  id: string;
  code: string;
  name: string;
}

export interface ApiError {
  error: { code: string; message: string; issues?: unknown[] };
}
// Known codes as a union/const, e.g. 'AUTHENTICATION_REQUIRED' | 'PROJECT_DISABLED' | ...
export type ApiErrorCode = string;
```

### User (cookie) surface

```ts
export interface RegisterEmailCheckRequest {
  email: string;
}
export interface RegisterEmailCheckResponse {
  email: string;
  exists: boolean;
  nextStep: 'REGISTER' | 'LOGIN';
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}

export interface ProjectAuthUser {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
  createdAt: string;
}
export interface ProjectAuthMembership {
  id: string;
  status: MembershipStatus;
  roles: RoleSummary[];
}
export interface ProjectAuthResponse {
  user: ProjectAuthUser;
  project: ProjectSummary;
  membership: ProjectAuthMembership | null;
}

export interface ProjectAccessResponse {
  project: ProjectSummary;
  access: {
    isMember: boolean;
    membershipId: string | null;
    status: MembershipStatus | null;
    roles: RoleSummary[];
    isAdmin: boolean;
  };
}
```

### Admin (machine) surface

```ts
export type AdminOperationStatus = 'COMPLETED' | 'PENDING_APPROVAL' | 'DENIED' | 'FAILED';
export type AdminResponseStatus = 'completed' | 'pending_approval' | 'denied' | 'failed';
export type AdminApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface AdminMutationEnvelope<TPayload> {
  targetProjectId: string;
  reason: string;
  idempotencyKey: string;
  ticketRef?: string;
  channel: string;
  operatorUserId?: string;
  payload: TPayload;
}

export interface AdminMutationResponse {
  status: AdminResponseStatus;
  operationId: string;
  approvalId: string | null;
  auditEventId: string;
  message: string;
  result: unknown;
}

// Per-operation payloads
export interface CreateUserPayload {
  email: string;
  displayName?: string;
  password?: string;
  roleCodes?: string[];
}
export interface UserTargetPayload {
  userId: string;
} // ban / unban / revokeProjectAccess
export interface AssignProjectRolePayload {
  userId: string;
  roleCodes: string[];
}
export interface ReadmitMembershipPayload {
  userId: string;
  roleCodes?: string[];
}
export type RevokeSessionPayload = { sessionId: string } | { userId: string };

export interface DecideApprovalBody {
  decision: 'approve' | 'reject';
  operatorUserId: string;
  decisionReason?: string;
}

// Read query/response shapes (cursor pagination), e.g.
export interface CursorPage {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
```

The matching Zod schemas already live in
`src/modules/auth/auth.schemas.ts`, `src/modules/project-memberships/project-memberships.schemas.ts`,
and `src/modules/admin-operations/admin-operations.schemas.ts`; the package would
host them as the shared source.

## `@org/auth-sdk` — proposed surface

### User auth client (`@org/auth-sdk/user`)

Wraps the cookie surface and works in the browser, Node, and edge. In the browser
it uses `credentials: 'include'` and the browser cookie jar; server-side it has no
jar, so callers pass the incoming session cookie via `ctx`, and cookie-setting
responses expose their `Set-Cookie` so a BFF can relay it. Throws a typed
`ApiError` on non-2xx, except `hasValidSession` which maps `204/401` to a boolean.

```ts
export interface AuthClientOptions {
  baseUrl: string;
  fetch?: typeof fetch; // defaults to global fetch (edge/runtime-agnostic)
}

/** Per-call context for server-side (Next.js) usage. Omit it in the browser. */
export interface RequestContext {
  /** Forward the incoming session cookie (server-side has no browser cookie jar). */
  cookie?: string;
  /** Extra headers to forward (e.g. X-Forwarded-For, User-Agent). */
  headers?: Record<string, string>;
}

/** Wraps responses that set/clear the session cookie so a BFF can relay it. */
export interface AuthResult<T> {
  data: T;
  /**
   * Raw Set-Cookie header values from identity-service. Readable only
   * server-side; in the browser the cookie is applied automatically by the
   * browser and is not exposed to JS, so this will be empty there.
   */
  setCookie: string[];
}

export interface UserAuthClient {
  checkEmail(
    slug: string,
    email: string,
    ctx?: RequestContext,
  ): Promise<RegisterEmailCheckResponse>;
  register(
    slug: string,
    body: RegisterRequest,
    ctx?: RequestContext,
  ): Promise<AuthResult<ProjectAuthResponse>>;
  login(
    slug: string,
    body: LoginRequest,
    ctx?: RequestContext,
  ): Promise<AuthResult<ProjectAuthResponse>>;
  logout(slug: string, ctx?: RequestContext): Promise<AuthResult<void>>;
  /** true on 204, false on 401. Pass ctx.cookie when calling from server/middleware. */
  hasValidSession(slug: string, ctx?: RequestContext): Promise<boolean>;
  getMe(slug: string, ctx?: RequestContext): Promise<ProjectAuthResponse>;
  getAccess(slug: string, ctx?: RequestContext): Promise<ProjectAccessResponse>;
}

export function createUserAuthClient(options: AuthClientOptions): UserAuthClient;
```

## Next.js integration patterns (other-gpt)

`other-gpt` is a Next.js app. Pick one of two patterns per deployment.

### Recommended: backend-for-frontend (BFF) proxy

The browser talks only to other-gpt's own Next.js routes; those route handlers
call `identity-service` server-side and relay cookies both ways. This is the safe
default because (1) `identity-service` currently has CORS disabled
(`origin: false`), and (2) the `httpOnly` session cookie stays same-origin to the
browser (the API origin is never exposed).

- **Login / register / logout:** call the client server-side, then copy
  `result.setCookie` onto the Next.js response so the browser stores the cookie on
  other-gpt's own origin.
- **Authenticated reads / gating:** read the incoming cookie from `next/headers`
  (or the middleware request) and pass it as `ctx.cookie`.

```ts
// app/api/auth/login/route.ts — relays the session cookie to the browser
import { createUserAuthClient } from '@org/auth-sdk/user';

const auth = createUserAuthClient({ baseUrl: process.env.IDENTITY_URL! });

export async function POST(req: Request) {
  const result = await auth.login('other-gpt', await req.json());
  const res = Response.json(result.data);
  for (const cookie of result.setCookie) res.headers.append('set-cookie', cookie);
  return res;
}
```

```ts
// middleware.ts — gate routes with the lightweight session check (edge-safe)
import { NextRequest, NextResponse } from 'next/server';
import { createUserAuthClient } from '@org/auth-sdk/user';

const auth = createUserAuthClient({ baseUrl: process.env.IDENTITY_URL! });

export async function middleware(req: NextRequest) {
  const ok = await auth.hasValidSession('other-gpt', {
    cookie: req.headers.get('cookie') ?? undefined,
  });
  return ok ? NextResponse.next() : NextResponse.redirect(new URL('/login', req.url));
}
```

### Alternative: direct browser → identity-service

The browser calls `identity-service` directly with `credentials: 'include'` and no
`ctx`. This requires enabling CORS on `identity-service` for the other-gpt origin
with `credentials: true`, plus `sameSite=none; secure` cookies for cross-site use.
Simpler client code, but more deployment and security surface; prefer the BFF
pattern unless you have a specific reason.

### Admin client (`@org/auth-sdk/admin`, Node / `mcp-server`)

**Server-only.** It carries a service-principal bearer token and must never be
imported into a browser or Next.js edge bundle. Wraps `/admin/*`. Mutations take
the envelope and return the response envelope (so `denied`/`failed` are inspected,
not thrown); only transport errors (`401/403/404/409/400`) throw.

```ts
export interface AdminClientOptions {
  baseUrl: string;
  token: string; // service-principal bearer token
  fetch?: typeof fetch;
  newIdempotencyKey?: () => string; // default: crypto.randomUUID()
  correlationId?: () => string | undefined;
}

export interface AdminClient {
  // Reads
  listProjectUsers(query: {
    targetProjectId: string;
    status?: MembershipStatus;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<unknown>;
  getUserAccessStatus(userId: string, query: { targetProjectId: string }): Promise<unknown>;
  listPendingApprovals(query?: {
    targetProjectId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<unknown>;

  // Mutations (common envelope in, AdminMutationResponse out)
  createUser(env: AdminMutationEnvelope<CreateUserPayload>): Promise<AdminMutationResponse>;
  banUser(env: AdminMutationEnvelope<UserTargetPayload>): Promise<AdminMutationResponse>;
  unbanUser(env: AdminMutationEnvelope<UserTargetPayload>): Promise<AdminMutationResponse>;
  assignProjectRole(
    env: AdminMutationEnvelope<AssignProjectRolePayload>,
  ): Promise<AdminMutationResponse>;
  revokeProjectAccess(
    env: AdminMutationEnvelope<UserTargetPayload>,
  ): Promise<AdminMutationResponse>;
  readmitMembership(
    env: AdminMutationEnvelope<ReadmitMembershipPayload>,
  ): Promise<AdminMutationResponse>;
  revokeSession(env: AdminMutationEnvelope<RevokeSessionPayload>): Promise<AdminMutationResponse>;
  decideApproval(approvalId: string, body: DecideApprovalBody): Promise<AdminMutationResponse>;
}

export function createAdminClient(options: AdminClientOptions): AdminClient;
```

Ergonomics the admin client should provide:

- **Auto-fill envelope meta.** Let callers pass just `targetProjectId`, `reason`,
  `channel`, `payload` and have the client default `idempotencyKey` (via
  `newIdempotencyKey`) and inject `X-Correlation-Id`.
- **`operatorUserId` is the caller's responsibility.** `mcp-server` sets it from
  the real OpenClaw operator; the SDK should not invent it.
- **Idempotency-key reuse is a client bug.** Surface `409
ADMIN_IDEMPOTENCY_KEY_REUSED` clearly.

## Open questions for the package

- **Project id vs slug.** The admin envelope uses `targetProjectId` (cuid). There
  is no public slug→id resolver endpoint today, so the SDK can't resolve it for
  callers. Either consumers cache ids out-of-band, or `identity-service` adds a
  resolve endpoint (a small future enhancement worth deciding when the SDK is
  built).
- **Schemas vs plain types.** Decide whether `@org/contracts` ships Zod schemas
  (runtime validation, heavier) or plain `.d.ts` types. Recommendation: Zod, and
  have `identity-service` consume the package as the single source over time.
- **Versioning.** Align package versions with API/contract changes; the admin
  surface already stamps a `policyVersion` on operations, which can guide
  compatibility expectations.
- **Scope of `@org/contracts`.** ADR 0002 also lists `@org/ai-sdk` and
  `@org/provider-catalog` for other capabilities; this sketch only covers the auth
  slice. Keep auth types in their own entry/namespace so the package can grow.
