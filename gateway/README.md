# Train Today: mobile form and same-origin gateway

For the current RC3.3 architecture and independent setup boundaries, start with
the [repository README](../README.md), [reproduction guide](../docs/REPRODUCE_IT_YOURSELF.md)
and [status matrix](../docs/PROJECT_STATUS.md). The route/draft notes below primarily
describe the original form; CRM and AI behavior is covered in the newer guides.

This is a runnable Node.js application. It serves the German mobile form from
`../web/` and forwards authenticated requests to the configured n8n webhooks.
It uses Node's built-in HTTP, cryptography and fetch APIs, plus `pg` for the
dashboard/CRM database adapters. Install locked dependencies with
`npm ci --prefix gateway`. Use **Node.js 22 or later**.

Form capture/status database access goes through WF-A and WF-D. The current
gateway also connects directly to PostgreSQL for dashboard reads and CRM function
calls when enabled. The form never receives an n8n credential.

## Configure and run

1. Configure and activate the real n8n capture and status workflows. Record each
   exact production webhook URL. Both must use the Header Auth credential whose
   header name is `X-Trade-Fair-Key`.
2. Copy `.env.example` to a private location outside the project, fill in its
   values, and restrict that file to your account. Keep real keys out of Git,
   workflow exports, browser code, screenshots and shared archives.
3. Start the gateway from the project root:

   ```bash
   node --env-file=/absolute/private/trade-fair.env gateway/server.mjs
   ```

4. Open the exact `APP_ORIGIN`, which defaults to `http://127.0.0.1:3000`.
   If you prefer `http://localhost:3000`, set `APP_ORIGIN` to that exact value.
   Sign in with `TRADE_FAIR_ACCESS_KEY`.

All required values are checked at startup. Missing credentials or upstream
URLs stop startup; the application has no demonstration persistence fallback.

| Variable | Required configuration |
| --- | --- |
| `HOST` | Bind address; default `127.0.0.1`. Change deliberately for a container or reverse proxy. |
| `PORT` | Local HTTP port; default `3000`. |
| `APP_ORIGIN` | Exact browser origin, including scheme and nonstandard port, without a path. |
| `TRADE_FAIR_ACCESS_KEY` | Private team login key, at least 16 characters. |
| `SESSION_SECRET` | Independent random signing secret, at least 32 characters. |
| `N8N_CAPTURE_URL` | Exact active WF-A production webhook URL. No embedded username/password. |
| `N8N_STATUS_URL` | Exact active status-workflow production webhook URL. No embedded username/password. |
| `N8N_HEADER_KEY` | Value of the n8n `X-Trade-Fair-Key` Header Auth credential. |
| `PUBLIC_FORM_ENABLED` | `false` by default. Set to `true` only when anonymous capture is intended. |

