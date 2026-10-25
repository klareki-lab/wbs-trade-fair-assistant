import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway,loadConfig} from '../gateway/server.mjs';
const ENV={
 HOST:'127.0.0.1',PORT:'3000',APP_ORIGIN:'http://app.test',
 TRADE_FAIR_ACCESS_KEY:'fake-access-key-for-dashboard-tests',
 DASHBOARD_ACCESS_KEY:'separate-admin-key-for-dashboard-tests',
 SESSION_SECRET:'fake-session-secret-for-dashboard-tests-32-chars',
 N8N_HEADER_KEY:'fake-n8n-key',N8N_CAPTURE_URL:'http://upstream.test/capture',
 N8N_STATUS_URL:'http://upstream.test/status',
 PUBLIC_FORM_ENABLED:'false',DASHBOARD_ENABLED:'true',
 DASHBOARD_DATABASE_URL:'postgresql://fake:fake@localhost/neondb'
};
const LEAD='FAIR-797b1f1c-a657-4c7d-829f-1df50f5fc8b2';
const DB={total:1,as_of:'2026-10-24T09:00:00Z',stats:{total:1,hot:0,warm:1,cold:0,unscored:0,duplicates:0,failed:0,email_attention:0,scored_average:45,today:0},leads:[{lead_id:LEAD,company:'Fake GmbH',score_band:'WARM',score_total:45,email_status:'delivered',processing_status:'completed',duplicate_status:'NEW'}]};
async function start(store={query:async()=>DB},opts={}){
 const config=loadConfig(opts.env||ENV);
 const server=createGateway(config,{
   dashboardStore:store,
   crmStore:opts.crmStore||{list:async()=>({success:true,page:1,limit:25,total:0,groups:[],as_of:'2026-10-25T00:00:00Z'}),merge:async()=>({success:true,group_id:'00000000-0000-4000-8000-000000000001',audit_id:'00000000-0000-4000-8000-000000000002'}),split:async()=>({success:true,group_id:'00000000-0000-4000-8000-000000000001',audit_id:'00000000-0000-4000-8000-000000000003'}),extract:async()=>({success:true,group_id:'00000000-0000-4000-8000-000000000004',audit_id:'00000000-0000-4000-8000-000000000005'}),ignore:async()=>({success:true,group_id:'00000000-0000-4000-8000-000000000006',audit_id:'00000000-0000-4000-8000-000000000007'}),revert:async()=>({success:true,audit_id:'00000000-0000-4000-8000-000000000008',reversed_audit_id:'00000000-0000-4000-8000-000000000002'}),close:async()=>{}},
   fetchImpl:opts.fetchImpl||(async()=>{throw Error('Existing workflow must not be called for dashboard.')}),
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=`http://127.0.0.1:${server.address().port}`;
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))};
 return {address,close,config};
}
async function signIn(address,key=ENV.DASHBOARD_ACCESS_KEY){
 const r=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({access_key:key})});
 assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];
}
test('public route disabled by default with no effect on existing form',async()=>{
 const config=loadConfig({...ENV,DASHBOARD_ENABLED:'false',DASHBOARD_DATABASE_URL:''});
 const server=createGateway(config);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+'/dashboard')).status,404);assert.equal((await fetch(base+'/api/dashboard')).status,404);assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/app.js')).status,200)}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});
