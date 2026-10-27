// WBS-TF-UI-01 — regression tests for the human-readable lead details drawer.
// Reuses the same PG16 + Gateway harness as messe_hub.mjs; injects synthetic
// lead variants into window.items so the real showDetail renderers run against
// a real DOM, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chromium } from '../../gateway/node_modules/playwright/index.mjs';
import pg from '../../gateway/node_modules/pg/lib/index.js';
import { createGateway, loadConfig } from '../../gateway/server.mjs';
import { createDashboardCrm } from '../../gateway/dashboard-crm.mjs';
import { createDashboardDb } from '../../gateway/dashboard-db.mjs';
import { startPg16, ids } from '../helpers/pg16.mjs';

let db, browser, server, base, config;
const response = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test.before(async () => {
  db = await startPg16();
  const connectionString = `postgresql://trade_fair_dashboard:synthetic-local-only@127.0.0.1:${db.port}/neondb`;
  const factory = (opts) => new pg.Pool({ ...opts, ssl: false });
  config = loadConfig({
    HOST: '127.0.0.1', PORT: '3000', APP_ORIGIN: 'http://127.0.0.1:3000',
    TRADE_FAIR_ACCESS_KEY: 'synthetic-form-key-only',
    DASHBOARD_ACCESS_KEY: 'synthetic-admin-key-only',
    SESSION_SECRET: 'synthetic-session-secret-32-characters',
    N8N_HEADER_KEY: 'synthetic-header',
    N8N_CAPTURE_URL: 'http://mock.test/capture', N8N_STATUS_URL: 'http://mock.test/status',
    DASHBOARD_ENABLED: 'true', DASHBOARD_DATABASE_URL: connectionString,
    N8N_AI_EXTRACT_URL: 'http://mock.test/extract', N8N_AI_ASK_URL: 'http://mock.test/ask',
  });
  const fetchImpl = async () => response(200, { success: true });
  server = createGateway(config, {
    dashboardStore: createDashboardDb({ connectionString, poolFactory: factory }),
    crmStore: createDashboardCrm({ connectionString, poolFactory: factory }),
    fetchImpl,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`; config.origin = base;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : { channel: 'chrome' }) });
});
test.after(async () => {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await db?.close();
});

async function openDrawer(page, lead) {
  await page.goto(base + '/dashboard');
  await page.locator('#access-key').fill(config.dashboardAccessKey);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForSelector('input.row-sel');
  // Replace the loaded lead array with the single synthetic lead under test.
  await page.evaluate((l) => window.__wbsRenderLeadDetail(l), lead);
  await page.waitForSelector('#drawer.open');
}

test('UI: null AI extraction renders "Keine KI-Bewertung vorhanden" and no raw JSON', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openDrawer(page, { lead_id: ids[0], company: 'Nullfirma', ai_extraction: null, company_research: null, uncertainty_flags: [], possible_contact_ids: [], ai_uncertainty: null });
    const text = await page.locator('#msgs').innerText();
    assert.match(text, /Keine KI-Bewertung vorhanden/, 'AI panel shows null wording');
    assert.match(text, /Keine zusätzlichen Hinweise vorhanden/, 'uncertainty panel shows empty wording');
    assert.match(text, /Keine Firmenrecherche vorhanden/, 'company research shows null wording');
    assert.doesNotMatch(text, /"company_name"\s*:/, 'no raw JSON key leaks');
    assert.doesNotMatch(text, /"uncertainty_flags"/, 'no raw JSON key leaks');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('UI: populated AI extraction + research render German labels and enum translations', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openDrawer(page, {
      lead_id: ids[0], company: 'Müller Logistik',
      training_interest: 'ai_automation', budget_status: 'planned', follow_up: 'within_one_week',
      ai_extraction: {
        company_name: 'Müller Logistik GmbH', contact_name: 'Anna Weber',
        email: 'a@b.test', phone: '+49 30 1', website: 'https://example.test',
        training_interest: 'ai_automation', budget_status: 'approved', follow_up: 'within_two_weeks',
        follow_up_date: '2026-12-01', notes: 'Synthetic note',
        confidence: { company_name: 0.92, email: 0.4, unknown_future_field: 0.5 },
        proprietary_future_field: { nested: 'value' },
      },
      company_research: { name: 'Müller Logistik GmbH', industry: 'Logistik', employees: 240, website: 'https://müller.test', future_section: { score: 7 } },
      uncertainty_flags: ['email_missing', 'low_confidence'],
      possible_contact_ids: ['11111111-1111-4111-8111-111111111111'],
      ai_uncertainty: { email: 0.4, phone: 'nicht sicher' },
    });
    const text = await page.locator('#msgs').innerText();
    assert.match(text, /KI & Automatisierung/, 'training enum translated');
    assert.match(text, /Freigegeben/, 'budget enum translated (approved)');
    assert.match(text, /Innerhalb von zwei Wochen/, 'follow_up enum translated');
    assert.match(text, /Firmenname[\s\S]*Müller Logistik GmbH/, 'company name labelled');
    assert.match(text, /Konfidenz[\s\S]*92 %/, 'confidence rendered as percent');
    assert.match(text, /Branche[\s\S]*Logistik/, 'research industry labelled');
    assert.match(text, /Mitarbeitende[\s\S]*240/, 'research employees labelled');
    assert.match(text, /E-Mail-Adresse fehlt/, 'uncertainty flag translated');
    assert.match(text, /Niedrige KI-Konfidenz/, 'uncertainty flag translated');
    assert.doesNotMatch(text, /"proprietary_future_field"/, 'unknown field key not shown as raw JSON');
    // Collapsible <details> preserves unknown information
    assert.equal(await page.locator('#msgs details.tech-details').count() >= 1, true, 'collapsible fallback present');
    const detailsText = await page.locator('#msgs details.tech-details').first().innerText();
    assert.match(detailsText, /Technische Details|Weitere KI-Felder|Rohdaten/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('UI: untrusted strings are escaped, never rendered as HTML (XSS safety)', async () => {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await openDrawer(page, {
      lead_id: ids[0], company: 'XSS Testfirma',
      ai_extraction: { company_name: '<img src=x onerror=alert(1)>', notes: '<script>alert(2)</script>' },
      company_research: { description: '<img src=y onerror=alert(3)>', custom: '<svg onload=alert(4)>' },
      uncertainty_flags: ['<img src=z onerror=alert(5)>'],
      possible_contact_ids: ['<script>alert(6)</script>'],
      ai_uncertainty: { email: '<img src=w onerror=alert(7)>' },
    });
    // No executed script, no injected elements.
    assert.equal(await page.locator('#msgs img').count(), 0);
    assert.equal(await page.locator('#msgs script').count(), 0);
    assert.equal(await page.locator('#msgs svg').count(), 0);
    const text = await page.locator('#msgs').innerText();
    // Angle brackets survive as text — proving textContent path was used.
    assert.match(text, /<img src=x onerror=alert\(1\)>/);
    assert.match(text, /<script>alert\(2\)<\/script>/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
