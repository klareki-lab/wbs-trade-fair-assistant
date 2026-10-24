# Messe-Hub – Paket für Sergii

Stand: 23.10.2026 · getestet auf n8n 2.40.7 (Juris Instanz)

Dein Kern (WF-A, WF-B, Status, Email mit der Neon-Datenbank) bleibt das Herzstück. Dazu kommen vier kleine
„Messe-Hub"-Workflows, die das HTML-Admin-Dashboard anbinden.

```
Messe-Admin-Hub.html ──(Basic Auth „Messe-Hub Login")──► Messe-Hub-Workflows 05–08
                                                          │  lesen deine Neon-DB (nur lesend)
                                                          │  „Lead erfassen": KI füllt deine Formularfelder aus
                                                          ▼
                              (Header Auth „WBS Trade Fair — Gateway Auth")──► WF-A ──► WF-B ──► Email
```

## Inhalt

| Datei | Was |
|---|---|
| `workflows/01–04` | deine vier Workflows (`WBS — …`) mit den Änderungen aus Juris Instanz |
| `workflows/05` | Daten fürs Dashboard (liest Leads, Status, Zusammenführungen) |
| `workflows/06` | Leads zusammenführen / trennen / herauslösen / „kein Duplikat" |
| `workflows/07` | Chat „Lead erfassen": Freitext-Notiz → KI → deine Formularfelder → WF-A |
| `workflows/08` | Chat „Lead-Assistent": Fragen zu den Leads |
| `Messe-Admin-Hub.html` | Admin-Dashboard (Login, Kennzahlen, Lead-Datenbank, Duplikate, Chats) |

In den Dateien stehen **keine Passwörter oder Schlüssel** – nur Verweise auf Credentials, die du bei dir auswählst.

## Was gegenüber deinem Original geändert ist

| Workflow | Änderung | Grund |
|---|---|---|
| alle 4 | alle Postgres-Nodes nutzen **eine** Rolle (`trade_fair_app`) statt Capture/Worker/Status getrennt | so war die Credential bei Juri eingerichtet – bitte prüfen, ob das zu deinem Sicherheitskonzept passt |
| WF-A, Status | Webhook-Credential „WBS Trade Fair — Gateway Auth" zugewiesen | |
| WF-B | „Research Company" nutzt den Credential-Typ **Tavily API** statt Header Auth | vorhandene Credential bei Juri |
| WF-B | „Extract Meeting Notes" ruft **Requesty** (`router.requesty.ai`, Credential-Typ OpenAI API) statt `api.openai.com`; Modell `openai/gpt-4.1-mini` | Juri hat Requesty statt OpenAI |
| WF-B | „Processing Configuration": Empfänger `juripoljanzewai@gmail.com`, Absender `reports@klare-ki.de` (deine Resend-Domain) | Empfänger bitte bei dir auf deine Adresse ändern |
| Email | **unverändert wie dein Original** (Resend), nur die Credential „WBS Trade Fair — Resend" zugewiesen | |

Deine Code-Bibliothek (Score, Prüfungen, Beleg-Check, E-Mail-Auswertung) ist in allen vier Workflows unverändert – deine Tests gelten weiter.

## Einrichtung

### 1. Datentabelle anlegen
In n8n unter **Data tables** eine Tabelle mit genau diesem Namen anlegen: **`Messe-Hub Gruppen-Verlauf`**
Spalten (alle Typ *String*): `gruppe_id`, `aktion`, `lead_ids`, `haupt_lead_id`, `ersetzt`, `grund`, `von`, `zeitpunkt`

Die Workflows 05, 06, 08 finden die Tabelle über den Namen. Zusammenführungen werden **nicht in Neon** gespeichert
(die Rolle `trade_fair_app` darf dort nichts ändern), sondern hier als Verlauf, in den nur angehängt wird – dadurch umkehrbar.

### 2. Credentials anlegen bzw. auswählen

| Typ | Name bei Juri | wofür | Nodes |
|---|---|---|---|
| Postgres | Sergii SQL trade fair assistant | deine Neon-DB | alle Postgres-Nodes in 01–06, 08 |
| Header Auth | WBS Trade Fair — Gateway Auth | `X-Trade-Fair-Key` | 01 Webhook Trigger, 03 Status Webhook, 07 „An Sergiis WF-A senden" (**derselbe Wert** wie bei WF-A) |
| Basic Auth | Messe-Hub Login | Login fürs Dashboard (Benutzer + Passwort frei wählbar) | 05, 06, 07, 08 – jeweils der Trigger |
| OpenAI API | OpenAI account | KI (bei Juri: Requesty-Key mit Base URL `https://router.requesty.ai/v1`) | 02 Extract Meeting Notes, 07/08 „Requesty AI" |
| Tavily API | Tavily account | Firmenrecherche | 02 Research Company |
| Header Auth | WBS Trade Fair — Resend | Versand des Berichts (`Authorization: Bearer <Resend-Key>`) | 04 Send Sales Report |

