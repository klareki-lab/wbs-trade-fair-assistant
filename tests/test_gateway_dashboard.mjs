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
async function start(store={query:async()=>DB}){
 const config=loadConfig(ENV);
 const server=createGateway(config,{dashboardStore:store,fetchImpl:async()=>{throw Error('Existing workflow must not be called for dashboard.')}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=`http://127.0.0.1:${server.address().port}`;
 const close=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))};
 return {address,close};
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
