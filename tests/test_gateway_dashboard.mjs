import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createGateway,loadConfig} from '../gateway/server.mjs';
const ENV={
 HOST:'127.0.0.1',PORT:'3000',APP_ORIGIN:'http://app.test',
 TRADE_FAIR_ACCESS_KEY:'fake-access-key-for-dashboard-tests',
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
async function signIn(address){
 const r=await fetch(address+'/api/login',{method:'POST',headers:{Origin:'http://app.test','Content-Type':'application/json'},body:JSON.stringify({access_key:ENV.TRADE_FAIR_ACCESS_KEY})});
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
 assert.throws(()=>loadConfig({...ENV,DASHBOARD_ENABLED:'yes'}),/DASHBOARD_ENABLED/);
});