test('unauthenticated dashboard read and assets rejected, original form unchanged',async()=>{
 const {address,close}=await start();try{
  for(const url of ['/api/dashboard','/dashboard','/dashboard.js','/dashboard.css'])assert.equal((await fetch(address+url)).status,401,url);
  assert.equal((await fetch(address+'/')).status,200);
  assert.equal((await fetch(address+'/app.js')).status,200);
 }finally{await close()}
});
test('form access key cannot read dashboard data or assets',async()=>{
 const {address,close}=await start();try{
  const cookie=await signIn(address,ENV.TRADE_FAIR_ACCESS_KEY);
  for(const url of ['/api/dashboard','/dashboard','/dashboard.js','/dashboard.css'])
   assert.equal((await fetch(address+url,{headers:{Cookie:cookie}})).status,401,url);
  const session=await (await fetch(address+'/api/session',{headers:{Cookie:cookie}})).json();
  assert.equal(session.authenticated,true);assert.equal(session.dashboard_authenticated,false);
 }finally{await close()}
});
test('authenticated dashboard returns WARM 45, delivered, strict same-origin assets',async()=>{
 let received;const {address,close}=await start({query:async x=>{received=x;return{success:true,read_only:true,...DB}}});try{
  const cookie=await signIn(address);
  const res=await fetch(address+'/api/dashboard?band=WARM&search=Fake&page=1&limit=50',{headers:{Cookie:cookie}});
  assert.equal(res.status,200);const data=await res.json();assert.equal(data.leads[0].score_total,45);assert.equal(data.leads[0].score_band,'WARM');assert.equal(data.leads[0].email_status,'delivered');assert.equal(data.read_only,true);assert.equal(received.band,'WARM');
  for(const url of ['/dashboard','/dashboard.js','/dashboard.css']){const r=await fetch(address+url,{headers:{Cookie:cookie}});assert.equal(r.status,200,url);assert.match(r.headers.get('content-type'),/text\/html|text\/javascript|text\/css/)}
  const invalid=await fetch(address+'/api/dashboard?sort=drop',{headers:{Cookie:cookie}});assert.equal(invalid.status,400);
  const write=await fetch(address+'/api/dashboard',{method:'POST',headers:{Cookie:cookie,Origin:'http://app.test'}});assert.equal(write.status,405);
 }finally{await close()}
});
test('backend errors return retryable 503, not empty statistics or 200',async()=>{
 const {address,close}=await start({query:async()=>{throw Error('do not leak secret') }});try{
 const cookie=await signIn(address);const r=await fetch(address+'/api/dashboard',{headers:{Cookie:cookie}});
 assert.equal(r.status,503);const body=await r.text();assert(!body.includes('do not leak secret'));assert.match(body,/STATUS_UNAVAILABLE/);assert(!body.includes('"total":0'));
 }finally{await close()}
});
test('dashboard config fails closed',()=>{
 assert.throws(()=>loadConfig({...ENV,DASHBOARD_DATABASE_URL:''}),/DASHBOARD_DATABASE_URL/);
 assert.throws(()=>loadConfig({...ENV,DASHBOARD_ACCESS_KEY:''}),/DASHBOARD_ACCESS_KEY/);
 assert.throws(()=>loadConfig({...ENV,DASHBOARD_ACCESS_KEY:ENV.TRADE_FAIR_ACCESS_KEY}),/DASHBOARD_ACCESS_KEY/);
 assert.throws(()=>loadConfig({...ENV,DASHBOARD_ENABLED:'yes'}),/DASHBOARD_ENABLED/);
});

test('anonymous browser GET /dashboard returns German login page, API clients still 401',async()=>{
 const {address,close}=await start();try{
  const browser=await fetch(address+'/dashboard',{headers:{Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}});
  assert.equal(browser.status,200);
  assert.match(browser.headers.get('content-type')||'',/text\/html/);
  const csp=browser.headers.get('content-security-policy')||'';
  assert.match(csp,/script-src 'self'/);
  assert(!csp.includes("'unsafe-inline'"),'login page must not weaken CSP');
  const html=await browser.text();
  assert.match(html,/Admin-Zugangsschlüssel/);
  assert.match(html,/<form id="dashboard-login-form"/);
  assert.match(html,/<script src="\/dashboard-login\.js"/);
  assert(!html.includes(ENV.DASHBOARD_ACCESS_KEY),'login page must not leak the key');
  assert(!html.includes(ENV.TRADE_FAIR_ACCESS_KEY),'login page must not leak the form key');
  const api=await fetch(address+'/dashboard',{headers:{Accept:'application/json'}});
  assert.equal(api.status,401);
  assert.match(api.headers.get('content-type')||'',/application\/json/);
  const body=await api.json();assert.equal(body.error.code,'AUTH_REQUIRED');
  const defaultAccept=await fetch(address+'/dashboard');assert.equal(defaultAccept.status,401);
 }finally{await close()}
});

