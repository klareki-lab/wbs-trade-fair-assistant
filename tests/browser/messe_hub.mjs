import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {chromium} from '../../gateway/node_modules/playwright/index.mjs';
import pg from '../../gateway/node_modules/pg/lib/index.js';
import {createGateway,loadConfig} from '../../gateway/server.mjs';
import {createDashboardCrm} from '../../gateway/dashboard-crm.mjs';
import {createDashboardDb} from '../../gateway/dashboard-db.mjs';
import {startPg16,ids} from '../helpers/pg16.mjs';
let db,browser,server,base,config,captureMode='unknown',captured=[],askMode='valid',seenRequests=[];
const root=new URL('../../',import.meta.url);
const exported=JSON.parse(await readFile(new URL('workflows/wf-a-lead-capture.json',root),'utf8'));
const wfa=Array.isArray(exported)?exported[0]:exported;
const normalize=wfa.nodes.find(n=>n.name==='Normalize Input') || wfa.nodes.find(n=>n.parameters.jsCode?.includes('const candidateUUID'));
const validate=wfa.nodes.find(n=>n.name==='Validate Input');
const code=(node,json)=>new Function('$input',node.parameters.jsCode)({first:()=>({json})})[0].json;
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
test.before(async()=>{
 db=await startPg16();
 const connectionString=`postgresql://trade_fair_dashboard:synthetic-local-only@127.0.0.1:${db.port}/neondb`;
 // Test-only transport: real restricted PG role, loopback cleartext, no production TLS change.
 const factory=(opts)=>new pg.Pool({...opts,ssl:false});
 config=loadConfig({HOST:'127.0.0.1',PORT:'3000',APP_ORIGIN:'http://127.0.0.1:3000',TRADE_FAIR_ACCESS_KEY:'synthetic-form-key-only',DASHBOARD_ACCESS_KEY:'synthetic-admin-key-only',SESSION_SECRET:'synthetic-session-secret-32-characters',N8N_HEADER_KEY:'synthetic-header',N8N_CAPTURE_URL:'http://mock.test/capture',N8N_STATUS_URL:'http://mock.test/status',DASHBOARD_ENABLED:'true',DASHBOARD_DATABASE_URL:connectionString,N8N_AI_EXTRACT_URL:'http://mock.test/extract',N8N_AI_ASK_URL:'http://mock.test/ask'});
 const fetchImpl=async(url,init)=>{
  const payload=JSON.parse(init.body);seenRequests.push({url,payload});
  if(url.endsWith('/extract'))return response(200,{success:true,extracted:{company_name:'Synthetic Company',contact_name:'Synthetic Person',email:'synthetic@example.test',budget_status:'planned',notes:'Synthetic consented note',summary:'This must never enter WF-A'},confidence:{},uncertainty_flags:[]});
  if(url.endsWith('/ask'))return response(200,{success:true,answer:'<img src=x onerror=alert(1)>',cited_lead_ids:[askMode==='valid'?ids[0]:'FAIR-99999999-9999-4999-8999-999999999999']});
  if(url.endsWith('/capture')){
   captured.push(payload);const normalized=code(normalize,{headers:{'content-type':'application/json'},body:payload,_server_candidate_uuid:'99999999-9999-4999-8999-999999999999'});const valid=code(validate,normalized);assert.equal(valid.valid,true,'actual WF-A normalize + validation accepts browser body');
   await new Promise(r=>setTimeout(r,150));
   if(captureMode==='unknown')return response(503,{success:false});
   if(captureMode==='422')return response(422,{success:false,error:{code:'VALIDATION_FAILED',details:[{field:'email',code:'INVALID_EMAIL'}]}});
   if(captureMode==='409')return response(409,{success:false,error:{code:'IDEMPOTENCY_CONFLICT'}});
   return response(201,{success:true,persisted:true,lead_id:'FAIR-99999999-9999-4999-8999-999999999999',status:'NEW',processing_status:'pending',idempotent_replay:false,review_required:false});
  }
  throw Error('Unexpected workflow call');
 };
 server=createGateway(config,{dashboardStore:createDashboardDb({connectionString,poolFactory:factory}),crmStore:createDashboardCrm({connectionString,poolFactory:factory}),fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;config.origin=base;
 // A fresh isolated browser, never a user's profile.
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{channel:'chrome'})});
});
test.after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db?.close();});
async function login(page){await page.goto(base+'/dashboard');await page.locator('#access-key').fill(config.dashboardAccessKey);await page.getByRole('button',{name:'Anmelden',exact:true}).click();await page.waitForSelector('input.row-sel');await page.waitForFunction(()=>document.querySelector('#crmPageInfo')?.textContent.includes('Audit'));}
async function reset(){await db.pool.query('TRUNCATE trade_fair.lead_group_audit,trade_fair.lead_group_members,trade_fair.lead_groups RESTART IDENTITY CASCADE');captured=[];seenRequests=[];config.limits.internal.count=1000;config.limits.login.count=1000;config.limits.status.count=1000;}
async function prepareAi(page){await page.locator('#headAiExtract').click();await page.locator('#aiExtractInput').fill('Synthetic Company discussed consented training.');await page.locator('#aiPrivacyConsent').check();await page.locator('#aiExtractAnalyze').click();await page.waitForSelector('#aix_company_name');}
async function confirmAll(page){for(const c of await page.locator('.field-confirm').all())await c.check();}
async function waitAction(page,action){await page.waitForFunction(a=>[...document.querySelectorAll('#auditBox strong')].some(e=>e.textContent.startsWith(a)),action);}
test('browser + real PG16: merge/extract/split/ignore, persistent audit and one-click undo after refresh/new login, XSS',async()=>{
 await reset();const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await login(page);await page.locator('input.row-sel').nth(0).check();await page.locator('input.row-sel').nth(1).check();
  page.once('dialog',d=>d.accept('Synthetic <img src=x onerror=alert(1)>'));await page.locator('#mergeBtn').click();await waitAction(page,'merge');
  assert.equal(await page.locator('#groupsBox img').count(),0);assert.match(await page.locator('#groupsBox').innerText(),/<img/);
  await page.reload();await page.waitForSelector('#auditBox button[data-audit]');
  await page.locator('#logoutBtn').click();await page.waitForURL(base+'/');await login(page);await page.locator('#auditBox button[data-audit]').first().click();await waitAction(page,'revert');assert.equal(await page.locator('#groupsBox .group-card').count(),0);
  // New active group; extract first lead and undo via persisted audit ID, not a prompt.
  await page.locator('input.row-sel').nth(0).check();await page.locator('input.row-sel').nth(1).check();page.once('dialog',d=>d.accept('Next synthetic group'));await page.locator('#mergeBtn').click();await page.waitForSelector('#groupsBox button[data-action="extract"]');
  await page.locator('#groupsBox button[data-action="extract"]').first().click();await waitAction(page,'extract');
  await page.locator('#auditBox .group-card').first().getByRole('button',{name:'Rückgängig',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#groupsBox .group-card').length===1);
  await page.locator('#groupsBox button[data-action="split"]').click();await waitAction(page,'split');await page.locator('#auditBox .group-card').first().getByRole('button',{name:'Rückgängig',exact:true}).click();await page.waitForSelector('#groupsBox button[data-action="split"]');
  await page.locator('input.row-sel').nth(2).check();page.once('dialog',d=>d.accept('Synthetic ignore reason'));await page.locator('#ignoreBtn').click();await waitAction(page,'ignore');
  await page.locator('#auditBox .group-card').first().getByRole('button',{name:'Rückgängig',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#auditBox .group-card strong')?.textContent.startsWith('revert'));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
test('browser: AI explicit consent/field confirmation, exact WF-A contract, locked ambiguous retry after refresh uses same submission_id',async()=>{
 await reset();captureMode='unknown';const context=await browser.newContext();const page=await context.newPage();
 try{
  await login(page);await page.locator('#headAiExtract').click();await page.locator('#aiExtractInput').fill('Synthetic Company discussed training.');await page.locator('#aiExtractAnalyze').click();assert.equal(seenRequests.filter(r=>r.url.endsWith('/extract')).length,0);
  await page.locator('#aiPrivacyConsent').check();await page.locator('#aiExtractAnalyze').click();await page.waitForSelector('#aix_company_name');
  await page.locator('#aiExtractSubmit').click();assert.equal(captured.length,0);await confirmAll(page);
  await page.locator('#aiExtractSubmit').dblclick();await page.waitForFunction(()=>document.querySelector('#aiExtractError').textContent.includes('Ergebnis unklar'));
  assert.equal(captured.length,1);assert.equal(captured[0].source,'internal_form');assert(!('summary' in captured[0]));assert.equal(await page.locator('#aix_company_name').isDisabled(),true);
  const first=structuredClone(captured[0]);const storage=await page.evaluate(()=>({...sessionStorage}));assert.deepEqual(Object.keys(storage),['messe:pending-submission-id']);assert.equal(storage['messe:pending-submission-id'],first.submission_id);
  page.once('dialog',d=>d.accept());await page.reload();await page.waitForSelector('input.row-sel');await prepareAi(page);await confirmAll(page);captureMode='success';await page.locator('#aiExtractSubmit').click();await page.waitForFunction(()=>document.querySelector('#aiExtractModal').hidden);
  assert.equal(captured.length,2);assert.deepEqual(captured[1],first);assert.equal(await page.evaluate(()=>sessionStorage.length),0);
 }finally{await context.close();}
});
test('browser: 422 unlocks edits; 409 retains ID/body; assistant rejects out-of-context citation and renders strings safely',async()=>{
 await reset();captureMode='422';const context=await browser.newContext();const page=await context.newPage();
 try{
  await login(page);await prepareAi(page);await confirmAll(page);await page.locator('#aiExtractSubmit').click();await page.waitForFunction(()=>document.querySelector('#aiExtractError').textContent.includes('Nicht gespeichert'));
  assert.equal(await page.locator('#aix_email').isDisabled(),false);const submission=captured[0].submission_id;
  await page.locator('#aix_email').fill('other@example.test');await confirmAll(page);captureMode='409';await page.locator('#aiExtractSubmit').click();await page.waitForFunction(()=>document.querySelector('#aiExtractError').textContent.includes('Übertragungskonflikt'));assert.equal(captured[1].submission_id,submission);assert.equal(await page.locator('#aix_email').isDisabled(),true);
  await page.locator('#aiExtractClose').click();askMode='forged';await page.locator('#headAiAsk').click();await page.locator('#aiAskInput').fill('Status?');await page.locator('#aiAskSend').click();await page.waitForSelector('#aiAskError:not([hidden])');assert.equal(await page.locator('#aiAskThread .assistant').count(),0);
  askMode='valid';await page.locator('#aiAskInput').fill('Status?');await page.locator('#aiAskSend').click();await page.waitForSelector('#aiAskThread .assistant');assert.equal(await page.locator('#aiAskThread img').count(),0);assert.match(await page.locator('#aiAskThread .assistant').innerText(),/<img/);
 }finally{await context.close();}
});
