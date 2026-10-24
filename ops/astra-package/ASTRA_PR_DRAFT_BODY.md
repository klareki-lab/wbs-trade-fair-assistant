# WBS-TF-02 — Admin Dashboard read-only Gateway/Neon integration

**Draft: do not merge or deploy.**

Adds Yuri-styled Dashboard behind existing Gateway session; read-only Neon adapter; optional reviewed SQL function; pagination/filter/score/processing/email/research details; form navigation; tests and controlled rollback.

- No changes/imports to existing WF-A–D
- No n8n public webhook, Basic Auth, credentials in browser or DML from Dashboard
- No nginx/Gate F3B modification
- One Node dependency (`pg`), requires lockfile + Docker build review
- DB function deployment **requires** Neon current DDL/ACL and isolated-branch check

**Local tests:** 63/63 PASS in historical Gateway 2.0.1 compatibility reference. **Exact SHA validation, actual Neon, visual browser and production E2E: PENDING**. See `TEST_REPORT.md`, `HANDOFF.md`, `DEPLOY.md`, `ROLLBACK.md`.