test('/dashboard-login.js served publicly without leaking keys; dashboard assets stay protected',async()=>{
 const {address,close}=await start();try{
  const js=await fetch(address+'/dashboard-login.js');
  assert.equal(js.status,200);
  assert.match(js.headers.get('content-type')||'',/text\/javascript/);
  const code=await js.text();
  assert.match(code,/\/api\/login/);
  assert(!code.includes(ENV.DASHBOARD_ACCESS_KEY));
  assert(!code.includes(ENV.TRADE_FAIR_ACCESS_KEY));
  assert(!code.includes(ENV.SESSION_SECRET));
  for(const [url,accept] of [['/dashboard.js','*/*'],['/dashboard.css','*/*'],['/dashboard.js','text/html'],['/dashboard.css','text/html']]){
   const r=await fetch(address+url,{headers:{Accept:accept}});
   assert.equal(r.status,401,`${url} with Accept=${accept}`);
  }
  const post=await fetch(address+'/dashboard-login.js',{method:'POST',headers:{Origin:'http://app.test','Content-Type':'application/json'},body:'{}'});
  assert.equal(post.status,405);
 }finally{await close()}
});

test('form-user browser sees login page on /dashboard, cannot read Dashboard data',async()=>{
 const {address,close}=await start();try{
  const cookie=await signIn(address,ENV.TRADE_FAIR_ACCESS_KEY);
  const browser=await fetch(address+'/dashboard',{headers:{Cookie:cookie,Accept:'text/html,application/xhtml+xml'}});
  assert.equal(browser.status,200);
  const html=await browser.text();
  assert.match(html,/dashboard-login-form/);
  assert.doesNotMatch(html,/Messe Hub · Admin · Train Today/);
  for(const url of ['/api/dashboard','/dashboard.js','/dashboard.css']){
   const r=await fetch(address+url,{headers:{Cookie:cookie}});assert.equal(r.status,401,url);
  }
 }finally{await close()}
});

test('dashboard-key login grants Admin UI; logout returns to login page',async()=>{
 const {address,close}=await start();try{
  const login=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({access_key:ENV.DASHBOARD_ACCESS_KEY})});
  assert.equal(login.status,200);
  const setCookie=login.headers.get('set-cookie');
  assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  const cookie=setCookie.split(';')[0];
  const session=await (await fetch(address+'/api/session',{headers:{Cookie:cookie}})).json();
  assert.equal(session.authenticated,true);assert.equal(session.dashboard_authenticated,true);
  const ui=await fetch(address+'/dashboard',{headers:{Cookie:cookie,Accept:'text/html'}});
  assert.equal(ui.status,200);
  const html=await ui.text();
  assert.match(html,/Messe Hub · Admin · Train Today/);
  assert.doesNotMatch(html,/dashboard-login-form/);
  const logout=await fetch(address+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:'http://app.test'}});
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie')||'',/Max-Age=0/);
  const afterLogout=await fetch(address+'/dashboard',{headers:{Accept:'text/html'}});
  assert.equal(afterLogout.status,200);
  assert.match(await afterLogout.text(),/dashboard-login-form/);
 }finally{await close()}
});

test('wrong access key is rejected at /api/login with no cookie, login screen remains',async()=>{
 const {address,close}=await start();try{
  const r=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({access_key:'not-the-right-key-whatsoever'})});
  assert.equal(r.status,401);
  assert.equal(r.headers.get('set-cookie'),null);
  const body=await r.json();assert.equal(body.error.code,'INVALID_ACCESS_KEY');
  const after=await fetch(address+'/dashboard',{headers:{Accept:'text/html'}});
  assert.equal(after.status,200);
 }finally{await close()}
});

test('cross-origin login attempt rejected without cookie (CSRF)',async()=>{
 const {address,close}=await start();try{
  const r=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://evil.example','Content-Type':'application/json'},body:JSON.stringify({access_key:ENV.DASHBOARD_ACCESS_KEY})});
  assert.notEqual(r.status,200);
  assert.equal(r.headers.get('set-cookie'),null);
 }finally{await close()}
});

test('TF-12: dashboard HTML wires sidebar tabs and reset-filters button',async()=>{
 const {address,close}=await start();try{
  const cookie=await signIn(address);
  const r=await fetch(address+'/dashboard',{headers:{Cookie:cookie,Accept:'text/html'}});
  assert.equal(r.status,200);
  const html=await r.text();
  // Sidebar tabs use the canonical values the handler recognises.
  assert.match(html,/data-tab="all"/);
  assert.match(html,/data-tab="dups"/);
  assert.doesNotMatch(html,/data-tab="alle"/);
  assert.doesNotMatch(html,/data-tab="duplikate"/);
  // Reset-filters affordance exists.
  assert.match(html,/id="resetFiltersBtn"/);
  assert.match(html,/Filter zurücksetzen/);
  // Duplikate sidebar still exists and shows the dynamic badge span.
  assert.match(html,/id="navDup"/);
 }finally{await close()}
});

