// WBS Messe-Hub CRM — one PostgreSQL connection shared with dashboard-db, lazy.
// Calls SECURITY DEFINER functions trade_fair.crm_group_*. No raw DML from the gateway.
// Allowlist on return: group_id, label, status, created_at, created_by, retired_at, members[].

const LEAD_ID = /^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_SET = new Set(['active', 'retired', 'ignored']);

export function parseCrmListQuery(params) {
  const page = Number(params.get('page') ?? '1');
  const limit = Number(params.get('limit') ?? '25');
  const includeRetired = params.get('include_retired') === 'true';
  for (const [k] of params) if (!['page', 'limit', 'include_retired'].includes(k) || params.getAll(k).length !== 1) throw new RangeError('Invalid query');
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new RangeError('Invalid pagination');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid pagination');
  return { page, limit, offset: (page - 1) * limit, includeRetired };
}

export function validateMergePayload(body) {
  if (!body || typeof body !== 'object') return null;
  const ids = Array.isArray(body.lead_ids) ? body.lead_ids : null;
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!ids || ids.length < 2 || ids.length > 20) return null;
  if (!ids.every((x) => typeof x === 'string' && LEAD_ID.test(x))) return null;
  if (label.length < 1 || label.length > 160) return null;
  const note = typeof body.note === 'string' && body.note.length <= 2000 ? body.note : null;
  return { lead_ids: ids, label, note };
}
export function validateIgnorePayload(body) {
  if (!body || typeof body !== 'object') return null;
  const ids = Array.isArray(body.lead_ids) ? body.lead_ids : null;
  if (!ids || ids.length < 1 || ids.length > 20) return null;
  if (!ids.every((x) => typeof x === 'string' && LEAD_ID.test(x))) return null;
  const label = typeof body.label === 'string' && body.label.length <= 160 ? body.label : 'Ignoriert';
  const note = typeof body.note === 'string' && body.note.length <= 2000 ? body.note : null;
  return { lead_ids: ids, label, note };
}
export function validateGroupIdPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const id = typeof body.group_id === 'string' && UUID.test(body.group_id) ? body.group_id : null;
  if (!id) return null;
  const note = typeof body.note === 'string' && body.note.length <= 2000 ? body.note : null;
  return { group_id: id, note };
}
export function validateExtractPayload(body) {
  const base = validateGroupIdPayload(body);
  if (!base) return null;
  const lead = typeof body.lead_id === 'string' && LEAD_ID.test(body.lead_id) ? body.lead_id : null;
  if (!lead) return null;
  return { ...base, lead_id: lead };
}
export function validateRevertPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const audit = typeof body.audit_id === 'string' && UUID.test(body.audit_id) ? body.audit_id : null;
  if (!audit) return null;
  const note = typeof body.note === 'string' && body.note.length <= 2000 ? body.note : null;
  return { audit_id: audit, note };
}

function pickMember(m) {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.lead_id !== 'string' || !LEAD_ID.test(m.lead_id)) return null;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : (v == null ? null : null);
  const date = (v) => v == null ? null : (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
  return {
    lead_id: m.lead_id,
    added_at: date(m.added_at),
    added_by: str(m.added_by, 80),
    removed_at: date(m.removed_at),
    removed_by: str(m.removed_by, 80),
    company_name: str(m.company_name, 200),
    contact_name: str(m.contact_name, 200),
  };
}
function pickGroup(g) {
  if (!g || typeof g !== 'object' || !UUID.test(String(g.group_id || '')) || !STATUS_SET.has(g.status)) return null;
  return {
    group_id: g.group_id,
    label: typeof g.label === 'string' && g.label.length <= 160 ? g.label : '',
    status: g.status,
    created_at: typeof g.created_at === 'string' ? g.created_at : null,
    created_by: typeof g.created_by === 'string' && g.created_by.length <= 80 ? g.created_by : null,
    retired_at: typeof g.retired_at === 'string' ? g.retired_at : null,
    members: Array.isArray(g.members) ? g.members.map(pickMember).filter(Boolean) : [],
  };
}
function pickActionResult(r) {
  if (!r || typeof r !== 'object' || r.ok !== true) {
    const code = r?.error_code && typeof r.error_code === 'string' && /^[A-Z_]{3,40}$/.test(r.error_code) ? r.error_code : 'VALIDATION_FAILED';
    return { success: false, error: { code } };
  }
  const out = { success: true };
  if (r.group_id) out.group_id = r.group_id;
  if (r.audit_id) out.audit_id = r.audit_id;
  if (r.reversed_audit_id) out.reversed_audit_id = r.reversed_audit_id;
  if (Array.isArray(r.lead_ids)) out.lead_ids = r.lead_ids.filter((x) => typeof x === 'string' && LEAD_ID.test(x));
  return out;
}

