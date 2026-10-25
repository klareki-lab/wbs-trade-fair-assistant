# PR #20 — Remediation R2: результаты и передача на независимое ревью

Дата: 2026-10-25 UTC. Issue #22. Реализация:
[`7c384edc2bc65ecc14b6a38278e0883a26dc8b91`](https://github.com/klareki-lab/wbs-trade-fair-assistant/commit/7c384edc2bc65ecc14b6a38278e0883a26dc8b91),
ветка `feat/messe-hub-full-integration`. Исходный проверенный SHA:
`90cd15128fb2870a60c530a0681b62a598172b76`, base PR `5fb6348`.
Перед работой local/remote HEAD совпадали; рабочая ветка была чистой.

**Статус реализации: READY FOR INDEPENDENT REVIEW.** Это авторская передача
исправлений, не независимое одобрение собственного кода и не staging/production
PASS. PR остаётся Draft. Infrastructure и реальные credentials не изменялись.

## Все девять замечаний аудита

Все исправления находятся в implementation commit `7c384ed`; следующий
документационный commit добавляет этот отчёт и протоколы без изменения runtime.

| № исходного аудита | Исправление и исходный файл | Доказательство | Состояние |
| --- | --- | --- | --- |
| 1. UP не применяется / SRF в WHERE | `_crm_validate_lead_ids` в `sql/production/dashboard_crm_v1_up.sql`: FROM jsonb_array_elements, строгая проверка всего массива | `tests/integration/crm_pg16.mjs`: original R2 UP применяется на PG16 без редактирования; rerun/missing gate отвергаются | закрыто кодом, local PASS |
| 2. Extract inverse теряет исходную связь | `_crm_change` сохраняет before-state; `crm_group_revert` сначала снимает новую связь, затем точно восстанавливает исходную группу | SQL test `split and extract revert restore EXACT...`, `extracting the only member...`; browser extract/undo | закрыто кодом, local PASS |
| 3. Несколько активных групп / гонки | Unique partial index + общий transaction advisory lock до чтения + lead FOR UPDATE в стабильном порядке; ignored тоже резервирует членство; overlapping merge/ignore → conflict | SQL tests simultaneous merge/ignore, split/extract, duplicate extracts; прямой duplicate INSERT → 23505, invariant checks | закрыто кодом, local PASS |
| 4. Старый revert повреждает новое состояние | Монотонные audit events и проверка любых новых пересечений lead/group; 409 STALE_REVERT без DML/audit | SQL tests stale merge/split/extract; concurrent newer merge vs old split undo в обоих порядках; duplicate revert | закрыто кодом, local PASS |
| 5. UI требует неизвестный audit UUID | `crm_groups_snapshot` возвращает paginated audit и can_revert; adapter allowlist; UI кнопки привязаны к audit_id из БД, отображаются actor/time/affected IDs/note/reversal | SQL new-connection snapshot и independent pagination; browser refresh/logout/login/undo без prompt | закрыто кодом, local PASS |
| 6. WF-08 excess context / PII / ложное grounding | `ai_lead_context` только explicit 1–20 IDs, scoped NOLOGIN role; категории вместо имён/почты/notes; raw question → разрешённые темы локально; model claims сверяются с exact context; ответ из проверенных значений; Gateway citation subset | PG scoped-context/ACL tests; WF Code forged fact/ID/extra-PII tests; actual isolated n8n SQL+LLM+parser с mock OpenAI; request capture подтверждает отсутствие direct PII | закрыто кодом, local PASS; live policy/bindings — staging gate |
| 7. WF-07/UI не соответствует WF-A / новый ID при retry | WF-A field limits, no summary in POST, source internal_form, индивидуальные checkbox; immutable pending body и тот же ID при retry; в sessionStorage только opaque ID, после refresh не ротируется; 422 edit / 409 retain | Gateway limits; browser выполняет реальный WF-A normalize/validate code на отправленном body; double click, unknown→refresh→retry exact ID/body, 422/409; n8n schema/evidence/unknown checks | закрыто кодом, local PASS |
| 8. Фильтрация плохих ID и дубликатов | SQL NULL для любого invalid array, explicit existence check перед записью; Gateway отказывает bad keys/types/duplicate ID | SQL null/non-array/number/object/null element/short ID/mixed bad/duplicate/missing ID; state equality до/после отказа | закрыто кодом, local PASS |
| 9. Разрушительный automatic DOWN | `dashboard_crm_v1_down.sql` теперь read-only no-op; app/image rollback и MESSE_CRM_ENABLED=false сохраняют tables/audit | SQL exact state equality до/после DOWN; Gateway switch оставляет baseline Dashboard доступным; deployment policy | закрыто кодом, local PASS |

## Запуски

Среда: Node v24.15.0 (host), Node 22 (Docker), PostgreSQL **16.13**,
n8n **2.41.7**, Playwright **1.58.2**, Google Chrome **155.0.8059.86**,
только синтетические данные. Использованные local image IDs:

- postgres:16-alpine — `sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50`
- n8nio/n8n:2.41.7 — `sha256:bcef56dd44014e09774219536a3f8cb07f1b553fcba94044bd9fc0f21f8676a3`
- node:22-bookworm-slim — `sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`

| Команда | Результат |
| --- | --- |
| `npm test --prefix gateway` | 67 PASS / 0 FAIL |
| `npm run test:sql --prefix gateway` | 13 PASS / 0 FAIL, настоящая PG16, реальные отдельные login sessions |
| `npm run test:workflows --prefix gateway` | 3 PASS / 0 FAIL: 2 Code/schema tests + 1 actual isolated n8n run для обеих цепочек |
| `npm run test:browser --prefix gateway` | 3 PASS / 0 FAIL: настоящий Chrome + Gateway + PG16 |
| `npm run test:r2 --prefix gateway` | **86 PASS / 0 FAIL / 0 skipped** суммарно |
| Node 22 Docker: `node --test tests/test_dashboard.mjs tests/test_gateway_baseline.mjs tests/test_gateway_dashboard.mjs` | дополнительно 67 PASS / 0 FAIL |
| `git diff --check` | PASS |

Протоколы: [полный локальный прогон](evidence/r2/full-local-tests.txt),
[Gateway Node 24](evidence/r2/gateway-node24.txt),
[Gateway Node 22](evidence/r2/gateway-node22.txt).

В исходной unit suite тест обратимости подменял SQL mock-объектом. Эти тесты
сохранены как API contracts; новая PostgreSQL suite проверяет actual state,
constraints, rollback и concurrent sessions. Старый статический запрет любого
sessionStorage заменён узким разрешением **только opaque submission ID**;
браузерный тест проверяет фактическое содержимое storage и отсутствие PII.

## Как воспроизвести

Из корня checkout implementation commit или последующего docs-only HEAD:

```sh
npm ci --prefix gateway
# Нужен доступный локальный Docker и Chrome. Платные API не нужны.
npm run test:r2 --prefix gateway
```

Для другого Chromium передать `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; по умолчанию
Playwright запускает отдельный headless Chrome profile через channel=chrome.
Контейнеры получают случайные имена `wbs-r2-test-*`/`wbs-r2-n8n-*`, порты PG
публикуются **только на 127.0.0.1**. Не используются пользовательские DATABASE_URL,
Neon/VPS env или живые credentials. PG fixture применяет **сохранённую полную DDL
пяти таблиц** из `sql/dashboard_confirmed_ddl.sql`, включая PK/FK/check/unique,
затем реальный R2 UP через psql с gate, без переписывания SQL. Dashboard и AI
проверяются через отдельные ограниченные login roles, не через SET ROLE из
привилегированной сессии. Контейнеры удаляются в finally.

SQL tests проверяют:

- все пять mutations + snapshot/helper; shape/cardinality/existence;
- exact inverse для split/extract, включая извлечение последнего участника;
- merge/ignore inverse, повтор/устаревшую отмену, before/after state equality
  на negative paths, неизменность baseline leads и отсутствие partial audit;
- две реальные сессии: merge/merge, merge/ignore, split/extract,
  extract/extract, revert/revert, merge vs old split revert в обоих порядках;
- уникальный active membership index; независимую pagination group/audit;
- отсутствие прямого table SELECT/DML/CREATE и helper EXECUTE у Dashboard,
  отсутствие PUBLIC grants, отсутствие table/snapshot/CRM write у AI role;
- отказ от SET ROLE owner, rerun/missing migration gate, data-preserving DOWN.

## WF-07/08: подтверждено и ещё не проверено

Подтверждено локально **настоящим n8n 2.41.7**: импорт в новый disposable instance,
выполнение Basic LLM Chain, Structured Output Parser 1.3 (его output wrapper),
Code validators, scoped PostgreSQL node, конечный JSON envelope. Mock OpenAI
получает `store:false`, фактический max_tokens; WF-08 не получает direct PII и
raw question. Контрактные negative tests проверяют неверные facts/citations,
попытку extra PII, unsupported values/evidence и prompt-injection данные.

Для CLI теста заменены только entry/exit transport (webhook → manual entry,
RespondToWebhook → no-op) и credential bindings на **синтетические**. Workflow
LLM/parser/SQL/Code исполняются из repo. Поэтому настоящий webhook header auth,
RespondToWebhook, HTTPS/proxy routing, live provider поведение и фактические
production/staging credential permissions **не подтверждены**. Это обязательная
последующая инфраструктурная приёмка, а не пропущенное заявление PASS.

Настоящая LLM с непредсказуемым ответом не запускалась. Проверка exact claims
ограничивает выдачу разрешёнными фактами, но не доказывает естественно-языковую
релевантность/полноту ответа. WF-07 raw note предназначена для обработки
провайдером только после UI согласия и Owner policy; PII policy остаётся gate.

## Оставшиеся условия staging и production

Подтверждённых **незакрытых кодовых дефектов из девяти** после R2 не оставлено.
До инфраструктурных шагов требуются:

1. Независимое ревью нового immutable HEAD другим reviewer/fresh review context.
2. Выделенный staging target; сверка реального catalog/types/constraints/
   extensions/default grants/memberships с repo DDL. Локальный тест не доказывает
   совпадение текущего Neon. Если CRM уже установлен — отдельная forward
   migration; текущий UP fresh-only.
3. Owner provision scoped AI Context login binding; проверить auth header,
   реальные webhook response/timeout/error, Origin/cookie и отсутствие публичных
   browser → n8n обращений через фактический staging HTTPS.
4. Owner утверждает provider/регион/retention/полномочия обработки PII. Проверить
   execution/manual/error/proxy logs; в staging использовать synthetic PII и
   mock provider до отдельного решения о реальном API.
5. Backup/export и **успешный restore** в отдельной БД, immutable image/web/env
   backup, canary/regression и app-only rollback rehearsal. Предыдущий
   destructive DOWN не применять.
6. Только затем отдельный production go/no-go Owner. PR не merge/deploy в R2.

Полный план rollout/rollback и decision log:
[`WBS_MESSE_HUB_FULL_INTEGRATION.md`](WBS_MESSE_HUB_FULL_INTEGRATION.md#миграция-безопасный-rollout-и-rollback).
Автоматический откат возвращает приложение/флаги, сохраняет CRM tables и audit.
Архивирование/purge — отдельная будущая Owner-authorized операция.

WF-A–D, форма и baseline SQL definitions не менялись. Production VPS/Neon/n8n,
секреты, реальные credentials и `main` не изменялись; merge/deployment не было.
