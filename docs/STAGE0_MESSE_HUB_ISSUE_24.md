# Issue #24 — Messe-Hub CRM: Stage-0 release preparation

Дата: 2026-10-26. Роль: **Release Preparation Engineer**, автор R2, не независимый reviewer.
**PREPARED / HOLD. Staging НЕ развёрнут, staging PASS и production readiness НЕ заявлены.**
В этой работе прочитаны только GitHub и локальные Git-источники; инфраструктурные подключения,
секреты, merge, registry push, VPS/Neon/n8n изменения и платные API не выполнялись.
Все команды ниже, кроме явно обозначенной локальной статической проверки, — **подготовленные
команды будущего оператора**, исполняемые только после соответствующего разрешения Owner.

Источники: [Issue #24](https://github.com/klareki-lab/wbs-trade-fair-assistant/issues/24),
[PR #20](https://github.com/klareki-lab/wbs-trade-fair-assistant/pull/20),
[независимое ревью #23](https://github.com/klareki-lab/wbs-trade-fair-assistant/issues/23),
[R2 report](R2_TEST_REPORT.md), [acceptance matrix](WBS_MESSE_HUB_FULL_INTEGRATION.md),
[исторический manifest](WORKFLOW_MANIFEST.md). Исторические deploy/preflight документы не
доказывают сегодняшнее состояние VPS или Neon и не дают разрешения на доступ.

## 1. Freeze, inventory и неизменяемый manifest

| Объект | Проверенное значение / статус |
| --- | --- |
| Runtime source PR #20 | `d854721bbd440500605d03f984e1b73fa4d66490`, open Draft, unmerged |
| Current remote main при подготовке | `5fb6348db8954d233fcee5c8c782542e18f2ec90`; совпадает с PR base |
| Merge base | тот же `5fb6348…`; diff main → PR: 26 файлов, +3511 / −125 |
| Implementation R2 | `7c384edc2bc65ecc14b6a38278e0883a26dc8b91` |
| Независимое ревью нового SHA | Issue #23 открыт; вердикт при подготовке не получен |
| CI / авторские тесты | PR сообщает: GitHub CI на SHA отсутствует; 86 local PASS — авторский отчёт, не staging |
| Live topology, branch IDs, ACL, credentials | UNKNOWN; в Stage-0 не инспектировались |
| Candidate image / previous image / restore | NOT BUILT / UNKNOWN / NOT REHEARSED |

Полный список путей, Git blob IDs и SHA-256 **всех tracked файлов runtime SHA**, а также
полный delta находятся в [source-manifest.json](stage0-24/source-manifest.json).
[SHA256SUMS](stage0-24/SHA256SUMS) фиксирует сам пакет и manifest (не включает себя).
Неизменяемая ссылка на пакет — commit документационной ветки, указанный в Issue #24.
Runtime SHA и docs commit различны: образ строить только из runtime SHA.

| Delta | Пути и назначение |
| --- | --- |
| Gateway | `gateway/dashboard-crm.mjs`, `gateway/server.mjs`; CRM SQL adapter, scopes, AI proxy |
| Dependencies | `gateway/package.json`, `gateway/package-lock.json`; integration/browser test tooling |
| Browser | `web/Messe-Admin-Hub.html`, `web/dashboard.js`, `web/dashboard.css` |
| Environment examples | `.env.example`, `ops/env/gateway.production.env.example`; CRM flag и AI URLs |
| SQL | `sql/production/dashboard_crm_v1_up.sql`, `dashboard_crm_v1_down.sql` |
| AI artifacts | `workflows/wf-07-messe-hub-ai-extract.adapted.json`, `wf-08-messe-hub-ai-ask.adapted.json`; `workflows/README.md` |
| Tests | `tests/test_dashboard.mjs`, `tests/test_gateway_dashboard.mjs`, `tests/helpers/pg16.mjs`, `tests/integration/{crm_pg16,n8n_local,workflow_contracts}.mjs`, `tests/browser/messe_hub.mjs` |
| Reports | `docs/{R2_TEST_REPORT,WBS_MESSE_HUB_FULL_INTEGRATION}.md`, три `docs/evidence/r2/*.txt` |

Статически без delta: WF-A/B/C/D, `web/index.html`, `web/app.js`, baseline SQL,
`Dockerfile.dashboard-staging`, nginx. **Это не свидетельство отсутствия live drift.**
Проверка freeze перед исполнением, на локальной копии без секретов:

```sh
git fetch origin main feat/messe-hub-full-integration
SOURCE_SHA=d854721bbd440500605d03f984e1b73fa4d66490
test "$(git rev-parse origin/feat/messe-hub-full-integration)" = "$SOURCE_SHA"
test "$(git rev-parse origin/main)" = 5fb6348db8954d233fcee5c8c782542e18f2ec90
git diff --exit-code origin/main "$SOURCE_SHA" -- workflows/wf-a-lead-capture.json workflows/wf-b-lead-processing.json workflows/wf-c-sales-email-delivery.json workflows/wf-d-lead-status.json web/index.html web/app.js sql/dashboard_snapshot_definition.sql
```

Любое несовпадение → HOLD, новое сравнение/review/manifest; не подменять SHA автоматически.

## 2. Целевая staging topology и shared VPS boundary

Предпочтительная topology: отдельный staging host/VM, HTTPS origin, отдельный Gateway
container + отдельный n8n **2.41.7** с собственной БД, volume, encryption key, project,
webhook hostname и очередью; отдельная Neon branch с БД **neondb** и owner **neondb_owner**.
Никаких общих n8n SQLite/Postgres, Redis, volumes, reverse-proxy upstream или public
ports с production. Не обновлять n8n ради этой поставки. Mock provider до решения policy.
Staging WF-A/D — выделенные копии с существующим контрактом и staging DB;
WF-B/C не активировать, email/resend и прочий egress заблокировать на staging.
PAM workflows не импортировать, не исполнять и не менять.

Рекомендуется schema-only clone + synthetic rows. Neon data branch от production
может скопировать PII и роли/ACL: её создание, доступ и sanitization требуют отдельного
Owner решения. Не подключать staging к production даже временно. Не включать broad
Neon credential в WF-08. Не импортировать reference WF-05/06/chat endpoints.

До исполнения Owner заполняет **target record**, без секретных значений:

| Поле | Значение сейчас |
| --- | --- |
| Owner approval ID, оператор, окно, стоп-контакт | PENDING |
| Neon project / branch ID / endpoint ID / host / region / parent | PENDING |
| Database / owner / version | required neondb / neondb_owner / проверить; PG16 покрыт авторскими тестами |
| Staging host, HTTPS origin, private Gateway port | PENDING; пример loopback port 3100, проверить доступность |
| n8n instance / project / API origin / webhook origin / volume / DB | PENDING; отдельно от production |
| Previous image digest + env/web snapshot + routing restore | PENDING |
| Synthetic dataset / mock endpoint / egress rule / mail sink | PENDING |
| Backup custody / encryption / expiry / RPO / RTO | PENDING |

Если Owner всё же выбирает shared VPS: это отдельное разрешение на host-level изменения,
лимиты CPU/RAM/disk, уникальные имена/ports/networks/volumes, отдельный vhost и canary
маршрут. Ни `docker compose down`, ни restart общего n8n, ни изменение PAM environment,
ни глобальные logging/pruning настройки не допускаются в scope CRM.

После отдельного read-only разрешения оператор снимает baseline (значения private,
не публиковать raw inspect/env/logs):

```sh
# Только на названном Owner host. Не выполнять в Stage-0.
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
df -h /opt
# API_CFG — Owner-managed private curl config: URL auth header, не CLI token.
# Отдельная config для staging; prod read inventory — отдельное разрешение.
curl --fail --silent --show-error --config "$API_CFG" \
  "$N8N_API_ORIGIN/api/v1/workflows?limit=100" > "$PRIVATE_DIR/workflows-page1.json"
```

Пройти все страницы по `nextCursor`; сохранить IDs/names/versionId/active всех WF-A–D
и PAM, timestamps, sanitized definitions hashes. API summary может не содержать всех
полей — GET `/api/v1/workflows/{id}` для разрешённых IDs. До/после сравнить definitions,
active/versionId, container ID/start time/health и ресурсы. Production workflows не
триггерить для smoke без отдельного разрешения. Static PASS + отсутствие live evidence
означает **shared-VPS isolation NOT VERIFIED**, а не «PAM не затронут».

## 3. Neon metadata preflight: команды, ожидаемый результат, STOP

`PGSERVICE`/`PGSERVICEFILE`/`PGPASSFILE` заранее обслуживает Owner вне repo, mode 0600;
TLS `verify-full` для psql. Не передавать URL/password в CLI, shell history, отчёт или
скриншоты. Не decrypt/export credentials n8n. Работать с direct endpoint для DDL/backup.
Снять мешающие inherited PGHOST/PGDATABASE/PGUSER/PGOPTIONS и использовать чистую
операторскую shell: shell env не должна переопределять service target. SQL не определяет Neon branch ID: current_database/current_user недостаточно; Owner
сверяет host ↔ endpoint ↔ branch в Neon control plane и записывает target record.
Даже metadata read здесь ещё **не разрешён**.

```sh
# После approval O1; сервисы заранее указывают ТОЛЬКО staging.
set -eu
umask 077
: "${PRIVATE_DIR:?Owner-selected absolute private evidence directory}"
mkdir -p "$PRIVATE_DIR"
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -f docs/stage0-24/neon-preflight.sql > "$PRIVATE_DIR/neon-before.txt"
PGSERVICE=messe_stage_owner psql -X -At -v ON_ERROR_STOP=1 \
  -f sql/DASHBOARD_DDL_EXPORT_READ_ONLY.sql > "$PRIVATE_DIR/baseline-ddl.txt"
```

SQL: [neon-preflight.sql](stage0-24/neon-preflight.sql), transaction READ ONLY + ROLLBACK,
10 s timeout, только metadata. Вывод проверяется человеком; SQL сам не выдаёт PASS.

| Проверка | Ожидание / решение |
| --- | --- |
| Identity | neondb / neondb_owner; transaction_read_only=on; exact approved endpoint/branch |
| Schema / UUID | trade_fair owner neondb_owner; gen_random_uuid существует; extensions versions записаны |
| Five-table DDL | columns/types/defaults/PK/FK/CHECK/UNIQUE/indexes/triggers/RLS совпадают с `sql/dashboard_confirmed_ddl.sql` и зависимостями функций; semantic review, не только имена |
| Baseline functions | definitions/owners/ACL/search_path сопоставлены с frozen main; ни один existing writer не меняется |
| Fresh CRM | lead_groups, lead_group_members, lead_group_audit **все отсутствуют**; отсутствуют CRM helpers/entrypoints/ai_lead_context и trade_fair_ai_context role |
| Dashboard prerequisite | dedicated role + exact snapshot function уже есть и валидны, либо отдельная baseline install O3 |
| Effective dashboard ACL | CONNECT, USAGE; без schema CREATE/table/sequence access, owner/admin membership; до CRM только dashboard_snapshot EXECUTE |
| PUBLIC/default ACL | нет опасного CREATE/table access/CRM EXECUTE, grants от owner не открывают новые CRM объекты; record database/schema/default ACL и membership graph |
| Roles | dashboard без superuser/create DB/create role/replication/bypassrls; scoped AI role будет NOLOGIN; login не наследует broad roles |

Существующая CRM **или только часть объектов/AI role** → STOP, отдельная forward migration
с data/audit preservation и review; не DROP/recreate и не «починить rerun». Любой drift,
неизвестный trigger, policy, owner, privilege или несовместимый PG version → HOLD до
анализа. Не отзывать PUBLIC/schema grants глобально автоматически: это может сломать PAM.
Изменение defaults/ACL — отдельное согласованное исправление, затем новый preflight.

## 4. Backup/export и restore rehearsal ДО миграции

O2: записать acceptable RPO/RTO и замерить actual restore time; не считать наличия dump
успешной проверкой. `PRIVATE_DIR` на зашифрованном хранилище, off-host copy с ограниченным
доступом/expiry; raw dump и workflow export не коммитить (в definitions могут быть literals).
Нужен pg_dump major не ниже server major; restore target совместимый и изолированный.

```sh
# O2, только approved staging source, read/export; пароль из private service.
PGSERVICE=messe_stage_owner pg_dump --format=custom --no-password \
  --file="$PRIVATE_DIR/neondb-before.dump"
shasum -a 256 "$PRIVATE_DIR/neondb-before.dump" > "$PRIVATE_DIR/neondb-before.dump.sha256"
pg_restore --list "$PRIVATE_DIR/neondb-before.dump" > "$PRIVATE_DIR/restore-toc.txt"
# O2: messe_restore_owner -> ДРУГАЯ пустая disposable DB/branch, не source/prod.
# Роли не входят в pg_dump: Owner сначала создаёт reviewed role names/attributes,
# membership и нужного owner на restore target (без переноса production passwords).
PGSERVICE=messe_restore_owner pg_restore --no-password --exit-on-error \
  --single-transaction --dbname='service=messe_restore_owner' \
  "$PRIVATE_DIR/neondb-before.dump"
```

Не применять `--clean` к живой БД и не скрывать ошибки через `--no-acl/--no-owner`:
проверяем реальную ownership/ACL модель. При нехватке Neon role privileges — STOP,
подготовить approved role mapping и повторить restore в **новой пустой** disposable DB.
Полный dump должен охватить все схемы, зависимости и данные; storage-wide roles/default
ACL фиксируются отдельно catalog metadata (без password hashes); external integrations
не входят в dump. Для synthetic staging до/после restore сравнить row counts **всех**
trade_fair tables, ordered canonical data hashes, constraints/indexes/FKs/sequences,
function fingerprints и role effective privileges. CRM audit и before_state при наличии
также сверить; sequence next value > max event_no. Выполнить snapshot и CRM lifecycle в
restore copy; записать duration, error count=0, reviewer, artifact hash, restore DB ID.
Готовая команда fingerprints (только synthetic DB, full-row reads O2/O9):

```sh
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -f docs/stage0-24/data-fingerprints.sql > "$PRIVATE_DIR/source-data.txt"
PGSERVICE=messe_restore_owner psql -X -v ON_ERROR_STOP=1 \
  -f docs/stage0-24/data-fingerprints.sql > "$PRIVATE_DIR/restored-data.txt"
diff -u "$PRIVATE_DIR/source-data.txt" "$PRIVATE_DIR/restored-data.txt"
```

Fingerprint — сравнение canonical row multiset, не подпись backup; source на время
снятия dump/fingerprints не имеет concurrent writers. В production план consistent
snapshot/maintenance window утверждается отдельно. Неполный restore/неизвестный RTO → NO-GO. Production backup и production restore — O11,
не следствие staging approval; restore поверх production не является app rollback.

Экспорт n8n в отдельном staging instance (O2/O6; не credentials):

```sh
# CLI запускается с environment и БД только выделенного staging instance.
# N8N_STAGE_CONTAINER должен быть проверен по target record, не production n8n-n8n-1.
docker exec "$N8N_STAGE_CONTAINER" n8n --version
docker exec "$N8N_STAGE_CONTAINER" n8n export:workflow --all \
  --output=/home/node/stage-backup/workflows-before.json
# Директория stage-backup заранее создана mode 0700 на private staging volume.
docker cp "$N8N_STAGE_CONTAINER:/home/node/stage-backup/workflows-before.json" \
  "$PRIVATE_DIR/workflows-before.json"
```

Также Owner делает согласованный snapshot n8n DB/volume (SQLite: consistent backup
при остановленном **только staging** instance; Postgres: pg_dump своей n8n DB).
Encryption key остаётся в существующем private custody; не выводить/export credentials
и не рассчитывать, что JSON workflows восстановит зашифрованные bindings. Rehearsal —
отдельный isolated instance: restored DB, тот же authorized key через secret store,
без egress и с workflows inactive; сравнить IDs/definitions/credential type references
и активировать только synthetic WF-07/08. Не запускать импорт всех backup workflows в prod.

## 5. SQL migration и scoped AI login

O3 baseline только если **оба** dashboard role и snapshot отсутствуют и preflight
подтверждает baseline fresh state. `sql/production/dashboard_role_production.sql`
потребует Owner-managed `WBS_DASHBOARD_PROD_ROLE_PASSWORD`; это отдельное secret
provisioning, не выполненное Stage-0. Не запускать если любой объект уже существует.
Существующую корректную Dashboard installation сохранить, скрипт пропустить.

```sh
# O3 only if fresh baseline: секрет вводится Owner вне shell history/logs.
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -v production_branch_confirmed=on -f sql/production/dashboard_role_production.sql
# O4, только fresh CRM, после backup/restore и повторного preflight:
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -v production_branch_confirmed=on -f sql/production/dashboard_crm_v1_up.sql
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -f docs/stage0-24/neon-postflight.sql > "$PRIVATE_DIR/neon-after.txt"
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -f docs/stage0-24/neon-preflight.sql > "$PRIVATE_DIR/acl-after.txt"
```

`production_branch_confirmed` — историческое имя gate; оно **не идентифицирует branch**
и не разрешает production. UP — одна transaction; создаёт 3 CRM tables, 1 identity sequence,
indexes, 10 функций (3 private helpers, 6 Dashboard entrypoints, 1 AI), NOLOGIN AI role,
revoke/grants/assertions. Lead/contacts/companies/results/outbox definitions не меняет.
Не оборачивать SQL с собственными BEGIN/COMMIT в `psql --single-transaction`.
При SQL error → disconnect/ROLLBACK, HOLD; снять catalog снова, не повторять вслепую.
При потерянном соединении commit outcome UNKNOWN: проверить **все** objects, definitions
и ACL. Полностью установленный UP повторно не запускать. Частичные/неизвестные изменения
требуют отдельного investigation/forward migration. Успешный DDL ≠ release PASS.

O5 план scoped binding (только имена, никакие credentials/пароли здесь не приведены):

```sql
-- После UP. Owner на exact staging DB, отдельная approved transaction.
BEGIN;
CREATE ROLE trade_fair_ai_context_staging_login LOGIN INHERIT
 NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO trade_fair_ai_context_staging_login;
GRANT trade_fair_ai_context TO trade_fair_ai_context_staging_login;
COMMIT;
```

Owner отдельно устанавливает authentication material через защищённый процесс и
создаёт n8n credential `WBS Trade Fair — AI Context (scoped read only)` типа `postgres`,
SSL verify enabled, target только staging; пароль/URL не публикуются. Проверить login
не owner, без иных memberships/admin option, effective доступ ровно USAGE +
`ai_lead_context(jsonb)` EXECUTE, без table/sequence/CREATE/snapshot/CRM/private helper.
Не менять NOLOGIN `trade_fair_ai_context` в LOGIN и не расширять `trade_fair_app`.
После binding повторить effective ACL именно из **реальной login session**:

```sh
# Отдельный service использует тот же scoped login, что n8n credential.
PGSERVICE=messe_stage_ai psql -X -v ON_ERROR_STOP=1 \
  -c "SELECT current_user, session_user, trade_fair.ai_lead_context('[\"FAIR-00000000-0000-4000-8000-000000000001\"]'::jsonb);"
# После seed. Expected success:true, ровно этот ID, только category allowlist.
PGSERVICE=messe_stage_ai psql -X -v ON_ERROR_STOP=1 \
  -c 'SELECT 1 FROM trade_fair.lead_submissions LIMIT 0;'
# Expected nonzero exit + permission denied. Запускать как отдельный negative check.
PGSERVICE=messe_stage_ai psql -X -v ON_ERROR_STOP=1 \
  -c "SELECT trade_fair.dashboard_snapshot(1,0,'','','','','','created','desc');"
# Expected permission denied. Не считать nonzero здесь migration failure.
```

Запреты DML/CRM/helper/SET ROLE owner проверять ACL и отдельными read-only transactions
(не выполнять реальную mutation для проверки запрета на production). Dashboard effective
EXECUTE после UP: baseline snapshot + 6 CRM functions, **не** ai_lead_context или helpers;
AI effective EXECUTE: только ai_lead_context. PUBLIC EXECUTE на новых функциях — 0.
`neon-postflight.sql` violation queries → 0 rows, snapshot_ok=true, index UNIQUE WHERE
removed_at IS NULL; остальные ACL expectations проверяются по preflight output.

## 6. Credentials и WF-07/08 n8n 2.41.7 import/transport acceptance

| Artifact reference | Действие после O5/O6 | STOP condition |
| --- | --- | --- |
| `WBS Trade Fair — Gateway Auth` / httpHeaderAuth | выбрать существующий разрешённый staging binding; header name **X-Trade-Fair-Key**; Gateway server value согласован, без просмотра/копирования значения | отсутствует/другой тип/не тот instance |
| `WBS Trade Fair — OpenAI  19.10` / openAiApi | проверить **тип**, endpoint, provider account/project и policy; выбрать совместимый existing binding в выделенном staging | исторический manifest называет `OpenAI 19.10` типа **httpHeaderAuth** (Requesty); имена/двойной пробел не гарантируют совместимость |
| `WBS Trade Fair — AI Context (scoped read only)` / postgres | новый отдельный scoped staging login из §5; выбирать exact approved ID | broad `WBS Trade Fair — Neon PostgreSQL` запрещён |

Если compatible `openAiApi` credential отсутствует, **не конвертировать** shared
httpHeaderAuth и не менять WF-B. Owner отдельно разрешает создание нового binding;
provider/endpoint adapter меняет фактическую обработку данных и требует policy review.
Для mock используется Owner-created synthetic openAiApi binding на isolated mock endpoint;
это не настройка настоящего provider. Instance egress запретить кроме staging DB/mock.
Existing production credential IDs из исторического manifest не переносить вслепую.
Credential Test может вызвать live provider — отдельный O9, не нажимать до разрешения.

O6: убедиться в версии 2.41.7, отсутствии path collision, новом workflow IDs, пустом
pinData/staticData, active=false. Подготовить payload только в private operator workspace:

```sh
# Без секретов: IDs — ссылки на уже разрешённые credentials В STAGING project.
# GW_CRED_ID, MODEL_CRED_ID, AI_CRED_ID оператор выбирает по type+project, не по имени.
for kind in extract ask; do
  case "$kind" in extract) number=07;; ask) number=08;; esac
  jq --arg gw "$GW_CRED_ID" --arg model "$MODEL_CRED_ID" --arg ai "$AI_CRED_ID" '
    .name = ("STAGE24 " + .name) |
    .nodes |= map(
      if .credentials.httpHeaderAuth then .credentials.httpHeaderAuth.id=$gw else . end |
      if .credentials.openAiApi then .credentials.openAiApi.id=$model else . end |
      if .credentials.postgres then .credentials.postgres.id=$ai else . end
    ) | {name,nodes,connections,settings,staticData}
  ' "workflows/wf-$number-messe-hub-ai-$kind.adapted.json" \
    > "$PRIVATE_DIR/wf-$number-import.json"
  curl --fail --silent --show-error --config "$API_CFG" \
    -H 'Content-Type: application/json' --data-binary "@$PRIVATE_DIR/wf-$number-import.json" \
    "$N8N_API_ORIGIN/api/v1/workflows" > "$PRIVATE_DIR/wf-$number-created.json"
done
```

API config points ONLY to staging. Если API schema версии отвергнет settings — STOP,
проверить разрешённую instance API schema/UI, не выкидывать retention settings ради импорта.
Сохранить returned IDs; GET обратно и сверить nodes/connections/settings/credential IDs,
`active:false`, parser versions, отсутствие tools/memory/autoFix. Не передавать active/id/
versionId в POST, не update существующие WF-A–D/PAM. CLI alternative в отдельном staging:
`n8n import:workflow --input=/private/stage-workflows.json` (array с unique new IDs и
active:false), предварительно `n8n import:workflow --help`; не запускать на общем prod DB.

Проверить exact nodes: Webhook 2.1 POST `messe-hub/ai-extract` / `messe-hub/ai-ask`,
headerAuth, responseMode=responseNode; RespondToWebhook 1.5 firstIncomingItem;
Basic LLM Chain 1.7, Structured Output Parser 1.3, Postgres 2.6 parameterized $1.
Retention: success/error=none, manual/progress=false, workflowTimeout=30 s;
model timeout 20 s/maxRetries=0/maxTokens=2000/1200/store:false. Приватность instance,
error workflow, proxy/APM/DB logs проверяется отдельно, не глобальной правкой shared n8n.

O7 отдельная активация **только новых staging IDs**, после GET/diff:

```sh
# WF07_ID/WF08_ID взяты из created response и сверены, не из live baseline.
for workflow_id in "$WF07_ID" "$WF08_ID"; do
  curl --fail --silent --show-error --config "$API_CFG" -X POST \
    "$N8N_API_ORIGIN/api/v1/workflows/$workflow_id/activate" \
    > "$PRIVATE_DIR/activated-$workflow_id.json"
done
```

Сверить actual published/active version в UI/API 2.41.7. `/webhook-test/` и CLI execute
не заменяют real active `/webhook/` acceptance. Transport тесты только synthetic/mock:

```sh
WF07_URL="$N8N_WEBHOOK_ORIGIN/webhook/messe-hub/ai-extract"
# Нет auth / неверный auth -> non-2xx, модель/БД не вызваны; не фиксировать точный
# n8n error body как API контракт. Success без key — немедленный NO-GO.
curl --silent --show-error -D "$PRIVATE_DIR/noauth.headers" \
  -o "$PRIVATE_DIR/noauth.json" -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  --data '{"notes":"Synthetic Company discussed training."}' "$WF07_URL"
# HEADER_CFG содержит только existing authorized Header Auth в private curl config.
curl --fail --silent --show-error --config "$HEADER_CFG" \
  -D "$PRIVATE_DIR/extract.headers" -H 'Content-Type: application/json' \
  --data '{"notes":"Synthetic Company discussed training."}' "$WF07_URL" \
  > "$PRIVATE_DIR/extract.json"
jq -e 'type=="object" and .success==true and (.extracted|type=="object") and (.confidence=={}) and (.uncertainty_flags|type=="array") and (.assistant_message|type=="string")' "$PRIVATE_DIR/extract.json"
```

Повторить ask `POST /webhook/messe-hub/ai-ask` с JSON
`{"question":"Which budget?","context_lead_ids":["FAIR-00000000-0000-4000-8000-000000000001"]}`.
Ожидается **один object**, success=true, answer string, cited_lead_ids array subset
requested IDs; никаких `[object]`, `{output:…}`, `{data:…}`, HTML или пустого ACK.
Заголовки JSON и Cache-Control:no-store. Сверить конкретные claims с БД.
No/wrong header, GET вместо POST, empty/oversize/invalid input, nonexistent/duplicate ID,
DB permission failure, model malformed schema/forged facts/citation, timeout, provider
429/5xx и redirect → fail-closed, **никогда ложный success**; Gateway возвращает generic
503 при bad upstream (422 для своих invalid inputs). Workflow Code throws могут дать
n8n generic 5xx, это не гарантированный structured 422. Если n8n errors раскрывают
payload/PII/stack наружу — NO-GO до redaction/proxy fix. Не публиковать raw failures.

## 7. Gateway image, env и canary

O8: собрать из exact runtime archive, не из рабочей docs ветки и не с live mounts.
Dockerfile уже включает pg и web, USER node. Mutable base `node:22-alpine` требует
фиксации registry digest; **не использовать** R2 local image IDs как registry digest.

```sh
# На approved build machine; без production env. SOURCE_SHA как в §1.
mkdir -p "$PRIVATE_DIR/source"
git archive "$SOURCE_SHA" | tar -x -C "$PRIVATE_DIR/source"
# NODE_BASE: Owner/reviewer-approved node:22-alpine@sha256:<registry digest>.
# Digest выбирается для целевой architecture, фиксируется в release manifest.
: "${NODE_BASE:?approved immutable base reference}"
case "$NODE_BASE" in node:22-alpine@sha256:*) ;; *) exit 1;; esac
sed "1c\\
FROM $NODE_BASE
" "$PRIVATE_DIR/source/Dockerfile.dashboard-staging" > "$PRIVATE_DIR/Dockerfile.pinned"
IMAGE_TAG="messe-hub:stage24-$SOURCE_SHA"
docker build --pull --platform "$TARGET_PLATFORM" \
  --label "org.opencontainers.image.revision=$SOURCE_SHA" \
  -f "$PRIVATE_DIR/Dockerfile.pinned" -t "$IMAGE_TAG" "$PRIVATE_DIR/source"
docker image inspect "$IMAGE_TAG" --format '{{.Id}} {{.Architecture}} {{json .RepoDigests}}'
# Архив immutable image для передачи без registry push; O8 storage разрешение.
docker save -o "$PRIVATE_DIR/gateway-image.tar" "$IMAGE_TAG"
shasum -a 256 "$PRIVATE_DIR/gateway-image.tar"
```

Сохранить source SHA, base registry digest, target platform, Node version, lockfile hash,
Dockerfile.pinned hash, resulting **image ID**, image archive hash. Если Owner отдельно
разрешит registry push — записать RepoDigest после push и deploy по `repo@sha256:…`;
image ID и registry digest не взаимозаменяемы. При передаче image archive:
`docker load -i "$PRIVATE_DIR/gateway-image.tar"`, затем сверить image ID и architecture
с manifest до запуска. Не подменять pinned source непроверенным fix.

Owner-managed candidate env: существующие staging TRADE_FAIR_ACCESS_KEY, SESSION_SECRET,
N8N_HEADER_KEY, DASHBOARD_ACCESS_KEY, DASHBOARD_DATABASE_URL и capture/status URLs
сохраняются через secret store, без ротации; form/admin ключи разные. DB URL — только
staging dashboard login, TLS verified (Gateway принудительно rejectUnauthorized=true).
Никаких production значений в mock environment.
`DASHBOARD_ENABLED=true`; сначала `MESSE_CRM_ENABLED=false`, оба AI URL пусты;
затем O8 approved candidate env с `MESSE_CRM_ENABLED=true`, обе AI URLs exact active
webhooks и `N8N_AI_ALLOWED_ORIGIN` exact их origin. APP_ORIGIN — staging HTTPS origin;
PUBLIC_FORM_ENABLED=false. Для контейнера ниже HOST=0.0.0.0, PORT=3000 внутри;
наружу только loopback. Публичный HTTPS вне loopback обязателен для n8n upstream.

```sh
# O8: только staging host, STAGE_ENV private 0600; IMAGE_ID exact image ID из manifest.
# Добавить Owner-reviewed CPU/memory limits и isolated network/egress policy.
docker run -d --name messe-stage24-canary --restart=no \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:3100:3000 --env-file "$STAGE_ENV" "$IMAGE_ID"
curl --fail --silent --show-error http://127.0.0.1:3100/healthz
```

Никаких source/web bind mounts: старый bind mount может перекрыть candidate dependencies.
HTTPS canary vhost/upstream — отдельное O8, сначала syntax check, затем controlled
reload, без глобального replace existing vhosts. Если отдельного canary origin/routing нет,
STOP; /healthz — только process liveness, не DB/n8n PASS. Progressive exposure на staging:
один оператор → полная матрица → observation ≥30 минут, latency/error/resources до/после.
Предлагаемый gate: 0 unexpected 5xx/conflicts, 0 duplicate memberships, 0 leaked payloads,
0 external emails, 0 changed WF-A–D/PAM definitions/active state; timeout fault tests
учитывать отдельно. Owner утверждает ресурсный budget и числовые p95/RTO/RPO до запуска.

## 8. CRM/AI acceptance с synthetic data

O9: никакой реальной PII; fixture IDs `FAIR-00000000-0000-4000-8000-000000000001`…`008`,
компании Synthetic, email только `example.test`. Готовый guarded seed: [synthetic-seed.sql](stage0-24/synthetic-seed.sql),
на основе `tests/helpers/pg16.mjs`, без outbox. Только после O9 и проверки отключённых
workers/egress:

```sh
PGSERVICE=messe_stage_owner psql -X -v ON_ERROR_STOP=1 \
  -v isolated_stage_confirmed=on -f docs/stage0-24/synthetic-seed.sql
```

Helper сам запускает локальный Docker и не является Neon deploy command. Для e2e capture использовать staging
WF-A/D, отдельные submission IDs и disabled WF-B/C; не пересылать в live delivery.
Не выполнять seed всего `dashboard_confirmed_ddl.sql` поверх существующей БД.

Первый reproducibility layer (отдельный checkout source SHA, Docker/Chrome local):

```sh
npm ci --prefix gateway
npm run test:r2 --prefix gateway
```

Это local synthetic layer, **не новый independent review, не deployed staging PASS**.
В Stage-0 suite не перезапускалась; отдельно выполненная локальная проверка SQL
пакета описана в [VALIDATION.md](stage0-24/VALIDATION.md); авторские протоколы не переименовывать в Stage-0 evidence.
Ниже — обязательная реальная staging HTTPS matrix; results все **NOT RUN**.

| Шаг | Действие и ожидаемый результат |
| --- | --- |
| Auth | anonymous API/assets 401; browser GET /dashboard Accept:text/html показывает login; form session не даёт dashboard; admin login → HttpOnly/Secure/SameSite=Strict cookie; logout и separate session |
| Origin | mutation missing/wrong Origin →403; valid exact Origin разрешён; GET groups без Origin read-only; CORS/browser → n8n отсутствует |
| Baseline | /, index/app/styles unchanged; public capture disabled; /api/dashboard filters/KPI/details/pagination; read outage →503 с явной ошибкой, не пустой success |
| Merge | L1+L2 → active group G1; 200 success/group_id/audit_id; leads/results/outbox до/после byte-equivalent кроме отдельного test capture |
| Extract + inverse | extract L1 из G1 →G2; revert extract через returned audit →точно восстановлены G1 members/status/removed fields; G2 retired; отдельно последний участник |
| Split + inverse | split eligible group → retired, active links сняты; revert →точный original state |
| Ignore + inverse | свободные L3/L4 → ignored, membership reserved; merge этих IDs →409; revert ignore освобождает links, audit сохраняется |
| Stale/repeat | новая overlapping mutation затем старый revert →409; повтор revert →409; ни DML ни новый audit на отказе |
| Invalid IDs | bad/missing/mixed/duplicate/non-array/0/>20; Gateway 400 или 422 по контракту; missing valid ID SQL→422; ни partial changes ни audit |
| Concurrency | два overlapping merge/ignore, split/extract, extract/extract, revert/revert и new mutation vs stale undo; одна валидная serial history, unique membership invariant; HTTP 503 timeout не считать доказательством absent commit |
| Audit UI | history/buttons из DB после refresh/logout/login; independent group/audit pagination; actor session identity без заявления user identity |
| WF-07 | явное разрешение передачи note, synthetic extraction; unknown null; отдельный checkbox для каждого поля; no auto-submit; summary не в WF-A body; source internal_form |
| Capture retries | double click один запрос; timeout/drop после persistence →same body+submission_id; replay receipt; refresh сохраняет только opaque ID; 422 edit same ID, 409 reconciliation без нового ID; ни PII ни key в storage |
| WF-08 | explicit 1–20 IDs, scoped real SQL; mock request содержит только IDs/categories; raw question/notes/name/email/phone не уходят; claims совпадают со context, citations subset; unsupported question → no-data |
| Faults | upstream redirect/malformed/oversize/>25 s timeout/429/5xx, SQL timeout/revoked execute, expired session, failure read; generic errors, no false success, stale data явно помечены |
| Side effects | никаких email/provider calls вне разрешённого mock; никакой записи/изменения WF-A–D/PAM; retention/proxy checks; baseline state hashes |
| Rollback rehearsal | §10 app-only rollback и восстановление candidate; counts/hashes CRM/audit прежние, capture/status работают; recording RTO |

Минимальные CLI команды HTTPS (Owner готовит private login JSON `{"access_key":…}`
и cookie jar, не echo ключа; response payloads private):

```sh
curl --fail --silent --show-error -c "$PRIVATE_DIR/admin.cookies" \
  -H "Origin: $STAGE_ORIGIN" -H 'Content-Type: application/json' \
  --data-binary "@$PRIVATE_DIR/admin-login.json" "$STAGE_ORIGIN/api/login" > /dev/null
curl --fail --silent --show-error -b "$PRIVATE_DIR/admin.cookies" \
  "$STAGE_ORIGIN/api/dashboard/groups" > "$PRIVATE_DIR/groups-before.json"
curl --fail --silent --show-error -b "$PRIVATE_DIR/admin.cookies" \
  -H "Origin: $STAGE_ORIGIN" -H 'Content-Type: application/json' \
  --data '{"lead_ids":["FAIR-00000000-0000-4000-8000-000000000001","FAIR-00000000-0000-4000-8000-000000000002"],"label":"Stage24 synthetic"}' \
  "$STAGE_ORIGIN/api/dashboard/groups" > "$PRIVATE_DIR/merge.json"
# POST split: {group_id}; extract: {group_id,lead_id}; ignore: {lead_ids,label};
# revert: {audit_id}. Audit/group IDs брать только из ответа текущего synthetic run.
# AI same cookie/Origin: POST /api/dashboard/ai/extract {notes};
# POST /api/dashboard/ai/ask {question,context_lead_ids}.
```

Перед/после каждой negative/concurrent/undo серии сверять exact state, audit delta,
исходные 5 tables и [postflight](stage0-24/neon-postflight.sql). При неизвестном commit
CRM mutation не повторять автоматически: перечитать DB/history и reconcile. У CRM нет
общего idempotency key на merge/split/extract/revert.

## 9. Provider / PII / retention decision sheet

**Все строки PENDING Owner.** До подписания разрешены только synthetic/mock staging tests.
`store:false` и выключенные workflow execution data не доказывают zero retention.

| Решение Owner | Что необходимо записать, без secret/PII |
| --- | --- |
| Provider identity | direct OpenAI или proxy/Requesty, actual endpoint/account/project, model/version, регион, subprocessors/DPA/доступ |
| Lawful processing | основание и полномочия сотрудников, notice/consent UX, разрешённые категории, purpose/access; один checkbox не заменяет решение |
| WF-07 flow | raw notes могут содержать names/email/phone/PII; запрет special-category и ненужных данных, minimization/redaction процесс |
| WF-08 flow | pseudonymous IDs + score/status/categories; linkability остаётся, raw question преобразуется локально; контекст не анонимен автоматически |
| Provider storage | retention/training/abuse monitoring, deletion/region/contract exceptions; отдельно проверить proxy forwarding/logs |
| n8n storage | workflow success/error/manual/progress none; instance DB, error workflow, telemetry/support export/runner debug logs, pruning и backup expiry |
| Gateway/proxy/APM | body/header/cookie/key/query logging выключены/redacted, error traces не содержат PII, сроки и доступ к access logs |
| Browser | только opaque pending ID для AI flow; no PII/key persistence; shared workstation/logout procedure |
| Evidence/backups | synthetic-only public evidence, private encrypted backup custody/expiry/deletion; кто имеет доступ |
| Live API trial | отдельное разрешение provider call/cost cap/max requests и stop threshold; synthetic trial сначала; real data отдельное решение |

## 10. No-data-loss rollback и recovery

O10 должен быть согласован **до** canary; аварийный trigger: ACL/auth bypass, PII leakage,
неправильная группировка/undo, missing audit, source mismatch, unexpected mail, impacted
PAM/n8n, restore failure. Оператор прекращает новые CRM/AI requests; убрать canary route,
дождаться/остановить in-flight requests и reconcile DB commit outcomes (не kill shared n8n).

1. На R2 fallback env установить `MESSE_CRM_ENABLED=false` **и** очистить **оба**
   `N8N_AI_EXTRACT_URL`, `N8N_AI_ASK_URL`. CRM flag сам AI не отключает.
   Dashboard/capture/status остаются; scoped DB schema/audit сохраняются.
2. Пересоздать только staging Gateway из saved **previous image digest/ID** + previous
   env + соответствующих web assets/routing. Нельзя вернуть только JS или mutable tag.
   Если предыдущий образ без Dashboard — заранее записать эту потерю UI доступности;
   данные всё равно сохранены. Старый контейнер/образ/env не удалять до gate.
3. Отключить только два новых WF staging IDs; не deactive shared workflows/instance.
4. Повторить baseline auth/capture/status и DB invariant/count/hash checks. Убедиться,
   что lead_groups/members/audit и новых событий не потеряно. Записать RTO и outcome.

```sh
# O10 только target record staging IDs; не глобальные stop/down.
for workflow_id in "$WF07_ID" "$WF08_ID"; do
  curl --fail --silent --show-error --config "$API_CFG" -X POST \
    "$N8N_API_ORIGIN/api/v1/workflows/$workflow_id/deactivate" > /dev/null
done
# После controlled route drain; recreate fallback с approved previous env.
docker stop messe-stage24-canary
docker run -d --name messe-stage24-fallback --restart=no \
  -p 127.0.0.1:3100:3000 --env-file "$PREVIOUS_ENV" "$PREVIOUS_IMAGE_ID"
# Reapply recorded read-only/caps/network/resource policy for actual previous image.
```

`dashboard_crm_v1_down.sql` в R2 — read-only no-op, **не восстанавливает приложение**.
Не выполнять destructive old DOWN, DROP/TRUNCATE CRM, purge audit, role removal или
`dashboard_role_production_rollback.sql` как часть отката CRM. DB corruption → freeze
writers, сохранить forensic snapshot, restore в **отдельную** БД, reconcile последующие
writes и approved forward repair/cutover; восстановление dump поверх live теряет новые
данные и требует самостоятельного Owner disaster-recovery решения. RPO=0 нельзя обещать
без доказанного capture/reconciliation. Staging clone deletion/backup purge тоже O12.

## 11. Manifest исполнения и release gates

Оператор создаёт новый immutable execution manifest (private raw + redacted GitHub copy):
source/docs commit, approval IDs, target branch/endpoint IDs, platform/base/candidate/
previous image digest, env **version ID** (не содержимое и не хеш коротких секретов),
workflow IDs+published versions+canonical hashes, credential **names/types/IDs**,
SQL file hashes, before/after catalog fingerprints, backup hash/location custody,
restore target+duration, synthetic test IDs+results, observation window/metrics,
rollback result, policy sign-off, reviewer+Owner verdict/time. Незаполненное → PENDING.
SHA256 пакета не заменяет подписанный Owner gate; новый runtime SHA требует re-review.

| Gate | Evidence для PASS | Stage-0 сейчас |
| --- | --- | --- |
| G0 packet | source freeze/delta/commands/approval map, docs-only GitHub publication | PREPARED; не deployment |
| G1 independent code review | Issue #23 exact SHA verdict и принятые условия, CI/local provenance | PENDING |
| G2 target/isolation | approved topology/branch mapping/resources, shared WF/PAM before inventory | NOT VERIFIED |
| G3 backup/restore | consistent exports + successful isolated restore + RPO/RTO | NOT RUN |
| G4 DB/ACL | catalog compatible, fresh UP, scoped real login, negative privileges | NOT RUN |
| G5 workflows | 2.41.7 actual active webhooks/header auth/envelopes/errors/retention, IDs pinned | NOT RUN |
| G6 CRM | вся §8 matrix actual HTTPS, invariants/concurrency/audit/UI | NOT RUN |
| G7 AI policy | §9 approved, mock minimization and authorized provider trial | PENDING / NOT RUN |
| G8 canary/rollback | immutable image, 30 min agreed metrics, no PAM/WF regression, app rollback no data loss | NOT RUN |
| G9 staging acceptance | G1–G8 evidence reviewed and Owner staging decision | **NO-GO** |
| G10 production release | separate Owner approval of merge/deploy/migration/cutover window/rollback; fresh prod preflight/backup | **NOT AUTHORIZED** |

Нет автоматического перехода Stage-0 → staging или staging → production. Любой failed/
unknown gate блокирует следующий этап. Этот пакет не закрывает независимое ревью #23.

## 12. Полный реестр отдельных разрешений Owner

| ID | Операции, требующие отдельного разрешения; граница |
| --- | --- |
| O1 | read-only доступ к названным Neon/VPS/n8n metadata, branch/endpoint verification, shared WF/PAM inventory; prod и staging указываются раздельно |
| O2 | Neon clone/create DB, schema-only/full backup, data export/copy/sanitize, encrypted storage/off-host transfer, n8n DB/volume/workflow backup и restore rehearsal в отдельном target |
| O3 | fresh baseline Dashboard role/snapshot migration, password provisioning если baseline отсутствует; existing корректное оставить |
| O4 | exact fresh CRM UP на approved staging branch; любое ACL/default privilege исправление или forward migration требует нового reviewed scope |
| O5 | scoped AI LOGIN/membership/auth provisioning, n8n credential creation/binding; создание отсутствующего compatible model credential; любые secret read/copy/rotation отдельны и не подразумеваются |
| O6 | импорт только новых WF-07/08 в dedicated staging, credential ID binding, private artifacts; без update WF-A–D/PAM |
| O7 | activation/deactivation только approved new staging workflow IDs, настоящий webhook invocation |
| O8 | build/resource use, registry push отдельно, image transfer/container/env/network/egress/vhost/certificate/DNS/reload/canary routing на named staging host; shared VPS отдельный scope |
| O9 | synthetic seed/write/concurrent/fault/capture tests, staging WF-A/D clones, model/API calls с cost cap; **real PII/provider отдельно после policy**; email delivery отдельно (для этого плана запрещена) |
| O10 | app-only rollback/recreate/routing restore/deactivate new workflows, rehearsal и аварийные triggers заранее; destructive DB recovery отдельно |
| O11 | merge PR #20/других PR, production preflight/backup/Neon SQL/roles/credentials/workflow import+activation/Gateway/nginx/DNS/TLS/cutover, live smoke и production rollback/DR — отдельное production go/no-go, ничего не наследуется из O1–O10 |
| O12 | cleanup/delete staging branches/volumes/backups/images, audit archive/purge и retention deletion; только после сохранения evidence и срока rollback |

Публикация этого документа/manifest на отдельной docs ветке и комментария в Issue #24
разрешена самим заданием. Merge, секреты и инфраструктурные операции этим не разрешены.
