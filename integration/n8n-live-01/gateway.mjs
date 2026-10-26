// Real Gateway -> real registered n8n webhooks -> actual isolated PostgreSQL.
// No AI/capture/status workflow replacement. One explicit test-only lost-receipt fault.
import {readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';import {createHash} from 'node:crypto';
import pg from '../../gateway/node_modules/pg/lib/index.js';
import {createGateway,loadConfig} from '../../gateway/server.mjs';
import {createDashboardDb} from '../../gateway/dashboard-db.mjs';
import {createDashboardCrm} from '../../gateway/dashboard-crm.mjs';
const statePath=new URL('.runtime/state.json',import.meta.url);
const s=JSON.parse(await readFile(statePath,'utf8'));
const upstream=`http://127.0.0.1:${s.port}`;
const connectionString=`postgresql://trade_fair_dashboard:synthetic-local-only@127.0.0.1:${s.pgPort}/neondb`;
const factory=o=>new pg.Pool({...o,ssl:false}); // local disposable PG only; production TLS code unchanged.
const config=loadConfig({HOST:'127.0.0.1',PORT:'3117',APP_ORIGIN:'http://127.0.0.1:3117',
 TRADE_FAIR_ACCESS_KEY:'live01-form-local-only',DASHBOARD_ACCESS_KEY:'live01-admin-local-only',
 SESSION_SECRET:'live01-isolated-synthetic-session-secret-32',N8N_HEADER_KEY:s.header,
 DASHBOARD_ENABLED:'true',DASHBOARD_DATABASE_URL:connectionString,MESSE_CRM_ENABLED:'true',
 PUBLIC_FORM_ENABLED:'false',N8N_CAPTURE_URL:upstream+'/webhook/trade-fair/lead',
 N8N_STATUS_URL:upstream+'/webhook/trade-fair/status',N8N_AI_ALLOWED_ORIGIN:upstream,
 N8N_AI_EXTRACT_URL:upstream+'/webhook/messe-hub/ai-extract',N8N_AI_ASK_URL:upstream+'/webhook/messe-hub/ai-ask'});
let dropNextCapture=false;const events=[];
const server=createGateway(config,{dashboardStore:createDashboardDb({connectionString,poolFactory:factory}),crmStore:createDashboardCrm({connectionString,poolFactory:factory}),fetchImpl:async(url,init)=>{
 if(new URL(url).origin!==upstream)throw Error('Integration forbids non-isolated upstream');
 const r=await fetch(url,init); // actual network execution, never a fabricated workflow response
 const path=new URL(url).pathname;const event={at:new Date().toISOString(),path,http:r.status};
 if(path==='/webhook/trade-fair/lead'){
  event.bodySha256=createHash('sha256').update(init.body).digest('hex');
  event.submissionId=JSON.parse(init.body).submission_id;
 }
 events.push(event);
 if(path==='/webhook/trade-fair/lead'&&dropNextCapture&&r.ok){dropNextCapture=false;await r.arrayBuffer();event.droppedReceipt=true;throw Error('Intentional isolated lost receipt after actual n8n commit');}
 return r;
}});
server.listen(3117,'127.0.0.1');
const control=http.createServer((req,res)=>{
 if(req.method==='POST'&&req.url==='/fault/drop-next-capture-receipt'){dropNextCapture=true;res.end('armed');return;}
 if(req.method==='GET'&&req.url==='/evidence'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(events));return;}
 res.writeHead(404);res.end();
});control.listen(3118,'127.0.0.1');
s.gatewayPort=3117;s.controlPort=3118;await writeFile(statePath,JSON.stringify(s,null,2),{mode:0o600});
console.log('LIVE01 isolated Gateway ready on 127.0.0.1:3117; actual n8n upstream only');
const stop=()=>{server.closeAllConnections();server.close();control.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