export function createDashboardCrm({ connectionString, poolFactory } = {}) {
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) throw new Error('DASHBOARD_DATABASE_URL must be a PostgreSQL URL');
  const safeUrl = new URL(connectionString);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) safeUrl.searchParams.delete(k);
  let pool;
  const ensurePool = async () => {
    if (!pool) {
      if (!poolFactory) {
        const module = await import('pg');
        const Pool = module.Pool || module.default?.Pool;
        if (!Pool) throw new Error('PostgreSQL adapter is not installed');
        poolFactory = (opts) => new Pool(opts);
      }
      pool = poolFactory({ connectionString: safeUrl.toString(), ssl: { rejectUnauthorized: true }, max: 3, connectionTimeoutMillis: 4000, idleTimeoutMillis: 15000, application_name: 'trade_fair_dashboard_crm' });
      pool.on?.('error', () => {});
    }
    return pool;
  };
  const callReadOnly = async (sql, params) => {
    const db = await ensurePool();
    const client = await db.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const { rows } = await client.query(sql, params);
      await client.query('COMMIT');
      return rows[0]?.payload ?? null;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  };
  const callReadWrite = async (sql, params) => {
    const db = await ensurePool();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const { rows } = await client.query(sql, params);
      await client.query('COMMIT');
      return rows[0]?.payload ?? null;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  };
  return {
    list: async (opts) => {
      const payload = await callReadOnly('SELECT trade_fair.crm_groups_snapshot($1::integer,$2::integer,$3::boolean) AS payload', [opts.limit, opts.offset, opts.includeRetired]);
      if (!payload || payload.success !== true || !Array.isArray(payload.groups)) throw new Error('Unexpected CRM list payload');
      return {
        success: true, read_only: false, page: opts.page, limit: opts.limit,
        total: Number.isInteger(payload.total) ? payload.total : 0,
        groups: payload.groups.map(pickGroup).filter(Boolean),
        as_of: new Date().toISOString(),
      };
    },
    merge: async (opts, by) => pickActionResult(await callReadWrite('SELECT trade_fair.crm_group_merge($1::jsonb,$2::text,$3::text,$4::text) AS payload', [JSON.stringify(opts.lead_ids), opts.label, by, opts.note])),
    split: async (opts, by) => pickActionResult(await callReadWrite('SELECT trade_fair.crm_group_split($1::uuid,$2::text,$3::text) AS payload', [opts.group_id, by, opts.note])),
    extract: async (opts, by) => pickActionResult(await callReadWrite('SELECT trade_fair.crm_group_extract($1::uuid,$2::text,$3::text,$4::text) AS payload', [opts.group_id, opts.lead_id, by, opts.note])),
    ignore: async (opts, by) => pickActionResult(await callReadWrite('SELECT trade_fair.crm_group_ignore($1::jsonb,$2::text,$3::text,$4::text) AS payload', [JSON.stringify(opts.lead_ids), opts.label, by, opts.note])),
    revert: async (opts, by) => pickActionResult(await callReadWrite('SELECT trade_fair.crm_group_revert($1::uuid,$2::text,$3::text) AS payload', [opts.audit_id, by, opts.note])),
    close: async () => { if (pool) await pool.end(); },
  };
}
