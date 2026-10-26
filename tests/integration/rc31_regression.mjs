import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {adaptWorkflow} from '../../integration/n8n-live-01/adapt-workflows.mjs';

const root=new URL('../../',import.meta.url);
const load=async file=>JSON.parse(await readFile(new URL('workflows/'+file,root),'utf8'));
const ask=await load('wf-08-messe-hub-ai-ask.adapted.json');
const extract=await load('wf-07-messe-hub-ai-extract.adapted.json');
const id=i=>'FAIR-00000000-0000-4000-8000-'+String(i).padStart(12,'0');
const fields=['score_band','score_total','budget_status'];
const context=Array.from({length:9},(_,i)=>({lead_id:id(i+1),score_band:null,score_total:null,budget_status:'planned'}));
const request={context,requested_fields:fields};
const postCode=ask.nodes.find(n=>n.name==='Ausgabe prüfen').parameters.jsCode;
function run(result,ctx=request){
 const input={first:()=>({json:{output:result}})};
 const lookup=()=>({first:()=>({json:ctx})});
 return new Function('$input','$',postCode)(input,lookup)[0].json;
}
const cells=(leads,keys)=>leads.flatMap(l=>keys.map(field=>({lead_id:l.lead_id,field,value:l[field]})));
const warning=/^\s*⚠\s*Ergebnis unvollständig\b/u;

test('R1: canonical WF-08 27 requested cells / 20 verified claims warns and cites exactly 7 leads',()=>{
 const r=run({claims:cells(context,fields).slice(0,20),unavailable:false});
 assert.equal(r.success,true);
 assert.match(r.answer,warning);
 assert.match(r.answer,/20 von 27 angefragten Werten/);
 assert.equal(r.answer.split('\n').length,21);
 assert.equal(r.cited_lead_ids.length,7);
});
test('R1: complete distinct coverage does not warn, despite 20-claim schema cap',()=>{
 const small={context:context.slice(0,2),requested_fields:fields};
 const r=run({claims:cells(small.context,fields),unavailable:false},small);
 assert.doesNotMatch(r.answer,warning);
 assert.equal(r.answer.split('\n').length,6);
 assert.equal(r.cited_lead_ids.length,2);
});
test('R1: duplicated claims cannot hide incomplete coverage, even below cap',()=>{
 const small={context:context.slice(0,2),requested_fields:fields};
 const duplicate={lead_id:id(1),field:'score_band',value:null};
 const r=run({claims:Array(5).fill(duplicate),unavailable:false},small);
 assert.match(r.answer,/1 von 6 angefragten Werten/);
 assert.equal(r.answer.split('\n').length,2,'one warning + one distinct verified value');
});
test('R1: missing claim below cap still warns',()=>{
 const small={context:context.slice(0,2),requested_fields:fields};
 const r=run({claims:cells(small.context,fields).slice(0,5),unavailable:false},small);
 assert.match(r.answer,/5 von 6 angefragten Werten/);
});
test('R1: unsupported request with zero requested fields is not mislabelled incomplete',()=>{
 const r=run({claims:[],unavailable:true},{context:context.slice(0,2),requested_fields:[]});
 assert.doesNotMatch(r.answer,warning);
});
test('R1: supported but unavailable request warns 0/N',()=>{
 const r=run({claims:[],unavailable:true},{context:context.slice(0,1),requested_fields:fields});
 assert.match(r.answer,/0 von 3 angefragten Werten/);
});
test('R1: validation still rejects a forged value or out-of-scope lead',()=>{
 assert.throws(()=>run({claims:[{lead_id:id(2),field:'score_total',value:999}],unavailable:false}),/ASK_UNGROUNDED_CLAIM/);
 assert.throws(()=>run({claims:[{lead_id:id(10),field:'budget_status',value:'planned'}],unavailable:false}),/ASK_UNGROUNDED_CLAIM/);
});
test('R2: adapt(adapt(canonical)) equals adapt(canonical), byte-for-byte prompt count preserved',()=>{
 for(const source of [extract,ask]){
  const one=adaptWorkflow(structuredClone(source));
  const two=adaptWorkflow(structuredClone(one));
  assert.deepEqual(one,source,'canonical must be fixed-point under adaptation');
  assert.deepEqual(two,one,'adaptation must be idempotent');
 }
 const system=extract.nodes.find(n=>n.name==='KI Extraktor').parameters.messages.messageValues[0].message;
 const askSystem=ask.nodes.find(n=>n.name==='Assistent').parameters.messages.messageValues[0].message;
 assert.equal(system.split('INTEGRATION CONTRACT:').length-1,1);
 assert.equal(askSystem.split('Return at most 20 claims').length-1,1);
});
test('R2: bootstrap/finalizer compare raw canonical node parameters instead of re-adapting',async()=>{
 const start=await readFile(new URL('integration/n8n-live-01/start.mjs',root),'utf8');
 const finalize=await readFile(new URL('integration/n8n-live-01/finalize.mjs',root),'utf8');
 assert.match(start,/workflows\.push\(wf\)/);
 assert.doesNotMatch(start,/workflows\.push\(adaptWorkflow/);
 assert.match(start,/assert\.deepEqual\(n\.parameters,canonicalParameters\.get\(n\.id\)/);
 assert.match(finalize,/const expected=source;/);
 assert.doesNotMatch(finalize,/adaptWorkflow\(source\)/);
});
