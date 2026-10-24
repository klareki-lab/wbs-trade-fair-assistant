# WBS-TF-06 R2 — final independent review

Date: 2026-10-24. Reviewed Draft PR #5 HEAD
`798e3035f53bb84bf95d647ff8e8cb416f5f07f8` against the eight
findings in PR #6. This document supersedes the R1 verdict; the R1
review remains as history. No DNS, nginx, Neon, Gateway, workflow,
certificate, deployment or merge operation was performed by Codex.

**Gate F3B preparation: CHANGES REQUIRED. Production execution: NO-GO.**
The vhost design is close, but the written rollback and PR-integration
commands are not yet safe to execute as specified.

| R1 finding | R2 result | Independent evidence / remaining defect |
| --- | --- | --- |
| 1. Cutover and HTTPS holding | **PASS** | New `https-holding.conf` returns HTTPS 503 without proxying. §10 keeps it active through production migration and Gateway loopback acceptance; final proxy is step 10. Bootstrap file's old comment still says to replace directly with the final vhost and should be corrected for consistency. |
| 2. Coupled rollback and names | **FAIL** | §9 now puts holding nginx ahead of old Gateway restoration and uses the correct logical container names. But §10 writes the new `gateway.env` in step 7 and §6/step 8 then copies it to `env.pre`, losing the original env backup. Names such as `saved-<ts>` and `failed-<ts>` appear in shell blocks without defining a timestamp variable; `bash -n` rejects the `docker rename ...saved-<ts>` line. |
| 3. Immutable image, no old mounts | **PASS** | §6 explicitly forbids the two legacy source mounts and staging Compose in production. Codex locally built `Dockerfile.dashboard-staging` with Node 22 and `pg`; the image produced a content-addressed digest. A separately reviewed production service definition remains an owner execution prerequisite. |
| 4. GET health and JSON | **PASS** | §7 uses GET and expects `{"success":true,"service":"trade-fair-gateway"}`; HEAD 404 is documented. Local regression suite passed 40/40. For operator certainty, make the runbook assert the saved JSON rather than only writing `/tmp/h.json`. |
| 5. No secret-dumping diagnostics | **PASS** | `.Config.Env` is absent from the read-only probes. Deep `docker inspect` is confined by the plan to an owner-only `umask 077` backup. The replacement syntax-check command in §12 fails as written; see correction below. |
| 6. Staged, host-only HSTS | **PASS** | Final and holding vhosts have no active HSTS. §7 stages `max-age=300`, then one year after seven stable days, with no `includeSubDomains` or preload. Correct the prose: without `includeSubDomains`, policy applies to the exact `messe.klare-ki.de` host, not its sub-labels. |
| 7. IPv6 before AAAA | **PASS** | Authoritative DNS now has A `77.42.19.144`, no AAAA/CNAME. §8 requires external IPv6 HTTPS, TLS, redirect and Dashboard 401 before AAAA; `curl --resolve` syntax worked from Codex's external IPv6 client against port 80. Port 443 remains untested until the final vhost exists. |
| 8. PR ancestry and docs | **FAIL** | §13 correctly identifies the #1 → #2 → #3 runtime chain and the #4 → #5 → #6 review stack. Its proposed cherry-pick of **only R2 commit** `798e303` onto `main` cannot reproduce the packet: that commit modifies R1 files, while R1 commit `577f1b0` created them. The alternative of merging PR #6 before PR #5 also brings PR #5's ancestor into the chain. |

## Additional command-level correction

The §12 “reproducible” local syntax command was run exactly as published
and returned `no "events" section in configuration` (exit 1). It does
not pass stdin to Docker, includes all three mutually exclusive vhosts
at once, and does not mount a stand-in certificate. Codex independently
ran each of the three files through `nginx:1.24-alpine -t` with a local
one-day self-signed certificate mounted at the expected path; all three
passed. Replace §12 with that per-file harness, or link to a checked-in
script that generates the temporary certificate and fails on any nonzero
`nginx -t` result. `ops/nginx/syntax_check_evidence.txt` is Black's
record; the three passing per-file runs are Codex's independent result.

## Exact corrections before approval

1. **Preserve the old env before any edit.** In §10, put the baseline
   capture before step 7, or write the candidate to a distinct
   `gateway.dashboard.env` while leaving `gateway.env` intact. Candidate
   `docker create` must reference that distinct file. Back up the old env
   under `umask 077` and verify that `env.pre` is the old value set.
2. **Define and reuse one timestamp variable**, for example
   `TF_ROLLOUT_TS=$(date -u +%Y%m%dT%H%M%SZ)`, and use
   `wbs-trade-fair-gateway.saved-${TF_ROLLOUT_TS}` and
   `.failed-${TF_ROLLOUT_TS}` in both cutover and rollback. Record the
   resolved names in the private deployment log. Do not put `<ts>` in
   executable shell blocks.
3. **Fix §12 syntax reproduction** as described above; correct the stale
   bootstrap comment and the host-only HSTS sentence.
4. **Fix §13 integration:** after PR #3 lands, transplant both PR #5
   commits (`577f1b0` then `798e303`) or apply a single reviewed patch
   containing the full final PR #5 delta. A clean documentation PR can
   then target updated `main`. Keep PR #4 and PR #6 as review history,
   or bring their documents onto `main` through separate deliberate
   commits; do not merge them as ancestors by accident.

## Residual execution gates and owner approvals

The corrected packet will still be a preparation artifact. Production
execution needs separate Owner approval for the exact DNS state (A is
already present; AAAA stays absent), nginx bootstrap/holding/final files
and reloads, Certbot issuance, production Neon role/function migration,
private secrets and backup retention, immutable image and Gateway swap,
HTTPS acceptance, later HSTS changes, optional AAAA after external IPv6
tests, and the PR integration path. No production GO can be issued until
those approved steps pass their live acceptance and rollback checks.