Generate independent random secrets locally, for example:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')"
```

For a public deployment, use HTTPS in `APP_ORIGIN` and a reverse proxy in front
of the private gateway listener. HTTPS origins automatically produce `Secure`
session cookies. Local HTTP on localhost/127.0.0.1 is intended for development.
The frontend's secure UUID generation requires HTTPS or a browser-recognized
localhost context.

## Routes and trust boundaries

| Browser route | Behavior |
| --- | --- |
| `GET /` | Team login and internal capture form. |
| `POST /api/login` | Validates the team key and creates an eight-hour signed session. |
| `POST /api/logout` | Clears the browser session cookie. |
| `GET /api/session` | Returns authenticated state and whether the public form is enabled. |
| `POST /api/leads` | Requires login; forces `source=internal_form` before forwarding to WF-A. |
| `GET /api/leads/:lead_id?submission_id=...` | Requires login and the exact identifier pair; sends a server-side POST to the status workflow. |
| `GET /public` | Anonymous form, only when explicitly enabled. |
| `POST /api/public/leads` | Anonymous capture, only when enabled; forces `source=public_form`. |
| `GET /healthz` | Gateway process health only; does not prove n8n or database availability. |

Every mutation requires an `Origin` exactly equal to `APP_ORIGIN`. There is no
wildcard CORS policy. A direct command-line mutation must also provide this
header. The status GET is a read operation protected by the session and the
lead/submission identifier pair.

The client source is overwritten at the gateway; neither source can set trusted
email-verification flags. The public page displays only the capture receipt and
does not poll the authenticated status API. A filled `company_fax` honeypot is
rejected; an empty one is removed before forwarding.

Upstream URLs come only from server configuration. Redirects are not followed.
Only the server's n8n key is forwarded: browser cookies, forwarded-IP headers and
browser-supplied keys are not sent upstream. Returned capture receipts and status
fields are allowlisted. Unexpected upstream data produces an error, never a
success receipt.

## Drafts, retries and status

- The current draft, UUID and exact in-flight request body are kept in
  `sessionStorage` for the current tab. The access key is never stored there.
- Persistent `localStorage` is opt-in, with a visible notice that the draft
  contains personal data. Unchecking it removes the persistent draft.
- On a timeout, network error or ambiguous storage result, inputs are frozen.
  Retry sends the exact same body and submission identifier. Reloading the tab
  restores that frozen state.
- HTTP `409` keeps the draft frozen. Only the explicit **Als neue Erfassung
  bearbeiten** action creates a fresh submission identifier and enables editing.
- Confirmed validation errors leave the draft editable. A draft is automatically
  cleared only after a strict `success=true`, `persisted=true` capture receipt.
- Authenticated receipts poll the safe status endpoint every five seconds for
  at most five minutes. The user can restart polling. The backend continues
  independently when the tab closes.
- The SQL email status `delivered` is displayed as **Bericht an Versanddienst
  übergeben**. It represents provider acceptance, not proof of inbox delivery.
- Email `uncertain` asks the team to review before retrying, so the interface
  does not encourage duplicate sending.

## Limits and operational scope

Raw JSON bodies are limited to **32 KiB**, including chunked requests without a
Content-Length header. Invalid UTF-8, malformed JSON and non-object JSON are
rejected. The upstream timeout is 20 seconds; the browser keeps an ambiguous
request intact if that timeout expires.

Default rate limits are:

| Bucket | Limit |
| --- | --- |
| Login, per socket peer | 8 attempts / 15 minutes |
| Internal capture, per socket peer | 30 / minute |
| Public capture, per socket peer | 5 / 10 minutes |
| Status reads, per socket peer | 80 / minute |
| All capture requests, globally | 120 / minute |
| Public capture, globally | 20 / 10 minutes |

IP buckets are bounded to 10,000 entries. Global counters use separate fixed
buckets. These are **in-memory, single-process limits** and reset on restart.
They are not a distributed abuse-prevention service. Behind a reverse proxy,
the socket peer is the proxy: `X-Forwarded-For` is deliberately not trusted.
Configure a suitable trusted-IP and shared rate policy at the deployment proxy
before scaling or exposing the public form broadly.

Sessions are HMAC-signed, `HttpOnly`, `SameSite=Strict`, and expire after eight
hours. This MVP uses one shared team login key and has no per-person roles.
Logout removes the cookie from this browser; a copied cookie remains valid
until expiry or `SESSION_SECRET` rotation. Rotating the access key alone does
not invalidate already signed sessions.

The gateway does not log request bodies, cookies, submission tokens or upstream
URLs. It emits only a startup message. Configure any external proxy logging so
the status query's `submission_id` is not retained unnecessarily.

## Verification

From the project root:

```bash
npm test --prefix gateway
```

These executable tests use an explicitly **fake local HTTP upstream**. They
exercise sessions, Origin checks, source overrides, input limits, rate limits,
timeout behavior, receipt validation and status sanitization. They do not prove
connectivity to the user's n8n, Neon database or email provider.
