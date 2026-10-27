// Integration-only candidate adaptations; source workflow JSON files stay unchanged.
// Black CC must incorporate/review these before any production release.
import {randomUUID} from 'node:crypto';
export function adaptWorkflow(wf){
 for(const n of wf.nodes){
  if(n.type==='n8n-nodes-base.webhook'&&!n.webhookId)n.webhookId=randomUUID();
 }
 const isExtract=wf.nodes.some(n=>n.name==='KI Extraktor');
 if(isExtract){
  const parser=wf.nodes.find(n=>n.type==='@n8n/n8n-nodes-langchain.outputParserStructured');
  const schema=JSON.parse(parser.parameters.inputSchema);
  const enums={training_interest:['leadership','communication','sales','project_management','digital_skills','ai_automation','other'],budget_status:['approved','planned','unknown','not_disclosed','no_budget'],follow_up:['within_one_week','within_two_weeks','within_one_month','on_date','no_follow_up','not_decided']};
  for(const[field,values]of Object.entries(enums))schema.properties.extracted.properties[field].enum=[...values,null];
  parser.parameters.inputSchema=JSON.stringify(schema);
  const llm=wf.nodes.find(n=>n.name==='LLM');
  // Native OpenAI strict structured output, still executed by actual n8n LLM/parser nodes.
  // Parser 1.3 expects its documented output wrapper. No proxy/model replacement/retry.
  llm.parameters.options.extraBody=JSON.stringify({store:false,response_format:{type:'json_schema',json_schema:{name:'messe_extract',strict:true,schema:{type:'object',properties:{output:schema},required:['output'],additionalProperties:false}}}});
  // Conservative guard: explicit absence of discussion is not an instruction to
  // decline follow-up or a statement that no budget exists. Never invent a value.
  const post=wf.nodes.find(n=>n.name==='Ausgabe prüfen');
  post.parameters.jsCode=post.parameters.jsCode.replace(
   "const extracted = {}, uncertainty_flags = [];",
   `const integrationGuardFlags=[];
const missingBudget=/\\bbudget\\b[^.!?\\n]{0,80}(?:nicht besprochen|nicht genannt|nicht diskutiert|unbekannt)/iu.test(notes);
const missingFollow=/(?:kein(?:en|e)? Termin f[üu]r (?:die )?R[üu]ckmeldung|(?:Follow-up|R[üu]ckmeldung)[^.!?\\n]{0,50}(?:nicht besprochen|unbekannt))/iu.test(notes);
for(const [field,missing] of [['budget_status',missingBudget],['follow_up',missingFollow]]) {
 if(missing && result.extracted[field]!=null) { result.extracted[field]=null; result.evidence[field]=null; integrationGuardFlags.push('missing_'+field); }
}
const extracted = {}, uncertainty_flags = [...integrationGuardFlags];`);
  const system=wf.nodes.find(n=>n.name==='KI Extraktor').parameters.messages.messageValues[0];
  if (!system.message.includes('\nINTEGRATION CONTRACT:')) system.message += '\nINTEGRATION CONTRACT: Normalize explicit German expressions to the canonical enum strings in the schema (for example KI-Automatisierung -> ai_automation, freigegeben -> approved, innerhalb einer Woche -> within_one_week). Keep missing/ambiguous facts null. If budget was not discussed or not mentioned, budget_status MUST be null; no_budget means an explicit statement that no budget exists, never missing information. If no follow-up decision/date was discussed, follow_up MUST be null; no_follow_up means an explicit request not to follow up. Budget amount alone does not mean approved. Only set follow_up_date when an explicit date is present, normalized to YYYY-MM-DD, and follow_up=on_date. Always retain the exact original quote in evidence. Set notes, summary, evidence.notes and evidence.summary to null; the downstream validator retains the original notes locally. Evidence must be the shortest verbatim original substring, with no ellipses or paraphrase: prefer KI-Automatisierung, freigegeben, or innerhalb einer Woche rather than rewriting whole sentences. Return the required output wrapper and no prose.';
 }
 if(!isExtract && wf.nodes.some(n=>n.name==='Assistent')) {
  const parser=wf.nodes.find(n=>n.type==='@n8n/n8n-nodes-langchain.outputParserStructured');
  const schema=JSON.parse(parser.parameters.inputSchema);
  wf.nodes.find(n=>n.name==='LLM').parameters.options.extraBody=JSON.stringify({store:false,response_format:{type:'json_schema',json_schema:{name:'messe_ask',strict:true,schema:{type:'object',properties:{output:schema},required:['output'],additionalProperties:false}}}});
  const askMessage=wf.nodes.find(n=>n.name==='Assistent').parameters.messages.messageValues[0];
  if (!askMessage.message.includes(' Return at most 20 claims in total, even when more facts exist.')) askMessage.message+=' Return at most 20 claims in total, even when more facts exist. Copy null values literally when relevant; do not invent numeric scores. Return the required output wrapper and no prose.';
 }
 return wf;
}
