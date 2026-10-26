// Freeze sanitized evidence, restore non-retaining settings, export import-safe workflow copies.
import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {apiSession} from './api.mjs';import {executionData} from './execution.mjs';import {adaptWorkflow} from './adapt-workflows.mjs';
const here=new URL('./',import.meta.url);const s=JSON.parse(await readFile(new URL('.runtime/state.json',here),'utf8'));const api=await apiSession();
const versions=[];const llmAudit=[];const list=await api('executions?limit=100');
for(const row of list.results??[]){
 const x=await api('executions/'+row.id);const d=executionData(x.data);if(!d?.resultData)continue;
 const lm=d.resultData.runData?.LLM?.[0];const json=lm?.data?.ai_languageModel?.[0]?.[0]?.json;
 const input=JSON.stringify(lm?.inputOverride??{});
 if(lm)assert(lm.inputOverride,'Actual model input must exist; context alone is insufficient evidence');
 const isAsk=x.workflowId==='live01-wf08';
 const directPII=isAsk&&/Mila|Integrationswerk|mila-live01|synthetic@example|PRIVATE SYNTHETIC|company_name|contact_name/.test(input);
 if(isAsk)assert(!directPII);
 llmAudit.push({executionId:x.id,workflowId:x.workflowId,workflowVersionId:x.workflowVersionId,status:x.status,startedAt:x.startedAt,stoppedAt:x.stoppedAt,lastNode:d.resultData.lastNodeExecuted,error:d.resultData.error?.message,tokenUsage:json?.tokenUsage,actualModelInputRecorded:!!lm?.inputOverride,...(isAsk?{directPIIDetected:directPII,rawQuestionReducedLocally:!input.includes('Welchen Score und welches Budget')}:{} )});
}
await mkdir(new URL('published/',here),{recursive:true});
for(const id of s.workflowIds){
 let d=await api('workflows/'+id);
 if(['live01-wf07','live01-wf08'].includes(id)){
  const source=JSON.parse(await readFile(new URL('../../workflows/wf-0'+(id.endsWith('07')?'7':'8')+'-messe-hub-ai-'+(id.endsWith('07')?'extract':'ask')+'.adapted.json',here),'utf8'));
  const expected=adaptWorkflow(source);
  for(const n of expected.nodes)assert.deepEqual(d.nodes.find(x=>x.id===n.id).parameters,n.parameters,'Published node parameters must match integration candidate');
 }
 // Settings-only update uses n8n's supported settings republish behavior; no DB active flag edits.
 if(d.settings.saveDataErrorExecution!=='none'||d.settings.saveDataSuccessExecution!=='none')d=await api('workflows/'+id,{versionId:d.versionId,settings:{...d.settings,saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,saveExecutionProgress:false}});
 d=await api('workflows/'+id);
 assert(d.active);assert(d.activeVersionId);
 const webhook=d.nodes.find(n=>n.type==='n8n-nodes-base.webhook');
 const noAuth=await fetch('http://127.0.0.1:'+s.port+'/webhook/'+webhook.parameters.path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(noAuth.status,403);
 const copy={name:d.name,id:d.id,active:false,nodes:d.nodes,connections:d.connections,settings:d.settings,staticData:null,pinData:{}};
 const file=id==='live01-wf07'?'wf07.json':id==='live01-wf08'?'wf08.json':id==='live01-wfa'?'wfa-isolated.json':'wfd-isolated.json';
 const payload=JSON.stringify(copy,null,2)+'\n';await writeFile(new URL('published/'+file,here),payload);
 versions.push({id:d.id,active:d.active,versionId:d.versionId,publishedVersionId:d.activeVersionId,webhookPath:'/webhook/'+webhook.parameters.path,webhookId:webhook.webhookId,noAuthHttp:noAuth.status,artifact:file,sha256:createHash('sha256').update(payload).digest('hex'),retention:d.settings});
}
const image=execFileSync('docker',['inspect',s.container,'--format','{{.Image}}'],{encoding:'utf8'}).trim();
const manifest={task:'WBS-TF-N8N-LIVE-01',observedUtc:new Date().toISOString(),releaseCandidate:'6b64f70d340c1bd9fcdefdfadcd27c35d566fd30',blackFixSha:'a9460564c54ebdc0359b65eae1f72d46111746e7',integrationCommit:'Git commit containing this manifest (self-reference excluded)',n8n:{version:'2.41.7',container:s.container,imageId:image,origin:'http://127.0.0.1:'+s.port,volume:'wbs-live01-n8n-data',uiPublish:true},pg:{container:s.dbContainer,host:'127.0.0.1',port:s.pgPort,data:'synthetic only',scope:'dedicated local PostgreSQL; NOT Neon'},gateway:{origin:'http://127.0.0.1:3117',realNetworkUpstream:true,noEquivalentProxy:true},workflowVersions:versions,productionChanges:false,releaseGate:'HOLD pending developer incorporation, independent integration review, infrastructure gates and Owner GO'};
await writeFile(new URL('evidence/manifest.json',here),JSON.stringify(manifest,null,2)+'\n');await writeFile(new URL('evidence/execution-audit.json',here),JSON.stringify(llmAudit,null,2)+'\n');
console.log(JSON.stringify({workflows:versions.map(x=>({id:x.id,publishedVersionId:x.publishedVersionId,registeredNoAuthHttp:x.noAuthHttp})),sanitizedExecutions:llmAudit.length,retention:'restored none; existing synthetic diagnostics retained privately for handoff'}));
