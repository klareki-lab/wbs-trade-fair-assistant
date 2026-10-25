# Adapted workflows (not activated)

Design artifacts for issue #19 (Messe-Hub FULL). **Do not import into live n8n**
without Owner approval and a staged credential-provisioning plan.

## WF-06 — CRM grouping (merge/split/extract/ignore/revert)

**Not needed.** The gateway now implements CRM grouping directly against Neon
via `trade_fair.crm_group_*` SECURITY DEFINER functions (see
`sql/production/dashboard_crm_v1_up.sql`). Compared to Yuriy's reference
`06-Messe-Hub-Leads-zusammenfuehren-trennen.json` which used an n8n Data Table,
the Neon implementation gives us ACID, backups, join-with-leads reporting and
a durable audit history (`trade_fair.lead_group_audit`). The reference JSON is
retained in `dashboard/reference-workflows/06-*.json` for traceability and
NOT imported.

## WF-07 — Lead erfassen (Chat) → `wf-07-messe-hub-ai-extract.adapted.json`

- Replaces `langchain.chatTrigger` with a plain HTTP `webhook` so the Gateway
  can call it server-to-server. The browser never sees n8n.
- Switches `authentication` from the Yuriy chat trigger (anonymous) to **header
  auth bound to the existing `WBS Trade Fair — Gateway Auth` credential**
  (same as WF-A/B/C/D). No new password; the Gateway already carries that
  value as `N8N_HEADER_KEY`.
- Keeps Yuriy's prompt chain (`agent` + `lmChatOpenAi` + structured output
  parser) exactly as he designed, but:
  - Removes the final `httpRequest` node that auto-submitted to WF-A. V1
    requires **human confirmation first**: the Gateway returns the extracted
    fields and uncertainty flags to the browser; the user confirms, then the
    browser POSTs the Gateway's existing `/api/leads` which runs WF-A.
  - Clamps notes to 20 000 chars; refuses control characters.
  - Shape of return: `{ success, extracted: {...}, confidence: {...}, uncertainty_flags: [], assistant_message }`.
- `active: false`. Owner activates after staging.

## WF-08 — Lead-Assistent (Chat) → `wf-08-messe-hub-ai-ask.adapted.json`

- Also replaces `chatTrigger` with HTTP `webhook` + header auth (same credential).
- Grounding: only `trade_fair.dashboard_snapshot(..)` output for the Gateway-
  supplied `context_lead_ids` is passed to the agent; no raw `normalized_payload`,
  no notes, no email bodies.
- Response shape: `{ success, answer, cited_lead_ids: [...], tokens: { total_input, total_output } }`.
  Gateway rejects any `cited_lead_ids` that are not valid FAIR UUIDs. Answers are
  clamped to 8 000 chars; tokens capped at 50 000 combined.
- Grounded-only directive in the system prompt: "If the context does not
  contain the lead the user asks about, answer explicitly that you don't have it;
  do not invent any facts, scores or emails."
- No tools that write anywhere (calculator kept; no HTTP side-effects).
- `active: false`. Owner activates after staging.

## Required credentials (reference names only)

- **`WBS Trade Fair — Gateway Auth`** (header auth). Already exists. Reused by
  WF-07 and WF-08. The Gateway sends its value in `X-Trade-Fair-Key`.
- **`WBS Trade Fair — Neon PostgreSQL`** (postgres). Already exists. Reused by
  WF-08's postgres node (least-privilege via `dashboard_snapshot`).
- **LLM provider credential** (OpenAI-compatible or Requesty, mirroring Yuriy's
  `Requesty AI`). Owner provisions and binds to the WF-07/WF-08 agent nodes.
  Not a Gateway concern.

## Environment variables (names only, no values)

| Name | Purpose |
| --- | --- |
| `N8N_AI_EXTRACT_URL` | HTTPS webhook URL for WF-07 (gateway → n8n). |
| `N8N_AI_ASK_URL` | HTTPS webhook URL for WF-08 (gateway → n8n). |

Both unset = AI features return 503 and the UI shows the German "nicht
konfiguriert" state. Partial config refuses to start.