// ======== WBS Messe-Hub FULL (issue #19) — CRM + AI tests ========

const LEAD_A='FAIR-00000000-0000-4000-8000-000000000011';
const LEAD_B='FAIR-00000000-0000-4000-8000-000000000012';
const GROUP_ID='00000000-0000-4000-8000-000000000001';
const AUDIT_ID='00000000-0000-4000-8000-000000000002';

function jsonResponse(status,body,headers={}){
 const buf=Buffer.from(JSON.stringify(body),'utf8');
 return new Response(buf,{status,headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':String(buf.length),...headers}});
}

test('TF-19: /api/dashboard/groups rejects anonymous, form-user and cross-origin writes',async()=>{
 const {address,close}=await start();try{
  // Anonymous
  assert.equal((await fetch(address+'/api/dashboard/groups')).status,401);
  // Form-user cookie
  const formCookie=await signIn(address,ENV.TRADE_FAIR_ACCESS_KEY);
  assert.equal((await fetch(address+'/api/dashboard/groups',{headers:{Cookie:formCookie}})).status,401);
  // Dashboard GET
  const dash=await signIn(address);
  const list=await fetch(address+'/api/dashboard/groups',{headers:{Cookie:dash}});
  assert.equal(list.status,200);
  const lb=await list.json();assert.equal(lb.success,true);assert.ok(Array.isArray(lb.groups));
  // CSRF: cross-origin POST merge
  const bad=await fetch(address+'/api/dashboard/groups',{method:'POST',headers:{Cookie:dash,Origin:'http://evil.example','Content-Type':'application/json'},body:JSON.stringify({lead_ids:[LEAD_A,LEAD_B],label:'x'})});
  assert.equal(bad.status,403);
 }finally{await close()}
});

test('TF-19: /api/dashboard/groups POST merge happy path returns success',async()=>{
 let seen=null;
 const {address,close}=await start(undefined,{crmStore:{list:async()=>({success:true,page:1,limit:25,total:0,groups:[]}),merge:async(o,by)=>{seen={o,by};return{success:true,group_id:GROUP_ID,audit_id:AUDIT_ID}},split:async()=>({success:true}),extract:async()=>({success:true}),ignore:async()=>({success:true}),revert:async()=>({success:true}),close:async()=>{}}});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/groups',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({lead_ids:[LEAD_A,LEAD_B],label:'Zusammenführung ' + new Date().toISOString().slice(0,10)})});
  assert.equal(r.status,200);
  const b=await r.json();assert.equal(b.success,true);assert.equal(b.group_id,GROUP_ID);assert.equal(b.audit_id,AUDIT_ID);
  assert.deepEqual(seen.o.lead_ids,[LEAD_A,LEAD_B]);
  assert.match(seen.by,/^dashboard-admin:/,'audit actor must come from session, not request');
 }finally{await close()}
});

test('TF-19: merge validates lead_ids and label; invalid payloads return 400/422',async()=>{
 const {address,close}=await start();try{
  const dash=await signIn(address);
  const base={headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},method:'POST'};
  // Not JSON
  assert.equal((await fetch(address+'/api/dashboard/groups',{...base,headers:{...base.headers,'Content-Type':'text/plain'},body:'nope'})).status,415);
  // Too few leads
  const r1=await fetch(address+'/api/dashboard/groups',{...base,body:JSON.stringify({lead_ids:[LEAD_A],label:'x'})});
  assert.equal(r1.status,400);
  // Non-FAIR id (SQL injection shape)
  const r2=await fetch(address+'/api/dashboard/groups',{...base,body:JSON.stringify({lead_ids:[LEAD_A,"' OR '1'='1"],label:'x'})});
  assert.equal(r2.status,400);
  // Oversize label
  const r3=await fetch(address+'/api/dashboard/groups',{...base,body:JSON.stringify({lead_ids:[LEAD_A,LEAD_B],label:'x'.repeat(200)})});
  assert.equal(r3.status,400);
  // Empty label
  const r4=await fetch(address+'/api/dashboard/groups',{...base,body:JSON.stringify({lead_ids:[LEAD_A,LEAD_B],label:'   '})});
  assert.equal(r4.status,400);
 }finally{await close()}
});

