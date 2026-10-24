# n8n Workflow Manifest

Exported on 2026-10-24 from container `n8n-n8n-1` (n8n 2.41.7) via
`n8n export:workflow --id=<id> --pretty`. No activation / execution occurred.

## Workflows

| File | Workflow name | id | versionId | updatedAt | nodes | trigger |
| --- | --- | --- | --- | --- | --- | --- |
| `workflows/wf-a-lead-capture.json` | WBS — Trade Fair Assistant — WF-A Lead Capture | `d5uO1lnwjOirJ5Xf` | `0c87ae2a-8199-4520-911d-d5869d17601b` | 2026-10-23T19:36:08.027Z | 8 | `n8n-nodes-base.webhook` |
| `workflows/wf-b-lead-processing.json` | WBS — Trade Fair Assistant — WF-B Lead Processing | `dr05aJRh8Lu6VpSA` | `c68f7272-56bb-4cd8-a777-f863f04e4697` | **2026-10-24T13:30:19.386Z** | 17 | `n8n-nodes-base.scheduleTrigger` |
| `workflows/wf-c-sales-email-delivery.json` | WBS — Trade Fair Assistant — WF-C Sales Email Delivery | `bRkCsVxZXU85yqLI` | `b2c08c88-10af-4bdd-b28c-76b0c750b171` | 2026-10-24T13:49:20.684Z | 13 | `n8n-nodes-base.scheduleTrigger` |
| `workflows/wf-d-lead-status.json` | WBS — Trade Fair Assistant — WF-D Lead Status | `THulrTbNEZ2FrgJ3` | `a876cc62-f54e-432a-a779-a36be3d1dcbf` | 2026-10-24T10:20:48.131Z | 6 | `n8n-nodes-base.webhook` |

WF-B `updatedAt` corresponds to the 24 Oct fix called out in the task
dispatch — this baseline contains that version.

## Credential references

Only `id` and `name` are present in the exports (no decrypted material).

| Credential | id | Type | Used by |
| --- | --- | --- | --- |
| WBS Trade Fair — Neon PostgreSQL | `DIm6w5CcndY0D3RJ` | `postgres` | WF-A, WF-B, WF-C, WF-D |
| WBS Trade Fair — Gateway Auth | `tjqSy2V0odocljw6` | `httpHeaderAuth` | WF-A, WF-D |
| WBS Trade Fair — Tavily | `A4Xm6WZ9d6SsMkfs` | `httpHeaderAuth` | WF-B |
| WBS Trade Fair — OpenAI 19.10 | `UUprjEp0Re6kPUFN` | `httpHeaderAuth` | WF-B (points to Requesty per ANLEITUNG) |
| WBS Trade Fair — Resend | `HvE5Js2qo8BxvrSs` | `httpHeaderAuth` | WF-C |

The actual credential values live only inside the n8n encrypted store on the
VPS. Rotating them does **not** require a workflow re-export.

## Active state

All four JSONs report `active: false`. This is a side-effect of
`n8n export:workflow`, not evidence of inactivity. The live activation state
is held in the n8n database and was intentionally left untouched by this
baseline run.

## Reference workflows (not live)

`dashboard/reference-workflows/` contains additional material from Yuriy's
"Messe-Hub-fuer-Sergii" package:

- `yuri-01…04` — copies of WF-A…D as delivered by Yuriy (same intent, slightly
  different credential wiring per `ANLEITUNG.md`). **Not** a replacement for
  the live exports in `workflows/`.
- `05-Messe-Hub-Daten-fuers-Dashboard.json` — read-only queries that feed
  Yuriy's HTML dashboard.
- `06-Messe-Hub-Leads-zusammenfuehren-trennen.json` — merge/split helpers.
- `07-Messe-Hub-Lead-erfassen-Chat.json` — chat-driven lead capture.
- `08-Messe-Hub-Lead-Assistent-Chat.json` — chat Q&A over the leads.

These were not imported into the live n8n instance.
