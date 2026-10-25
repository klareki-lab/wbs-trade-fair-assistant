// Executes committed Code/LLM/parser/Postgres nodes in an ephemeral n8n, with a
// local mock OpenAI endpoint. Only entry/exit transport and synthetic credentials
// differ from the inactive artifacts. This is NOT deployed staging acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {startPg16,ids} from '../helpers/pg16.mjs';
const exec=promisify(rawExec);
test('isolated n8n 2.41.7: WF-07/08 actual chain, parser, scoped PostgreSQL and response envelope with mock provider', {timeout:180000},async()=>{
 const db=await startPg16();const name='wbs-r2-n8n-'+randomUUID().slice(0,8);const dir=await mkdtemp(join(tmpdir(),'wbs-r2-n8n-'));const requests=[];
 const fields=['company_name','contact_name','email','phone','website','training_interest','budget_status','follow_up','follow_up_date','notes','summary'];
 const model=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input);
  const extract=JSON.stringify(input.messages).includes('Extract fields only');
  const value=extract?{extracted:Object.fromEntries(fields.map(k=>[k,k==='company_name'?'Synthetic Company':null])),evidence:Object.fromEntries(fields.map(k=>[k,k==='company_name'?'Synthetic Company':null]))}:{claims:[{lead_id:ids[0],field:'budget_status',value:'planned'}],unavailable:false};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'synthetic-completion',object:'chat.completion',created:1,model:'gpt-4.1-mini',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({output:value})},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
 });model.listen(0,'0.0.0.0');await once(model,'listening');
 const docker=async(args)=>exec('docker',args,{maxBuffer:16*1024*1024,timeout:120000});
 try{
  await db.pool.query("CREATE ROLE synthetic_ai LOGIN PASSWORD 'synthetic-local-only'; GRANT trade_fair_ai_context TO synthetic_ai;");
  const creds=[{id:'r2-ai',name:'Synthetic model only',type:'openAiApi',data:{apiKey:'synthetic-local-only',url:`http://host.docker.internal:${model.address().port}/v1`}},{id:'r2-pg',name:'Synthetic context only',type:'postgres',data:{host:'host.docker.internal',port:db.port,database:'neondb',user:'synthetic_ai',password:'synthetic-local-only',ssl:'disable'}}];
  await writeFile(join(dir,'credentials.json'),JSON.stringify(creds));
  const workflows=[];
  for(const kind of ['extract','ask']){
   const d=JSON.parse(await readFile(new URL(`../../workflows/wf-0${kind==='extract'?7:8}-messe-hub-ai-${kind}.adapted.json`,import.meta.url),'utf8'));
   d.id='r2'+kind;d.name='Synthetic R2 '+kind;delete d.versionId;delete d.triggerCount;
   const start=d.nodes.find(n=>n.name==='Anfrage');start.type='n8n-nodes-base.code';start.typeVersion=2;delete start.credentials;
   start.parameters={jsCode:'return [{json:'+JSON.stringify({body:kind==='extract'?{notes:'Synthetic Company discussed training.'}:{question:'Which budget?',context_lead_ids:[ids[0]]}})+'}];'};
   const end=d.nodes.find(n=>n.name==='Antwort senden');end.type='n8n-nodes-base.noOp';end.typeVersion=1;end.parameters={};
   d.nodes.push({id:randomUUID(),name:'Synthetic trigger',type:'n8n-nodes-base.manualTrigger',typeVersion:1,parameters:{},position:[-200,0]});d.connections['Synthetic trigger']={main:[[{node:'Anfrage',type:'main',index:0}]]};
   d.nodes.find(n=>n.name==='LLM').credentials={openAiApi:{id:'r2-ai',name:'Synthetic model only'}};
   if(kind==='ask')d.nodes.find(n=>n.name==='Leads lesen').credentials={postgres:{id:'r2-pg',name:'Synthetic context only'}};
   workflows.push(d);
  }
  await writeFile(join(dir,'workflows.json'),JSON.stringify(workflows));
  await docker(['run','-d','--rm','--name',name,'-v',`${dir}:/fixtures:ro`,'-e','N8N_ENCRYPTION_KEY=synthetic-local-only-key-32-chars','-e','N8N_DIAGNOSTICS_ENABLED=false','-e','N8N_VERSION_NOTIFICATIONS_ENABLED=false','-e','N8N_TEMPLATES_ENABLED=false','-e','N8N_SSRF_PROTECTION_ENABLED=false','--entrypoint','sh','n8nio/n8n:2.41.7','-c','sleep 900']);
  await docker(['exec',name,'n8n','import:credentials','--input=/fixtures/credentials.json']);
  await docker(['exec',name,'n8n','import:workflow','--input=/fixtures/workflows.json']);
  for(const kind of ['extract','ask']){
   let output;
   try{output=await docker(['exec',name,'n8n','execute','--id=r2'+kind,'--rawOutput']);}catch(e){throw new Error(`Isolated ${kind} n8n failed: ${e.stdout}\n${e.stderr}`);}
   // Full execution JSON contains the last node's response plus earlier node outputs.
   assert.match(output.stdout,/"success"\s*:\s*true/);
   if(kind==='extract')assert.match(output.stdout,/Jeden Wert/);else assert.match(output.stdout,/Budget = planned/);
  }
  assert.equal(requests.length,2); assert(requests.every(r=>r.store===false));const ask=requests.find(r=>!JSON.stringify(r.messages).includes('Extract fields only'));
  const user=ask.messages.find(m=>m.role==='user');assert(!/Synthetic Person|PRIVATE SYNTHETIC NOTE|synthetic@example|company_name|contact_name/.test(user.content));
  assert.match(user.content,/budget_status/);assert.equal(ask.max_tokens ?? ask.max_completion_tokens,1200);
  console.log('Actual n8n chains executed with scoped SQL and mock model; paid APIs not called.');
 }finally{await docker(['rm','-f',name]).catch(()=>{});await new Promise(r=>model.close(r));await db.close();await rm(dir,{recursive:true,force:true});}
});
