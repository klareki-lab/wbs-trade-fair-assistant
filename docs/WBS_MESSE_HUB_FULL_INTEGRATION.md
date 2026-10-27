# Messe Hub FULL — R2, Issue #22

Статус: реализация для повторного независимого ревью PR #20. Это не разрешение
на staging/production. Исходный аудит: Issue #21, SHA
`90cd15128fb2870a60c530a0681b62a598172b76`. База PR: TF-12 `5fb6348`.
Результаты локальных тестов и таблица всех девяти замечаний: `docs/R2_TEST_REPORT.md`.

## Область и сохранённые пути

Сохраняются Dashboard, полноценные виртуальные CRM-группы, merge/split/extract/
ignore/revert, AI-ввод с подтверждением и Lead-Assistent. Никаких изменений
определений WF-A/B/C/D, `web/index.html`, `web/app.js`, существующих ключей,
данных или работающих сервисов пакет R2 не выполняет. Авторизация Dashboard
по-прежнему использует отдельный `DASHBOARD_ACCESS_KEY` и подписанную cookie
HttpOnly/SameSite=Strict; POST требует точный Origin. Штатные capture/status
маршруты сохраняются. Источник AI-отправки — `internal_form`, который выставляет
Gateway. Это источник, а не признак верифицированной личности.

## Правила CRM

- Один lead имеет не более одного текущего членства (`removed_at IS NULL`),
  защищённого **уникальным partial index**. Ignored-группа также резервирует
  членство. Merge/ignore уже сгруппированного lead возвращает 409; для переноса
  сначала явно разделяют или отменяют его текущую группу. Нет молчаливого
  объединения групп и потери старых связей.
- `_crm_validate_lead_ids` отвергает запрос целиком при non-array, пустом/слишком
  длинном массиве, non-string/null/неверном FAIR ID или повторе. Merge требует
  2–20, ignore 1–20; существование всех ID проверяет БД.
- Все записи CRM берут один transaction advisory lock `(20822,1)` **до чтения
  CRM**, затем блокируют затронутые lead-строки в лексическом порядке. Это
  осознанная сериализация для небольшого CRM; предел запроса Gateway 5 секунд.
  При росте нагрузки понадобится отдельная оценка throughput; корректность
  имеет приоритет. Никакого write retry с новым смыслом операции нет.
- Split удаляет текущие связи и переводит группу в retired; extract создаёт
  одноэлементную группу и сохраняет полное before-state исходной. При извлечении
  последнего участника исходная группа становится retired. Отмена восстанавливает
  **точные** removed/status поля исходной группы и сохраняет новые записи в истории.
- Audit имеет монотонный `event_no`, actor сессии, время, затронутые lead/group ID,
  before-state, note, reversal link. Actor — идентификатор сессии, не проверенная
  личность сотрудника. Raw before-state не выдаётся browser API.
- Отмена разрешена лишь для нереверсированной mutation, после которой **нет
  никаких более новых событий с пересечением lead или group**. Более поздняя
  отмена тоже считается событием: политика консервативная, старые действия
  автоматически снова доступными не становятся. Устаревший запрос — 409
  `STALE_REVERT` без DML и без нового audit. Повтор отмены — `ALREADY_REVERTED`.
- Журнал читается из БД; `can_revert` вычисляется сервером. Browser использует
  UUID кнопки, не просит его вводить. Группы и журнал имеют отдельные страницы.
  Обновление страницы и новый вход не теряют историю. На ошибке чтения прежняя
  информация остаётся с явной ошибкой вместо ложного пустого CRM.

## Матрица приёмки Юрия

| Действие | Реализация R2 | Локальная проверка | Staging / prod |
| --- | --- | --- | --- |
| Dashboard KPI, фильтры, сортировка, pagination, details | существующий snapshot/TF-12 сохранён | Gateway regression + browser с PG16 | R2 не проверено |
| Merge | multi-select, label, transaction + unique membership | SQL и browser, включая два concurrent merge | не проверено |
| Split | текущая группа → retired | SQL/browser, inverse и concurrent extract | не проверено |
| Extract | перенос одного lead, before-state исходной группы | SQL/browser, включая последний участник и inverse | не проверено |
| Ignore | отдельная ignored-группа с единственным членством | SQL/browser, inverse и конфликт merge | не проверено |
| Revert | кнопка в журнале для каждого eligible audit | SQL/browser, refresh, logout/login, stale/repeat | не проверено |
| История | Neon audit, before-state, actor, reversal; paginated UI | PostgreSQL и browser | не проверено |
| AI capture | note → extraction → подтверждение каждого поля → WF-A | browser + настоящий WF-A normalize/validate code; isolated n8n chain с mock model | не проверено |
| AI retry | неизменные body/ID при неизвестном результате, 422 edit, 409 stop/conflict | browser, double click и refresh | не проверено |
| Lead-Assistent | только разрешённый контекст ID/категорий, проверенные claims | PostgreSQL + Code tests + isolated n8n chain с mock model | не проверено |
| Оригинальные chat endpoints / WF-06 Data Table | заменены same-origin Gateway / Neon CRM, функциональность сохранена | browser и SQL | не импортированы |