test('TF-19: ignore/split/extract/revert routes reject unauthenticated and non-POST',async()=>{
 const {address,close}=await start();try{
  for(const url of ['/api/dashboard/groups/ignore','/api/dashboard/groups/split','/api/dashboard/groups/extract','/api/dashboard/groups/revert']){
   assert.equal((await fetch(address+url,{method:'POST'})).status,403,'cross-origin → 403 '+url);
   assert.equal((await fetch(address+url,{method:'GET'})).status,405,url);
  }
  const dash=await signIn(address);
  for(const [url,payload] of [
    ['/api/dashboard/groups/ignore',{lead_ids:[LEAD_A],label:'Ignoriert'}],
    ['/api/dashboard/groups/split',{group_id:GROUP_ID}],
    ['/api/dashboard/groups/extract',{group_id:GROUP_ID,lead_id:LEAD_A}],
    ['/api/dashboard/groups/revert',{audit_id:AUDIT_ID}],
  ]){
   const r=await fetch(address+url,{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify(payload)});
   assert.equal(r.status,200,url);
   const b=await r.json();assert.equal(b.success,true,url);
  }
 }finally{await close()}
});

test('TF-19: revert reversibility — revert of a merge triggers reverted_audit_id in response',async()=>{
 let seen=null;
 const {address,close}=await start(undefined,{crmStore:{list:async()=>({success:true,page:1,limit:25,total:0,groups:[]}),merge:async()=>({success:true,group_id:GROUP_ID,audit_id:AUDIT_ID}),split:async()=>({success:true}),extract:async()=>({success:true}),ignore:async()=>({success:true}),revert:async(o,by)=>{seen={o,by};return{success:true,audit_id:'00000000-0000-4000-8000-000000000099',reversed_audit_id:o.audit_id}},close:async()=>{}}});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/groups/revert',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({audit_id:AUDIT_ID,note:'owner override'})});
  assert.equal(r.status,200);
  const b=await r.json();assert.equal(b.success,true);assert.equal(b.reversed_audit_id,AUDIT_ID);
  assert.equal(seen.o.audit_id,AUDIT_ID);assert.equal(seen.o.note,'owner override');
 }finally{await close()}
});

test('TF-19: AI endpoints return 503 fail-closed when N8N_AI_* unset',async()=>{
 const {address,close}=await start();try{
  const dash=await signIn(address);
  for(const url of ['/api/dashboard/ai/extract','/api/dashboard/ai/ask']){
   const r=await fetch(address+url,{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({notes:'x'.repeat(50),question:'test?',context_lead_ids:[]})});
   assert.equal(r.status,503,url);
  }
 }finally{await close()}
});

test('TF-19: AI extract proxies to upstream and allowlists response, strips extra fields',async()=>{
 let seen=null;
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 const upstream=async(url,init)=>{
   seen={url:String(url),init};
   return jsonResponse(200,{success:true,extracted:{company_name:'Acme GmbH',contact_name:'Alice',email:'alice@acme.de',phone:'+49 1',website:'https://acme.de',training_interest:'ai_automation',budget_status:'planned',follow_up:'within_one_week',follow_up_date:'',notes:'full notes',summary:'short summary',SECRET_FIELD:'drop me'},confidence:{company_name:0.9,evil_key:1.0},uncertainty_flags:['low_confidence_email','ignore-me!'],assistant_message:'ok'});
 };
 const {address,close}=await start(undefined,{env,fetchImpl:upstream});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/ai/extract',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({notes:'Treff Alice bei Acme über Automatisierung',session_id:'sess-abc'})});
  assert.equal(r.status,200);
  const b=await r.json();assert.equal(b.success,true);
  assert.equal(b.extracted.company_name,'Acme GmbH');
  assert.equal(b.extracted.summary,'short summary');
  assert.ok(!('SECRET_FIELD' in b.extracted),'extra fields must be dropped');
  assert.ok(!('evil_key' in b.confidence),'confidence keys outside allowlist dropped');
  assert.deepEqual(b.uncertainty_flags,['low_confidence_email'],'uncertainty flags must match /^[a-z_]{1,64}$/');
  // Upstream must have received the gateway header, not any session cookie
  assert.equal(seen.init.headers['X-Trade-Fair-Key'],env.N8N_HEADER_KEY);
  assert.ok(!('Cookie' in (seen.init.headers||{})));
  assert.ok(!('cookie' in (seen.init.headers||{})));
  const upstreamBody=JSON.parse(seen.init.body);
  assert.equal(upstreamBody.notes,'Treff Alice bei Acme über Automatisierung');
 }finally{await close()}
});

