# Dashboard API (read-only) · v1 draft

The dashboard is **off by default**. It is enabled only when the operator sets
`DASHBOARD_ENABLED=true` and `DASHBOARD_DATABASE_URL=<postgres-url>` on the
gateway server. Browsers never see the Postgres URL. There is no new Basic
Auth, no new webhook, no new browser-side token.

## Endpoint

```
GET /api/dashboard
  ?page=1&limit=50
  &search=<up to 120 chars>
  &band=HOT|WARM|COLD|UNSCORED
  &processing=pending|processing|completed|failed
  &email=pending|leased|sending|delivered|uncertain|failed|none
  &duplicate=yes|no
  &sort=created|company|score|processing|email
  &direction=asc|desc
```

All inputs are server-validated. Unknown keys, repeated keys and out-of-range
numbers return `400 INVALID_JSON`. The SQL function is identified by name
only and user text is passed as **bound parameters**; no interpolation.

- `page`: 1..10000.
- `limit`: 1..100 (default 50).
- `search`: trimmed, max 120 chars, no control characters. ILIKE wildcards
  `%` and `_` from the user are treated as search wildcards in v1.
- Sort tie-break is `lead_id ASC` for a stable order across pages.

Authorization: the existing gateway session cookie, created by
`POST /api/login` with the team access key. Unauthenticated requests get
`401 AUTH_REQUIRED`. The request is counted against the existing `status`
rate-limit bucket (80 req / min / peer IP).

Mutating methods on `/api/dashboard` get `405 REQUEST_REJECTED` even with a
valid session.

## Successful response (200)

```json
{
  "success": true,
  "read_only": true,
  "page": 1,
  "limit": 50,
  "total": 123,
  "as_of": "2026-10-24T09:00:00Z",
  "stats": {
    "total": 123, "hot": 7, "warm": 18, "cold": 44, "unscored": 54,
    "duplicates": 9, "failed": 2, "email_attention": 5,
    "scored_average": 42.3, "today": 11,
    "interests": [{"name":"ai_automation","count":31}]
  },
  "leads": [{"lead_id":"FAIR-...","company":"...","score_band":"WARM","score_total":45, "...": "..."}]
}
```

`total` is the filtered count; `leads[]` contains only the current page.
`stats.*` counters are **global** (whole `base` CTE), not page-local.

Per-lead fields the function can return:

- Identity: `lead_id`, `company_id`, `contact_id`, `company`, `website`,
  `contact`, `email`, `phone`, `email_verified`, `source`, `created_at`.
- Processing: `processing_status`, `processing_attempts`, `processing_error`,
  `duplicate_status`, `review_required`, `uncertainty_flags`,
  `possible_contact_ids`.
- Normalized form snapshot: `training_interest`, `budget_status`,
  `follow_up`, `follow_up_date`, `notes`.
- Scoring / enrichment: `score_band`, `score_total`, `scored_at`,
  `company_research`, `ai_extraction`, `ai_uncertainty`.
- Email outbox: `email_status`, `email_error`, `email_updated_at`.

A field being `null` means **absent / not yet available**. Clients must not
convert `null` into a fabricated zero / success.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No / invalid session cookie. |
| `INVALID_JSON` | 400 | Query parameters failed validation. |
| `RATE_LIMITED` | 429 | `status` bucket exhausted. `Retry-After` header set. |
| `REQUEST_REJECTED` | 405 | Non-GET method on `/api/dashboard`. |
| `STATUS_UNAVAILABLE` | 503 | DB adapter raised. **Never** downgraded to `200 total:0`. |
| `NOT_FOUND` | 404 | Dashboard disabled (`DASHBOARD_ENABLED!=true`). |

## Interpretation guards

- `email_status=delivered` records provider acceptance, **not** proof of inbox
  arrival or being read.
- `duplicate_status` is a suggestion from the pipeline, not verified identity
  resolution.
- `ai_extraction`, `company_research`, `ai_uncertainty` are AI outputs. Missing
  or uncertain fields stay missing — the UI must not invent values.
- Scores (`score_total`, `score_band`) are produced by WF-B. A missing score
  is `null` + `UNSCORED`, not `0 / COLD`.

## Data provenance

The function reads only `trade_fair.companies`, `contacts`, `lead_submissions`,
`processing_results`, `email_outbox`. The baseline schema metadata is in
`sql/trade_fair_schema.txt`; this baseline could only verify three of those
tables as the live `trade_fair_app` role. The remaining two tables
(`processing_results`, `email_outbox`) are referenced by the live WF-B / WF-C
workflows; column names used by this function must be confirmed by a
higher-privilege Neon reader before deployment (see
`docs/DASHBOARD_DEPLOYMENT.md` §B).
