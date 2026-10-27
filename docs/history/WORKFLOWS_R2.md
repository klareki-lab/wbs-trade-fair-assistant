# Адаптированные WF-07/08 — R2, не активированы

См. `docs/WBS_MESSE_HUB_FULL_INTEGRATION.md` и `docs/R2_TEST_REPORT.md`.
WF-A/B/C/D и их credentials не меняются. CRM работает напрямую через Gateway и
PostgreSQL; WF-06/Data Table для группировок не требуется.

WF-07: header-auth webhook → проверка note 10–10000 → Basic LLM Chain + manual
schema → проверка exact evidence/enum/limits → `{success,extracted,confidence:{},
uncertainty_flags,assistant_message}`. Unknown → null, notes сохраняет введённый
текст. Summary можно показать, но UI не отправляет его в WF-A. Перед анализом
пользователь разрешает передачу note провайдеру, перед WF-A отдельно подтверждает
каждое поле. Никакого auto-submit и tools. Заметки могут содержать PII: Owner
утверждает провайдера/основание/retention до любых реальных данных.

WF-08: проверка question/context IDs → **параметризованный** вызов
`trade_fair.ai_lead_context($1::jsonb)` → строгая проверка context → LLM Chain
с запросом только разрешённых тем → проверка claims по доставленным фактам →
детерминированный ответ с citation ID. Только 1–20 явно запрошенных ID; ни full
snapshot, ни имени/почты/телефона/заметки в context. Raw question локально
преобразуется в темы; она не идёт модели. Pseudonymous FAIR IDs остаются
связуемыми идентификаторами. Model free text не выдаётся за доказанный факт.

Credential mapping, только имена:

- `WBS Trade Fair — Gateway Auth`: существующий Header Auth, Gateway использует
  `X-Trade-Fair-Key`. Проверить реальный binding в выделенном staging.
- `WBS Trade Fair — AI Context (scoped read only)`: **новый scoped login binding**
  только к NOLOGIN роли `trade_fair_ai_context`; Owner provision на staging.
  Роль не может читать таблицы, вызывать dashboard_snapshot или писать CRM.
  Широкую `WBS Trade Fair — Neon PostgreSQL` credential здесь не использовать.
- `WBS Trade Fair — OpenAI  19.10`: имя в artifact; реальное значение не хранится
  в Git. В локальном тесте заменено синтетической credential и mock endpoint.

`N8N_AI_EXTRACT_URL` и `N8N_AI_ASK_URL` задаются вместе; trusted origin через
`N8N_AI_ALLOWED_ORIGIN` либо существующий capture origin. Внешний transport
для HTTPS Gateway — HTTPS; loopback HTTP разрешён. API отключено fail-closed
при пустых URL. Browser не обращается к webhook напрямую.

Оба JSON: `active:false`, `store:false`, no tools/memory/autoFix/model retry,
maxTokens 2000/1200, 20 s model timeout, 30 s workflow timeout, execution data
success/error/manual/progress не сохраняется. Это workflow settings; реальные
instance/proxy/provider logs и retention проверяются отдельно.

Локальная проверка:

```sh
npm ci --prefix gateway
npm run test:workflows --prefix gateway
```

Тест поднимает новый n8n 2.41.7 с отдельной SQLite, PostgreSQL 16 и HTTP mock
OpenAI. Для CLI прогона только webhook/Respond заменены на manual entry/no-op;
LLM, parser, Code и Postgres nodes исполняются настоящим n8n. Проверяются реальный
response envelope, schema, context и отсутствие PII в запросе к mock model.
Платные API и production не вызываются. Webhook header auth, live provider,
HTTPS и реальный staging credential binding этим тестом не подтверждаются.