## WF-07: контракт и персональные данные

Клиент отмечает разрешение передачи note внешнему провайдеру **до анализа**.
Лимит note 10000; UI предупреждает о передаче. WF-07 передаёт note модели для
извлечения; она может содержать PII. Это не анонимный маршрут. Owner должен
подтвердить основание обработки, выбранного провайдера, регион/retention и
согласие/полномочия пользователей до staging с любыми реальными данными.

Basic LLM Chain без tools и памяти + manual JSON schema возвращают extracted и
exact evidence. Postprocessor убирает значения без цитаты в note, неизвестные
поля/enum; контактные значения должны содержаться в своей цитате. Unknown →
null. Confidence не сочиняется. Это ограничение выхода и помощь сотруднику,
а не доказательство правдивости записи. Каждый заполненный field, включая
training_interest/budget/follow_up, требует отдельного checkbox подтверждения.

WF-A получает только разрешённые contract fields; `summary` не отправляется.
До определённого ответа body неизменен, поля заблокированы, второй клик в полёте
отклоняется. Один `submission_id` сохраняется для retry. В sessionStorage лежит
**только этот непрозрачный ID**, никогда note/email/phone/ключ или AI-result.
При refresh сотрудник повторно вводит данные, но ID сохраняется: изменённый body
уже сохранённого запроса даст 409, а не новый lead. После 422 `not_stored` можно
исправлять поля с тем же ID; после 409/unknown ID не сбрасывается. 200 replay и
201 persisted завершают отправку и очищают ID. Неподтверждённый исход требует
reconciliation по receipt, а не «создать новый».

## WF-08: минимизация и проверяемые ответы

`ai_lead_context(jsonb)` читает **только 1–20 запрошенных уникальных существующих
ID**; full-page `dashboard_snapshot` больше не используется. Внешняя модель
получает FAIR ID, score, статусы и allowlisted training/budget/follow-up enums.
Никаких company/contact names, email, phone, notes, research, raw payload.
FAIR ID остаётся псевдонимом, а не гарантией анонимности.

Сырая формулировка вопроса тоже не передаётся модели: Code node локально
выделяет разрешённые темы и формирует запрос из констант. Unsupported вопросы
дают «нет данных». Модель предлагает `claims[{lead_id,field,value}]`; postprocessor
сверяет каждое поле и значение с реально доставленным контекстом и разрешёнными
темами. Свободный текст модели в ответ не копируется: ответ строится из
проверенных claims. Gateway дополнительно отвергает чужую citation ID.
Это проверяет происхождение значения, а не правильность существующих данных
и не полноту/релевантность ответа на естественном языке.

WF-07/08: `store:false`, лимиты генерации 2000/1200, timeout 20 s, без model
retry/autoFix и tools; gateway timeout 25 s, size 64 KiB, JSON content-type,
redirect:error. В JSON workflow отключено сохранение успешных, ошибочных и
manual execution data и прогресса. Фактические instance/log/provider настройки
подлежат проверке Owner: эти JSON не гарантируют отсутствие чужих debug/proxy
логов или retention у провайдера.

## Конфигурация и credential mapping (только имена)

Существующие `DASHBOARD_ACCESS_KEY`, `DASHBOARD_DATABASE_URL`, `SESSION_SECRET`,
`TRADE_FAIR_ACCESS_KEY`, `N8N_HEADER_KEY`, capture/status URL остаются прежними.

| Имя | Назначение |
| --- | --- |
| `MESSE_CRM_ENABLED` | true по умолчанию при включённом Dashboard; false для app-only rollback |
| `N8N_AI_EXTRACT_URL`, `N8N_AI_ASK_URL` | оба заданы или оба пусты; private Gateway env |
| `N8N_AI_ALLOWED_ORIGIN` | точный trusted origin, без path/query/userinfo; по умолчанию origin capture URL |
| `WBS Trade Fair — Gateway Auth` | header auth существующего `X-Trade-Fair-Key`; проверить binding на staging |
| `WBS Trade Fair — OpenAI  19.10` | имя в inactive artifact; Owner проверяет реальную привязку и политику провайдера |
| `WBS Trade Fair — AI Context (scoped read only)` | отдельная staging/login credential с членством только в `trade_fair_ai_context` |

