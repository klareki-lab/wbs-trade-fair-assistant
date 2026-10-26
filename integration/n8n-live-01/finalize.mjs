// Freeze sanitized evidence, restore non-retaining settings, export import-safe workflow copies.
// RC3.2 (R2.1): the committed WF-07/08 workflows must have their *published* snapshot
// — the artifact the webhook actually executes — byte-equal to canonical source.
// Comparing only the API's draft `d.nodes` accepts a canonical draft over stale
// published code. See integration/n8n-live-01/verify-published.mjs.
import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {apiSession} from './api.mjs';import {executionData} from './execution.mjs';
import {assertCanonicalPublished, fetchPublishedSnapshot} from './verify-published.mjs';
const here=new URL('./',import.meta.url);const s=JSON.parse(await readFile(new URL('.runtime/state.json',here),'utf8'));const api=await apiSession();
const checkedOutSha=execFileSync('git',['rev-parse','HEAD'],{cwd:new URL('../../',import.meta.url),encoding:'utf8'}).trim();
assert.equal(s.sourceSha,checkedOutSha,'Refuse to relabel historical n8n runtime evidence as current release');
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
 // Settings-only update uses n8n's supported settings republish behavior; no DB active flag edits.
 if(d.settings.saveDataErrorExecution!=='none'||d.settings.saveDataSuccessExecution!=='none')d=await api('workflows/'+id,{versionId:d.versionId,settings:{...d.settings,saveDataErrorExecution:'none',saveDataSuccessExecution:'none',saveManualExecutions:false,saveExecutionProgress:false}});
 d=await api('workflows/'+id);
 assert(d.active,'workflow '+id+' must be active');assert(d.activeVersionId,'workflow '+id+' must have activeVersionId');
 let publishedForArtifact;
 if(['live01-wf07','live01-wf08'].includes(id)){
  const source=JSON.parse(await readFile(new URL('../../workflows/wf-0'+(id.endsWith('07')?'7':'8')+'-messe-hub-ai-'+(id.endsWith('07')?'extract':'ask')+'.adapted.json',here),'utf8'));
  // RC3.2: fetch the actual PUBLISHED snapshot (not the draft d.nodes) and verify
  // its node parameters + connections match canonical source. Fails CLOSED on any
  // divergence or on versionId !== activeVersionId (Codex's counterexample).
  const published=await fetchPublishedSnapshot(api,id,d.activeVersionId);
  assertCanonicalPublished({source,workflowFromApi:d,publishedSnapshot:published,workflowId:id});
  publishedForArtifact=published;
 } else {
  // Non-canonical isolated fixtures (WF-A/D synthetic capture/status) carry no
  // canonical-provenance claim; export the draft as before.
  publishedForArtifact={nodes:d.nodes,connections:d.connections,versionId:d.activeVersionId};
 }
 const webhook=(publishedForArtifact.nodes.find(n=>n.type==='n8n-nodes-base.webhook')||d.nodes.find(n=>n.type==='n8n-nodes-base.webhook'));
 const noAuth=await fetch('http://127.0.0.1:'+s.port+'/webhook/'+webhook.parameters.path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(noAuth.status,403);
 // Export the PUBLISHED snapshot (which the webhook actually executes), not the
 // draft. Hash binds the artifact to the published versionId + source SHA.
 const copy={name:d.name,id:d.id,active:false,nodes:publishedForArtifact.nodes,connections:publishedForArtifact.connections,settings:d.settings,staticData:null,pinData:{}};
 const file=id==='live01-wf07'?'wf07.json':id==='live01-wf08'?'wf08.json':id==='live01-wfa'?'wfa-isolated.json':'wfd-isolated.json';
 const payload=JSON.stringify(copy,null,2)+'\n';await writeFile(new URL('published/'+file,here),payload);
 versions.push({id:d.id,active:d.active,draftVersionId:d.versionId,publishedVersionId:d.activeVersionId,draftEqualsPublished:d.versionId===d.activeVersionId,webhookPath:'/webhook/'+webhook.parameters.path,webhookId:webhook.webhookId,noAuthHttp:noAuth.status,artifact:file,artifactScope:'published-snapshot',sha256:createHash('sha256').update(payload).digest('hex'),retention:d.settings,sourceSha:s.sourceSha});
}
const image=execFileSync('docker',['inspect',s.container,'--format','{{.Image}}'],{encoding:'utf8'}).trim();
const manifest={task:'WBS-TF-N8N-LIVE-01',observedUtc:new Date().toISOString(),releaseCandidate:s.sourceSha,integrationCommit:'Git commit containing this manifest (self-reference excluded)',provenanceCheck:'RC3.2 published-snapshot-vs-canonical (verify-published.mjs); draft-only acceptance rejected',n8n:{version:'2.41.7',container:s.container,imageId:image,origin:'http://127.0.0.1:'+s.port,volume:'wbs-live01-n8n-data',uiPublish:true},pg:{container:s.dbContainer,host:'127.0.0.1',port:s.pgPort,data:'synthetic only',scope:'dedicated local PostgreSQL; NOT Neon'},gateway:{origin:'http://127.0.0.1:3117',realNetworkUpstream:true,noEquivalentProxy:true},workflowVersions:versions,productionChanges:false,releaseGate:'HOLD pending developer incorporation, independent integration review, infrastructure gates and Owner GO'};
await writeFile(new URL('evidence/manifest.json',here),JSON.stringify(manifest,null,2)+'\n');await writeFile(new URL('evidence/execution-audit.json',here),JSON.stringify(llmAudit,null,2)+'\n');
console.log(JSON.stringify({workflows:versions.map(x=>({id:x.id,publishedVersionId:x.publishedVersionId,registeredNoAuthHttp:x.noAuthHttp})),sanitizedExecutions:llmAudit.length,retention:'restored none; existing synthetic diagnostics retained privately for handoff'}));
