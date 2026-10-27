import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {apiSession,base} from './api.mjs';
import {executionData} from './execution.mjs';
const here=new URL('./',import.meta.url);
const state=JSON.parse(await readFile(new URL('.runtime/state.json',here),'utf8'));
const notes=JSON.parse(await readFile(new URL('notes.json',here),'utf8'));
const evidence=[];const api=await apiSession();
const askOnly=process.argv.includes('--ask-only');
if(askOnly){const prior=JSON.parse(await readFile(new URL('evidence/real-webhooks.json',here),'utf8'));evidence.push(...prior.results.slice(0,3));}
async function call(kind,body,auth=true){
 const started=Date.now();const r=await fetch(base+'/webhook/messe-hub/'+kind,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Trade-Fair-Key':state.header}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(40000)});
 const text=await r.text();let json;try{json=JSON.parse(text);}catch{json={nonJson:true};}
 return {http:r.status,contentType:r.headers.get('content-type'),durationMs:Date.now()-started,body:json};
}
for(const f of askOnly?[]:notes){
 const x=await call('ai-extract',{notes:f.notes});const e={case:f.id,...x};evidence.push(e);console.log(JSON.stringify({case:e.case,http:e.http,durationMs:e.durationMs,extracted:e.body.extracted?{training_interest:e.body.extracted.training_interest,budget_status:e.body.extracted.budget_status,follow_up:e.body.extracted.follow_up}:undefined,answer:e.body.answer}));
}
for(const question of ['Welchen Score hat der Lead?','Welches Budget hat der Lead?','Welche Trainingsinteressen hat der Lead?']){
 const x=await call('ai-ask',{question,context_lead_ids:['FAIR-00000000-0000-4000-8000-000000000001']});const e={case:question,...x};evidence.push(e);console.log(JSON.stringify({case:e.case,http:e.http,durationMs:e.durationMs,extracted:e.body.extracted?{training_interest:e.body.extracted.training_interest,budget_status:e.body.extracted.budget_status,follow_up:e.body.extracted.follow_up}:undefined,answer:e.body.answer}));
}
for(const kind of ['ai-extract','ai-ask']){
 const x=await call(kind,{},false);evidence.push({case:kind+' no auth',...x});console.log(kind,'no auth',x.http);
}
const versions=[];for(const id of state.workflowIds){const d=await api('workflows/'+id);versions.push({id:d.id,active:d.active,versionId:d.versionId,activeVersionId:d.activeVersionId,webhookIds:d.nodes.filter(n=>n.webhookId).map(n=>({name:n.name,webhookId:n.webhookId,path:n.parameters.path}))});}
const executions=[];const list=await api('executions?limit=30');
for(const row of list.results??[]){const x=await api('executions/'+row.id);const d=executionData(x.data);const lm=d?.resultData?.runData?.LLM?.[0]?.data?.ai_languageModel?.[0]?.[0]?.json;
 executions.push({id:x.id,workflowId:x.workflowId,workflowVersionId:x.workflowVersionId,status:x.status,mode:x.mode,startedAt:x.startedAt,stoppedAt:x.stoppedAt,lastNode:d?.resultData?.lastNodeExecuted,error:d?.resultData?.error?.message,tokenUsage:lm?.tokenUsage});}
const failures=[];
function check(name,fn){try{fn();console.log('PASS',name);}catch(e){failures.push({name,error:e.message});console.log('FAIL',name,e.message);}}
for(const e of evidence.slice(0,3))check(e.case+' real extraction envelope',()=>{assert.equal(e.http,200);assert.equal(e.body.success,true);assert.deepEqual(e.body.confidence,{});assert.equal(typeof e.body.extracted.company_name,'string');assert.equal(e.body.extracted.notes,notes.find(n=>n.id===e.case).notes);});
check('DE canonical enum normalization',()=>{const e=evidence[1].body.extracted;assert.equal(e.training_interest,'ai_automation');assert.equal(e.budget_status,'approved');assert.equal(e.follow_up,'within_one_week');assert.equal(e.phone,null);assert.equal(e.website,null);});
check('Missing facts remain null, never no_budget/no_follow_up',()=>{const e=evidence[2].body.extracted;for(const k of ['budget_status','follow_up','email','phone','website'])assert.equal(e[k],null,k);});
check('UC21 does not invent approval; explicit ISO date',()=>{const e=evidence[0].body.extracted;assert.notEqual(e.budget_status,'approved');assert.equal(e.follow_up_date,'2026-11-06');});
check('Unscored answer has no invented score',()=>{assert.equal(evidence[3].http,200);assert.match(evidence[3].body.answer,/Score = unbekannt/);});
check('Supported questions produce different exact answers',()=>{const a=evidence.slice(3,6);assert.equal(new Set(a.map(x=>x.body.answer)).size,3);assert.match(a[1].body.answer,/Budget = planned/);assert.match(a[2].body.answer,/Trainingsinteresse = ai_automation/);for(const e of a)assert(e.body.cited_lead_ids.every(id=>id==='FAIR-00000000-0000-4000-8000-000000000001'));});
check('Registered webhooks reject no auth',()=>{for(const e of evidence.slice(6))assert.equal(e.http,403);});
await mkdir(new URL('evidence/',here),{recursive:true});
await writeFile(new URL('evidence/real-webhooks.json',here),JSON.stringify({sourceSha:state.sourceSha,blackFixSha:'a9460564c54ebdc0359b65eae1f72d46111746e7',adaptations:'adapt-workflows.mjs (separate integration candidate, not original RC)',versions,results:evidence,executions,failures},null,2)+'\n');

if(failures.length)process.exitCode=1;
