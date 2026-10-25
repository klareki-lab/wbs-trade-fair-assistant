# Adapted workflows (not activated)

These JSON files are design artifacts. **Do not import them into live n8n** without
Owner approval and a provisioned scoped credential.

## `wf-05-messe-hub-dashboard-data.adapted.json`

Adaptation of the original `dashboard/reference-workflows/05-Messe-Hub-Daten-fuers-Dashboard.json`
(Yuriy) that:

- Replaces `basicAuth` with header auth bound to a distinct new credential
  **`WBS Trade Fair — Dashboard Auth`** (not yet created in n8n; Owner provisions it).
  The credential value is provided to the Gateway via the `N8N_DASHBOARD_HEADER_KEY`
  environment variable (reference-by-name only; no secret in git).
- Switches the webhook from `GET` with `allowedOrigins: '*'` to `POST`
  with no CORS. Only the gateway, server-to-server, calls this webhook.
- Clamps `page` to 1..10000 and `limit` to 1..50 server-side.
- Issues a single read-only SQL against `trade_fair.lead_submissions` joined
  with `trade_fair.companies`, `trade_fair.contacts` and
  `trade_fair.processing_results`, returning only allowlisted columns
  (`lead_id, created_at, company_name, contact_name, processing_status,
  score_band, duplicate_status, review_required`). No `normalized_payload`,
  no `email`, no `phone`, no `notes`, no AI/company_research payload.
- Uses the existing least-privilege Neon role for the Postgres credential
  (reference name only: **`WBS Trade Fair — Neon PostgreSQL (dashboard reader)`**).
  No new SQL grants are expanded; the same role already used by WF-A/B/C/D
  must be able to `SELECT` on these tables. Owner confirms the ACL before
  live import; if the role lacks SELECT on `processing_results`, request a
  narrow `GRANT SELECT ON trade_fair.processing_results TO <role>` as a
  separate Owner-approved change.
- `active: false`. Importing it will not fire until the Owner activates it
  and provisions both credentials.

## Not deferred features in V1

The reference workflow also loaded `Messe-Hub Gruppen-Verlauf` and called
`trade_fair.get_lead_status`. V1 omits both to keep the response bounded
and to avoid n8n DataTable dependencies. These remain available for V2
behind a separate review.
