// Isolated actual n8n integration. Never reads or touches production configuration.
import {execFile as rawExec} from 'node:child_process';
import {promisify,parseEnv} from 'node:util';
import {readFile,writeFile,mkdir,chmod,mkdtemp,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {startPg16} from '../../tests/helpers/pg16.mjs';
const exec=promisify(rawExec);
const root=resolve(new URL('../../',import.meta.url).pathname);
const here=resolve(new URL('./',import.meta.url).pathname);
// Record the exact checked-out source revision; never reuse the historical RC1 SHA.
const sourceSha=(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
assert.match(sourceSha,/^[0-9a-f]{40}$/);
const trackedChanges=(await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:root})).stdout;
assert.equal(trackedChanges.trim(),'','Bootstrap must use committed canonical workflow parameters');
const stateFile=join(here,'.runtime/state.json');
try {
 const existing=JSON.parse(await readFile(stateFile,'utf8'));
 const r=await exec('docker',['inspect',existing.container,'--format','{{.State.Running}}']);
 if(r.stdout.trim()==='true' && (await fetch(`http://127.0.0.1:${existing.port}/healthz`)).ok) {
  console.log('Existing LIVE01 isolated environment healthy; imports and state unchanged');
  process.exit(0);
 }
 throw Error('Recorded LIVE01 environment is not running; inspect before recreate');
} catch(e) { if(e.code!=='ENOENT')throw e; }
const keyFile=process.env.STAGING_KEY_FILE;
if(!keyFile)throw Error('Explicit Owner staging STAGING_KEY_FILE required; no mock fallback');
const key=parseEnv(await readFile(keyFile,'utf8')).OPENAI_API_KEY;
if(!key)throw Error('Designated staging key absent');
const priv=await mkdtemp(join(tmpdir(),'wbs-n8n-live01-'));await chmod(priv,0o700);
const runtime=join(here,'.runtime');await mkdir(runtime,{recursive:true,mode:0o700});
const header=randomBytes(24).toString('hex');
const db=await startPg16();
// Local synthetic fixture only: unchanged capture function supplied with Yuri's package.
const capturePath=process.env.CAPTURE_SCHEMA_FILE || join(here,'fixtures/capture_lead.sql');
const raw=await readFile(capturePath,'utf8');
const begin=raw.indexOf('CREATE OR REPLACE FUNCTION trade_fair.capture_lead(');
const end=raw.indexOf('$function$;',begin)+'$function$;'.length;
if(begin<0||end<begin)throw Error('capture fixture function missing');
const capture=raw.slice(begin,end);
await db.pool.query(capture);
await db.pool.query(await readFile(join(here,'fixtures/get_lead_status.sql'),'utf8'));
// Invoker access restricted to the three capture tables in this synthetic DB only.
await db.pool.query(`CREATE ROLE isolated_capture LOGIN PASSWORD 'synthetic-local-only';
 GRANT USAGE ON SCHEMA trade_fair TO isolated_capture;
 GRANT SELECT,INSERT,UPDATE ON trade_fair.companies,trade_fair.contacts,trade_fair.lead_submissions TO isolated_capture;
 REVOKE ALL ON FUNCTION trade_fair.capture_lead(jsonb) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION trade_fair.capture_lead(jsonb) TO isolated_capture;
 REVOKE ALL ON FUNCTION trade_fair.get_lead_status(text,text) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION trade_fair.get_lead_status(text,text) TO isolated_capture;`);
