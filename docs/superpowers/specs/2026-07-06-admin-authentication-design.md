# Admin Authentication Design

## Context

The Ludora admin app is moving from local-only use toward deployment, so the admin service and UI need a simple authentication boundary for administrators. The current admin service is an Express 5 API on `http://127.0.0.1:4001`, and the current admin UI is a React 19 + MUI Vite app on `http://127.0.0.1:5173`. There is no existing authentication, session, or user-account system in the admin app.

This design intentionally avoids database changes. No DDL or DML is required.

## Decision

Use a single environment-backed admin account with an HttpOnly signed session cookie.

Required service environment:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

Optional service environment:

- `ADMIN_SESSION_TTL_HOURS`, default `12`
- `ADMIN_SESSION_COOKIE_NAME`, default `ludora_admin_session`
- `ADMIN_SESSION_COOKIE_SECURE`, default `true` when `NODE_ENV=production`, otherwise `false`
- `ADMIN_SESSION_COOKIE_SAMESITE`, default `lax`, with `none` available for split-domain HTTPS deployments

The server startup path should fail fast when required admin auth values are missing. Tests that call `createApp` directly can inject auth options, and focused tests can omit auth where they are not testing the authentication boundary.

## Architecture

The admin service owns authentication. It exposes public auth endpoints, validates signed session cookies before protected routers, and leaves `GET /health` public for monitoring. The admin UI does not store credentials or tokens; it asks the service whether a session exists and sends credentials with API requests.

The session cookie stores only a signed session payload, not the admin password. The payload contains the username and an expiration timestamp. The service signs the payload with `ADMIN_SESSION_SECRET` using Node crypto primitives and verifies the signature with constant-time comparison.

## Service Components

Add a focused auth module under `ludora-admin-service/src/auth/`:

- Credential validation: compare submitted username/password against configured values using timing-safe comparison.
- Session creation: build a compact JSON payload with `username` and `expires_at`, sign it, and serialize it as an HttpOnly cookie.
- Session verification: parse the cookie header, validate the signature, reject expired sessions, and return the authenticated admin identity.
- Middleware: require a valid session before protected routes and return a consistent `401` JSON error when missing or invalid.

Add an auth router:

- `POST /admin/auth/login`: accepts `{ username, password }`, validates credentials, sets the session cookie, and returns `{ data: { username } }`.
- `GET /admin/auth/me`: returns `{ data: { username } }` for a valid session.
- `POST /admin/auth/logout`: clears the session cookie and returns `{ data: { ok: true } }`.

Update `createApp` routing:

- Mount CORS with `credentials: true`.
- Mount JSON parsing.
- Mount `GET /health`.
- Mount auth routes.
- Mount the auth middleware.
- Mount all existing feature routers after the auth middleware.

## UI Components

Add auth methods to the shared admin API client:

- `login(input)`
- `getCurrentAdmin()`
- `logout()`

All admin API fetch calls should use `credentials: 'include'`. The default local API URL should align with the documented fixed service URL: `http://127.0.0.1:4001`.

Update `App.tsx` to manage auth state:

- On first render, call `/admin/auth/me`.
- While the session check is pending, render a compact loading state.
- If unauthenticated, render a login screen.
- After successful login, render the existing `AdminLayout` and current hash route.
- Add logout to the top app bar. Logout clears the server cookie and returns the UI to the login screen.
- If any later API call returns `401`, clear auth state and show the login screen.

The login screen should use existing MUI components and stay operational rather than decorative: username field, password field, submit button, inline error message, and disabled submit state while the request is in flight.

## Error Handling

Invalid login attempts return `401` with a generic message such as `Invalid username or password`. The service should not reveal which credential was wrong.

Missing, malformed, expired, or tampered session cookies return `401` with `Authentication required`.

Malformed login bodies return `400` with a clear validation message.

Logout is idempotent. It clears the cookie even if no valid session exists.

The UI should show login errors inline. For expired sessions discovered during normal admin work, it should return to the login screen and preserve no stale authenticated state.

## Testing

Service tests:

- `GET /health` remains public.
- Protected routes return `401` without a valid session.
- Login rejects missing fields and wrong credentials.
- Login accepts correct credentials, sets an HttpOnly cookie, and allows access to a protected route.
- Tampered and expired cookies are rejected.
- Logout clears the cookie and prevents later protected access with the cleared session.
- Config loads required auth environment and rejects invalid TTL or SameSite values.

UI tests:

- Initial unauthenticated `/admin/auth/me` response renders the login screen.
- Successful login renders the existing admin shell.
- Failed login shows an inline error and does not render admin navigation.
- API client sends `credentials: 'include'` on reads and mutations.
- Logout calls the service, clears UI auth state, and returns to login.
- A `401` from an existing admin API request returns the app to login.

Verification commands:

- From `ludora-admin/ludora-admin-service/`: `npm test`
- From `ludora-admin/ludora-admin-ui/`: `npm test`
- From `ludora-admin/ludora-admin-service/`: `npm run build`
- From `ludora-admin/ludora-admin-ui/`: `npm run build`

## Rollout Notes

No database patch is needed.

Deployment must provide `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` before starting the admin service. For HTTPS deployments where the UI and API are on different sites, set `ADMIN_SESSION_COOKIE_SECURE=true`, `ADMIN_SESSION_COOKIE_SAMESITE=none`, and configure `CORS_ORIGIN` to the exact deployed admin UI origin.