test('TF-19: AI extract rejects short notes and control characters',async()=>{
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 let hit=0;const upstream=async()=>{hit++;return jsonResponse(200,{success:true,extracted:{}});};
 const {address,close}=await start(undefined,{env,fetchImpl:upstream});try{
  const dash=await signIn(address);
  const bad1=await fetch(address+'/api/dashboard/ai/extract',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({notes:'short'})});
  assert.equal(bad1.status,422);
  const bad2=await fetch(address+'/api/dashboard/ai/extract',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({notes:'ten chars'+String.fromCharCode(1)+'more'})});
  assert.equal(bad2.status,422);
  assert.equal(hit,0,'upstream never called for rejected input');
 }finally{await close()}
});

test('TF-19: AI ask grounds answer and only cites valid FAIR ids; invalid upstream data → 503',async()=>{
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 // Good upstream
 const good=async()=>jsonResponse(200,{success:true,answer:'Antwort ohne Erfindung.',cited_lead_ids:[LEAD_A,'invalid-id-ignore',LEAD_B],tokens:{total_input:100,total_output:50},private_field:'drop'});
 const {address,close}=await start(undefined,{env,fetchImpl:good});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/ai/ask',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({question:'Welche Firmen haben Budget?',context_lead_ids:[LEAD_A,LEAD_B]})});
  assert.equal(r.status,200);
  const b=await r.json();assert.equal(b.success,true);assert.equal(b.answer,'Antwort ohne Erfindung.');
  assert.deepEqual(b.cited_lead_ids.sort(),[LEAD_A,LEAD_B].sort());
  assert.ok(!('private_field' in b));
  assert.equal(b.tokens.total_input,100);assert.equal(b.tokens.total_output,50);
 }finally{await close()}
 // Bad upstream (missing answer)
 const bad=async()=>jsonResponse(200,{success:true,cited_lead_ids:[LEAD_A]});
 const g=await start(undefined,{env,fetchImpl:bad});try{
  const dash=await signIn(g.address);
  const r=await fetch(g.address+'/api/dashboard/ai/ask',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({question:'test?'})});
  assert.equal(r.status,503);
 }finally{await g.close()}
});

test('TF-19: AI upstream fail-closed on 500 and does not leak internal URL',async()=>{
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 const upstream=async()=>jsonResponse(500,{error:'leak',url:'http://upstream.test/ai-extract',sql:'SELECT * FROM users'});
 const {address,close}=await start(undefined,{env,fetchImpl:upstream});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/ai/extract',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({notes:'z'.repeat(50)})});
  assert.equal(r.status,503);
  const text=await r.text();
  assert.ok(!text.includes('upstream.test'),'internal URL leak');
  assert.ok(!text.includes('SELECT'),'SQL leak');
  assert.ok(!text.includes(env.N8N_HEADER_KEY),'secret leak');
 }finally{await close()}
});