Для публичного HTTPS Gateway внешние AI URL обязаны быть HTTPS; HTTP допустим
только для loopback n8n. Origin обоих URL должен совпадать с trusted origin.
Browser не получает URL/ключи и обращается только к same-origin API.

Новая роль `trade_fair_ai_context` — NOLOGIN, EXECUTE только на `ai_lead_context`,
USAGE schema, без таблиц/CRM mutations/snapshot. Login binding и фактические
эффективные ACL — Owner/staging gate. Широкая `WBS Trade Fair — Neon PostgreSQL`
credential больше не используется в WF-08. Существующие credentials не менялись.

## Миграция, безопасный rollout и rollback

UP — **fresh install only**; сам проверяет owner/database, schema, роль Dashboard,
отсутствие CRM/AI role и отсутствие CREATE у Dashboard. Ранее применённого CRM
в production не предполагаем: перед любой операцией проверить catalog. Если
предыдущая версия уже применена где-либо, остановиться и подготовить отдельную
проверенную forward migration с сохранением audit. Не DROP/recreate.

Репозиторный тест использует сохранённый `sql/dashboard_confirmed_ddl.sql` с
пятью таблицами и constraints/FK, но не доказывает совпадение с текущим Neon,
role memberships, extensions, default grants или live schema drift.

1. Получить повторное независимое ревью **нового фиксированного SHA**. PR остаётся
   Draft. Сравнить реальный staging catalog/ACL с reviewed DDL, проверить PUBLIC,
   schema CREATE, function owners/search_path, эффективные memberships и grants.
2. В выделенном staging/клоне схемы снять backup/export и **проверить restore**.
   Только на подтверждённом target, как `neondb_owner`:
   `psql -X -v ON_ERROR_STOP=1 -v production_branch_confirmed=on -f sql/production/dashboard_crm_v1_up.sql`.
   Имя gate историческое, оно не определяет Neon branch: target проверяет Owner.
3. Подключить отдельную read-only AI context credential на staging; не расширять
   WF-A–D роль. Импортировать/активировать WF-07/08 **только в выделенном staging**
   после Owner решения, с synthetic PII и mock provider. Проверить настоящий
   webhook header auth, response node, timeouts/errors, session, CSRF, retention.
4. Собрать immutable Gateway image из reviewed SHA; не использовать mutable latest.
   Сохранить предыдущий image/container/env и web mount snapshot. Выполнить
   canary UI/CRM/AI через HTTPS: все операции и отмены, конфликт/timeout/retry,
   logout/login, public form и capture/status. Убедиться, что не было email sends.
5. Production требует отдельного письменного Owner go/no-go после staging,
   backup/restore evidence, PII/provider решения и списка ожидаемых изменений.
   Не применять миграцию напрямую на production «если staging нет».
6. При проблеме остановить новые CRM/AI mutations, вернуть прежний image и web
   assets/env. Для оставшегося R2 Gateway временно задать `MESSE_CRM_ENABLED=false`,
   очистить оба AI URL. Существующий Dashboard и capture/status продолжают работать.
   **Не менять SESSION_SECRET и ключи. Не выполнять schema DOWN/DROP/DELETE.**
7. `dashboard_crm_v1_down.sql` теперь read-only policy/no-op. Проверено, что после
   него группы, связи и audit идентичны. Ранее сохранённый разрушительный DOWN
   запрещён в automatic rollback. Совместимый старый код игнорирует новые таблицы.
8. CRM audit и данные сохраняются для расследования/forward repair. Удаление
   схемы — отдельная будущая ручная процедура после Owner approval: полный
   архив таблиц/ACL/functions, контроль counts/checksums и успешный restore в
   отдельной БД, подтверждённые retention/legal требования. Purge script в R2
   намеренно не включён в путь отката приложения.

## Decision log R2

- Уникальное членство включает ignored; существующие группы не перемещаются
  молча. Это явный конфликт, доступный split/revert остаётся полноценной CRM.
- Записи сериализуются глобально; инвариант дополнительно защищает unique index.
- Undo допускает только операции без новых зависимых событий; весь before-state
  для extract/split остаётся в БД.
- Настоящая audit history заменяет требование вводить UUID вручную.
- Непрозрачный submission ID — единственное исключение из запрета browser storage;
  тесты проверяют отсутствие сохранённых персональных данных.
- WF-08 отделён от широкого snapshot и SQL credential; его ответы строятся из
  проверенных категориальных фактов, сырая формулировка вопроса остаётся в n8n.
- Automatic rollback сохраняет CRM schema/audit. Все infrastructure действия
  остаются отдельными Owner gates. Локальный PASS не переименовывается в staging.