### 3. Importieren
n8n → **Import from File** (jede Datei einzeln) oder per CLI:
```
n8n import:workflow --separate --input=workflows
```
Danach in jedem Workflow die Nodes mit fehlender Credential öffnen und deine Credential auswählen.

### 4. Anpassen (nur falls nötig)
- **Empfänger/Absender:** 02 → Node „Processing Configuration" → `sales_report_recipient` (bei Juri: seine Adresse – bei dir deine) /
  `sales_report_sender` (muss auf deiner in Resend verifizierten Domain `klare-ki.de` liegen).
- **OpenAI direkt statt Requesty:**
  02 „Extract Meeting Notes" → URL `https://api.openai.com/v1/chat/completions`;
  02 „Processing Configuration" → `ai_model` `gpt-4.1-mini`;
  07/08 Node „Requesty AI" → Modell `gpt-4.1-mini` bzw. `gpt-4o` (ohne `openai/`).
- **Kein Credential-Typ „Tavily API"** (kommt vom Community-Node `@tavily/n8n-nodes-tavily`):
  02 „Research Company" auf *Generic Credential → Header Auth* umstellen, Header `Authorization`, Wert `Bearer <Tavily-Key>` – wie in deinem Original.
- **Nichts zu tun:** Die WF-A-Adresse in 07 ermittelt n8n selbst aus der eigenen Instanz-Adresse; die Chat-Adressen der Workflows bleiben beim Import gleich.

### 5. Aktivieren
Alle acht Workflows aktivieren. Ohne aktives WF-A meldet „Lead erfassen" im Chat „WF-A nicht aktiv".

### 6. Dashboard
In `Messe-Admin-Hub.html` die Zeile `n8nUrl: '…'` auf deine n8n-Adresse setzen (ohne `/` am Ende), Datei im Browser öffnen,
mit den Daten von „Messe-Hub Login" anmelden. Optional können `benutzer`/`passwort` oben in der Datei eingetragen werden
(dann kann sie aber jeder lesen, der die Datei hat).

## Wichtig

- **Gemeinsame Datenbank:** Nutzt deine Instanz dieselbe Neon-DB wie Juris, sollten **WF-B und Email nur auf einer Instanz aktiv** sein.
  Sonst teilen sich beide die Warteschlange – deine Leases verhindern Doppelverarbeitung, aber der Bericht geht an die Adresse
  der Instanz, die den Lead gerade übernimmt. Dashboard, „Lead erfassen" und WF-A können auf beiden laufen.
- **11 Leads stehen auf „Fehler" (`AI_REQUEST_REJECTED`):** Juris Requesty-Konto hatte beim Befüllen sein Monatslimit erreicht
  (HTTP 412 „monthly spend limit"). Nach Erhöhung des Limits kannst du sie mit deiner **Operator-Rolle** neu einreihen
  (`trade_fair_app` darf das nicht):
  ```sql
  SELECT lead_id, trade_fair.retry_failed_processing(lead_id, 'Requesty-Limit erhöht') AS ergebnis
  FROM trade_fair.lead_submissions
  WHERE processing_status = 'failed' AND last_error_code = 'AI_REQUEST_REJECTED';
  ```
- **Execution-Daten:** Deine Workflows speichern keine Läufe. Fehler sieht man im Dashboard (Verarbeitung „Fehler" + Fehlercode in der Detailansicht).
- **KI-Zusammenfassung und Firmenrecherche** erscheinen im Dashboard erst, wenn `trade_fair_app` Leserecht auf `processing_results`
  bekommt (oder eine eigene Lesefunktion). Bis dahin stehen sie nur im E-Mail-Bericht.

## Zur Abstimmung

1. Die KI in 07 füllt deine Formularfelder (Training, Budget, Follow-up) – damit beeinflusst sie indirekt deinen Score, den du bewusst KI-frei gebaut hast.
2. Eine Datenbank-Rolle statt drei getrennter Rollen.
3. Requesty ist ein zusätzlicher Dienstleister, über den Gesprächsnotizen laufen (Datenschutz).
4. Später geplant: Mitarbeiter-Dashboard mit eigenen Logins, in dem jeder nur seine Leads anlegt und sieht.
   Das Feld `von` im Gruppen-Verlauf speichert schon heute den Login-Namen.

## Was getestet wurde

- 32 automatische Tests der Messe-Hub-Logik (Zusammenführen, Trennen, Vorschläge, Feldprüfung, Chat-Antworten)
- Live in n8n: Daten, Zusammenführen, „Lead erfassen" (KI-Auswertung + Übergabe an WF-A), Lead-Assistent; WF-A mit dem neuen Schlüssel
- Resend ohne Versand: Domain `klare-ki.de` ist verifiziert, der Schlüssel wird akzeptiert (Anfrage ohne Empfänger → 422 „Missing `to`")
- Dashboard im Browser (Detailansicht, Duplikate, Zusammenführen, Trennen, Chat)
- 21 echte Fälle über das Dashboard erfasst; 10 wurden komplett verarbeitet, 11 scheiterten am Requesty-Limit (siehe oben)