test('TF-19: XSS strings from upstream never execute; served as JSON text only',async()=>{
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 const xss='<script>alert(1)</script>';
 const upstream=async(url)=>{
  if(String(url).endsWith('ai-ask')) return jsonResponse(200,{success:true,answer:xss+' sicher',cited_lead_ids:[]});
  return jsonResponse(200,{success:true,extracted:{company_name:xss,summary:xss}});
 };
 const {address,close}=await start(undefined,{env,fetchImpl:upstream});try{
  const dash=await signIn(address);
  const r=await fetch(address+'/api/dashboard/ai/ask',{method:'POST',headers:{Cookie:dash,Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({question:'test?'})});
  assert.equal(r.status,200);
  const txt=await r.text();
  assert.match(r.headers.get('content-type')||'',/application\/json/);
  assert.ok(!/<\/html>/.test(txt));
  const b=JSON.parse(txt);
  // String preserved verbatim; renderer must use textContent (verified in /dashboard.js test below).
  assert.equal(b.answer,xss+' sicher');
 }finally{await close()}
});

test('TF-19: /api/session advertises crm_enabled and ai_enabled flags',async()=>{
 // AI disabled
 const {address,close}=await start();try{
  const b=await (await fetch(address+'/api/session')).json();
  assert.equal(b.success,true);assert.equal(b.crm_enabled,true);assert.equal(b.ai_enabled,false);
 }finally{await close()}
 // AI enabled
 const env={...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/ai-extract',N8N_AI_ASK_URL:'http://upstream.test/ai-ask'};
 const g=await start(undefined,{env,fetchImpl:async()=>jsonResponse(500,{})});try{
  const b=await (await fetch(g.address+'/api/session')).json();
  assert.equal(b.ai_enabled,true);
 }finally{await g.close()}
});

test('TF-19: config refuses partial AI env (fail-closed)',()=>{
 assert.throws(()=>loadConfig({...ENV,N8N_AI_EXTRACT_URL:'http://upstream.test/x'}),/N8N_AI_ASK_URL/);
 assert.throws(()=>loadConfig({...ENV,N8N_AI_ASK_URL:'http://upstream.test/x'}),/N8N_AI_EXTRACT_URL/);
});

test('TF-19: dashboard.js exposes CRM + AI wiring strings and no innerHTML on untrusted data',async()=>{
 const {address,close}=await start();try{
  const dash=await signIn(address);
  const r=await fetch(address+'/dashboard.js',{headers:{Cookie:dash}});
  assert.equal(r.status,200);
  const code=await r.text();
  for(const needle of ['/api/dashboard/groups','/api/dashboard/ai/extract','/api/dashboard/ai/ask','mergeSelected','ignoreSelected','doGroupAction','aiAnalyze','aiAsk','sessionId','context_lead_ids']){
   assert.ok(code.includes(needle),'missing wiring: '+needle);
  }
  // No innerHTML assignment anywhere (CRM UI must render via createTextNode / appendChild only).
  assert.ok(!/\.innerHTML\s*=/.test(code),'dashboard.js must not assign to innerHTML');
  // No secrets in the file.
  for(const forbidden of [ENV.DASHBOARD_ACCESS_KEY,ENV.TRADE_FAIR_ACCESS_KEY,ENV.SESSION_SECRET,ENV.N8N_HEADER_KEY]){
   assert.ok(!code.includes(forbidden),'secret leak: '+forbidden);
  }
 }finally{await close()}
});

test('TF-19: dashboard HTML exposes CRM + AI controls and no inline Yuriy artifacts',async()=>{
 const {address,close}=await start();try{
  const dash=await signIn(address);
  const r=await fetch(address+'/dashboard',{headers:{Cookie:dash,Accept:'text/html'}});
  assert.equal(r.status,200);
  const html=await r.text();
  for(const needle of ['id="gruppen"','id="actionbar"','id="mergeBtn"','id="ignoreBtn"','id="aiExtractModal"','id="aiAskModal"','id="aiExtractAnalyze"','id="aiAskSend"','CRM-Gruppen','Lead erfassen (AI)','Lead-Assistent']){
   assert.ok(html.includes(needle),'missing HTML affordance: '+needle);
  }
  // No forbidden Yuriy content
  for(const forbidden of ['CONFIG.benutzer','CONFIG.passwort','n8n.poljanzew.app','Authorization: Basic']){
   assert.ok(!html.includes(forbidden),'forbidden artifact: '+forbidden);
  }
 }finally{await close()}
});

test('TF-12: dashboard.js wires row click, sidebar tab, reset filters, keyboard access',async()=>{
 const {address,close}=await start();try{
  const cookie=await signIn(address);
  const r=await fetch(address+'/dashboard.js',{headers:{Cookie:cookie}});
  assert.equal(r.status,200);
  const code=await r.text();
  // selectTab + resetFilters helpers exist.
  assert.match(code,/function selectTab/);
  assert.match(code,/function resetFilters/);
  // Sidebar nav buttons with data-tab are wired.
  assert.match(code,/\.side \.nav\[data-tab\]/);
  // Reset-filters click handler.
  assert.match(code,/resetFiltersBtn/);
  // Row click + keyboard handlers (role=button, Enter/Space on tr[data-id]).
  assert.match(code,/tr\[data-id\]/);
  assert.match(code,/role="button"/);
  assert.match(code,/aria-label="Details/);
  assert.match(code,/keydown/);
  // Existing explicit Details button still handled.
  assert.match(code,/button\[data-id\]/);
  // Logout flow and 401-redirect fallback preserved.
  assert.match(code,/\/api\/logout/);
  assert.match(code,/window\.location\.assign\('\/'\)/);
 }finally{await close()}
});