const name='wbs-live01-n8n';const port=15679;
const pgdata={host:'host.docker.internal',port:db.port,database:'neondb',password:'synthetic-local-only',ssl:'disable'};
const creds=[
 {id:'live01-header',name:'LIVE01 isolated Header Auth',type:'httpHeaderAuth',data:{name:'X-Trade-Fair-Key',value:header}},
 {id:'live01-openai',name:'LIVE01 Owner staging OpenAI',type:'openAiApi',data:{apiKey:key}},
 {id:'live01-pg',name:'LIVE01 scoped AI context',type:'postgres',data:{...pgdata,user:'synthetic_context_login'}},
 {id:'live01-capture',name:'LIVE01 synthetic capture only',type:'postgres',data:{...pgdata,user:'isolated_capture'}},
];
const workflows=[];
for(const [file,id,label] of [
 ['workflows/wf-07-messe-hub-ai-extract.adapted.json','live01-wf07','LIVE01 WF-07 actual AI extract'],
 ['workflows/wf-08-messe-hub-ai-ask.adapted.json','live01-wf08','LIVE01 WF-08 actual AI ask'],
 ['workflows/wf-a-lead-capture.json','live01-wfa','LIVE01 WF-A synthetic capture'],
 ['workflows/wf-d-lead-status.json','live01-wfd','LIVE01 WF-D synthetic status'],
]){
 let wf=JSON.parse(await readFile(join(root,file),'utf8'));if(Array.isArray(wf))wf=wf[0];
 const canonicalParameters=new Map(wf.nodes.map(n=>[n.id,structuredClone(n.parameters)]));
 wf.id=id;wf.name=label;wf.active=false;delete wf.versionId;delete wf.activeVersionId;delete wf.triggerCount;
 wf.pinData={};wf.staticData=null;
 for(const n of wf.nodes){
  if(n.type==='n8n-nodes-base.webhook'&&!n.webhookId)n.webhookId=randomUUID();
  if(n.credentials?.httpHeaderAuth)n.credentials.httpHeaderAuth={id:'live01-header',name:'LIVE01 isolated Header Auth'};
  if(n.credentials?.openAiApi)n.credentials.openAiApi={id:'live01-openai',name:'LIVE01 Owner staging OpenAI'};
  if(n.credentials?.postgres)n.credentials.postgres={id:['live01-wfa','live01-wfd'].includes(id)?'live01-capture':'live01-pg',name:['live01-wfa','live01-wfd'].includes(id)?'LIVE01 synthetic capture only':'LIVE01 scoped AI context'};
 }
 // No adaptation here: import the exact committed node parameters.
 for(const n of wf.nodes)assert.deepEqual(n.parameters,canonicalParameters.get(n.id),'Canonical workflow parameters changed during bootstrap: '+n.name);
 workflows.push(wf);
}
await writeFile(join(priv,'credentials.json'),JSON.stringify(creds),{mode:0o600});
await writeFile(join(priv,'workflows.json'),JSON.stringify(workflows),{mode:0o600});
await writeFile(join(priv,'n8n.env'),[
 'N8N_ENCRYPTION_KEY='+randomBytes(32).toString('hex'),
 'N8N_DIAGNOSTICS_ENABLED=false','N8N_VERSION_NOTIFICATIONS_ENABLED=false','N8N_TEMPLATES_ENABLED=false',
 'N8N_SECURE_COOKIE=false','N8N_HOST=127.0.0.1','N8N_PORT=5678','N8N_PROTOCOL=http',
 'WEBHOOK_URL=http://127.0.0.1:'+port+'/', 'N8N_EDITOR_BASE_URL=http://127.0.0.1:'+port+'/',
 'EXECUTIONS_DATA_SAVE_ON_SUCCESS=none','EXECUTIONS_DATA_SAVE_ON_ERROR=none',
 'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false','EXECUTIONS_DATA_PRUNE=true',
 'N8N_RUNNERS_ENABLED=true','N8N_RUNNERS_MODE=internal','N8N_LOG_LEVEL=warn',
].join('\n')+'\n',{mode:0o600});
await exec('docker',['volume','create','wbs-live01-n8n-data']);
await exec('docker',['run','-d','--name',name,'-p',`127.0.0.1:${port}:5678`,
 '--env-file',join(priv,'n8n.env'),'-v','wbs-live01-n8n-data:/home/node/.n8n',
 '-v',`${priv}:/fixtures:ro`,'--entrypoint','sh','n8nio/n8n:2.41.7','-c',
 'n8n import:credentials --input=/fixtures/credentials.json && n8n import:workflow --input=/fixtures/workflows.json && exec n8n start']);
for(let i=0;i<100;i++){
 try{if((await fetch(`http://127.0.0.1:${port}/rest/settings`)).ok)break;}catch{}
 await new Promise(r=>setTimeout(r,500));
}
const setup=await fetch(`http://127.0.0.1:${port}/rest/owner/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'n8n-live-01@example.test',firstName:'Isolated',lastName:'LIVE01',password:'IsolatedLive01Only!2026'})});
if(!setup.ok)throw Error('Isolated owner setup failed HTTP '+setup.status);
const state={sourceSha,priv,container:name,port,dbContainer:db.name,pgPort:db.port,header,captureFunctionSha256:createHash('sha256').update(capture).digest('hex'),workflowIds:workflows.map(w=>w.id)};
await writeFile(join(runtime,'state.json'),JSON.stringify(state,null,2),{mode:0o600});
// Clear plaintext API credential import immediately; encrypted credential stays in isolated volume.
await unlink(join(priv,'credentials.json'));
console.log(JSON.stringify({status:'READY_FOR_UI_PUBLISH',container:name,n8nPort:port,pgPort:db.port,workflowIds:state.workflowIds,captureFunctionSha256:state.captureFunctionSha256}));
await db.pool.end();
// Containers retained for UI publishing, real webhooks and Owner handoff. No shared container changes.
