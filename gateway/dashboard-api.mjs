// WBS-TF-02: authenticated, read-only admin adapter. No n8n webhook or browser DB credentials.
export const SORTS = new Set(['created','company','score','processing','email']);
export const BANDS = new Set(['HOT','WARM','COLD','UNSCORED']);
export const PROCESSING = new Set(['pending','processing','completed','failed']);
export const EMAIL = new Set(['pending','leased','sending','delivered','uncertain','failed','none']);
const LEAD_ID = /^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys = new Set(['page','limit','search','band','processing','email','duplicate','sort','direction']);
export function parseDashboardQuery(searchParams) {
  for (const [k] of searchParams) if (!keys.has(k) || searchParams.getAll(k).length !== 1) throw new RangeError('Invalid query');
  const integer = (name, fallback, max) => {
    const raw = searchParams.get(name) ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) throw new RangeError('Invalid pagination');
    return Number(raw);
  };
  const page = integer('page',1,10000), limit = integer('limit',50,100);
  const search = (searchParams.get('search') || '').trim();
  if (search.length > 120 || /[\x00-\x1f\x7f]/.test(search)) throw new RangeError('Invalid search');
  const band=searchParams.get('band') || '', processing=searchParams.get('processing') || '', email=searchParams.get('email') || '';
  if (band && !BANDS.has(band) || processing && !PROCESSING.has(processing) || email && !EMAIL.has(email)) throw new RangeError('Invalid filter');
  const duplicate=searchParams.get('duplicate') || '';
  if (duplicate && !['yes','no'].includes(duplicate)) throw new RangeError('Invalid duplicate filter');
  const sort=searchParams.get('sort') || 'created', direction=searchParams.get('direction') || 'desc';
  if (!SORTS.has(sort) || !['asc','desc'].includes(direction)) throw new RangeError('Invalid sort');
  return { page,limit,offset:(page-1)*limit,search,band,processing,email,duplicate,sort,direction };
}
export function validateDashboardPayload(payload, expected) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      typeof payload.total !== 'number' || !Number.isSafeInteger(payload.total) || payload.total < 0 ||
      !payload.stats || typeof payload.stats !== 'object' || !Array.isArray(payload.leads) ||
      payload.leads.length > expected.limit || !payload.leads.every(l=>l && LEAD_ID.test(l.lead_id))) {
    throw new TypeError('Invalid dashboard result contract');
  }
  return {success:true, ...payload, page:expected.page, limit:expected.limit, read_only:true};
}

export function makeDashboardHandler(queryFn) {
  if (typeof queryFn !== 'function') throw new TypeError('queryFn required');
  return async function dashboardQuery(params) {
    // The queryFn MUST issue only SELECT trade_fair.dashboard_snapshot(...) in a read-only transaction.
    const result=await queryFn(params);
    return validateDashboardPayload(result,params);
  };
}
