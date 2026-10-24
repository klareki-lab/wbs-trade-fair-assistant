import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parseDashboardQuery,makeDashboardHandler} from '../gateway/dashboard-api.mjs';
import {createDashboardDb,DASHBOARD_SQL} from '../gateway/dashboard-db.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const L='FAIR-797b1f1c-a657-4c7d-829f-1df50f5fc8b2';
const payload={total:1,as_of:'2026-10-24T10:00:00Z',stats:{total:1,hot:0,warm:1,cold:0,unscored:0,duplicates:0,failed:0,email_attention:0,scored_average:45,today:0},leads:[{lead_id:L,company:'Fixture GmbH',score_band:'WARM',score_total:45,email_status:'delivered',ai_extraction:{summary:{value:'fixture'}},company_research:{identity_status:'unverified'},duplicate_status:'NEW',processing_status:'completed'}]};
const opts=()=>parseDashboardQuery(new URLSearchParams());
test('default pagination bounded and stable',()=>{assert.deepEqual(opts(),{page:1,limit:50,offset:0,search:'',band:'',processing:'',email:'',duplicate:'',sort:'created',direction:'desc'});});
test('valid filter, pagination and sort',()=>{assert.deepEqual(parseDashboardQuery(new URLSearchParams('page=3&limit=25&band=WARM&processing=completed&email=delivered&duplicate=yes&sort=score&direction=asc&search=GmbH')).offset,50)});
for(const invalid of ['page=0','page=-1','page=NaN','limit=101','page=10001','sort=score%3BDROP','band=UNKNOWN','email=success','processing=running','duplicate=maybe','direction=random','newflag=1','page=1&page=2','search='+('x'.repeat(121))])test('reject malformed query '+invalid.slice(0,35),()=>{assert.throws(()=>parseDashboardQuery(new URLSearchParams(invalid)),RangeError)});
test('WARM 45 and real delivery status survive contract validation',async()=>{
 const out=await makeDashboardHandler(async()=>payload)(opts());assert.equal(out.leads[0].score_band,'WARM');assert.equal(out.leads[0].score_total,45);assert.equal(out.leads[0].email_status,'delivered');assert.equal(out.read_only,true);
});
test('never fabricate empty results on storage failure',async()=>{await assert.rejects(makeDashboardHandler(async()=>{throw Error('DB unavailable')})(opts()),/DB unavailable/)});
for(const broken of [null,{...payload,leads:[{lead_id:'x'}]},{...payload,total:-1},{...payload,leads:new Array(51).fill(payload.leads[0])}])test('reject malformed PG result',async()=>{await assert.rejects(makeDashboardHandler(async()=>broken)(opts()))});
test('PG adapter uses only read-only SQL/parameters/verified TLS',async()=>{
 const calls=[];let poolOpts;
 const client={query:async(sql,params)=>{calls.push([sql,params]);return sql===DASHBOARD_SQL?{rows:[{payload}]}:{rows:[]}},release:()=>{calls.push(['release'])}};
 const db=createDashboardDb({connectionString:'postgresql://test:test@localhost/neondb',poolFactory:o=>{poolOpts=o;return{connect:async()=>client,end:async()=>{}}}});
 assert.equal((await db.query(opts())).leads[0].score_total,45);
 assert.equal(calls[0][0],'BEGIN READ ONLY');assert.match(calls[1][0],/^SET LOCAL statement_timeout/);
 assert.equal(calls[2][0],DASHBOARD_SQL);assert.equal(calls[2][1].length,9);assert.equal(calls[3][0],'COMMIT');
 assert.deepEqual(poolOpts.ssl,{rejectUnauthorized:true});assert.equal(poolOpts.max,3);
 await db.close();
});
test('idle PostgreSQL pool error does not terminate Gateway',async()=>{
 const pool=new EventEmitter();
 pool.connect=async()=>({query:async sql=>sql===DASHBOARD_SQL?{rows:[{payload}]}:{rows:[]},release(){}});
 pool.end=async()=>{};
 const db=createDashboardDb({connectionString:'postgresql://test:test@localhost/neondb',poolFactory:()=>pool});
 await db.query(opts());
 assert.doesNotThrow(()=>pool.emit('error',new Error('synthetic database disconnect')));
 await db.close();
});
test('SQL statement remains fixed and user text is bound, never interpolated',async()=>{
 let executed;const client={query:async(sql,params)=>{if(sql===DASHBOARD_SQL){executed=[sql,params];return{rows:[{payload}]}}return{rows:[]}},release(){}};
 const db=createDashboardDb({connectionString:'postgres://fixture:x@localhost/neondb',poolFactory:()=>({connect:async()=>client,end:async()=>{}})});
 const input=parseDashboardQuery(new URLSearchParams('search=Robert%27%29%3BDROP%20TABLE%20x%3B--'));await db.query(input);
 assert(!executed[0].includes('DROP TABLE'));assert.match(executed[1][2],/DROP TABLE/);
});
test('SQL migration and browser carry no write endpoint or embedded credentials',async()=>{
 const files=await Promise.all(['web/Messe-Admin-Hub.html','web/dashboard.js','web/dashboard.css'].map(f=>readFile(path.join(root,f),'utf8')));
 const txt=files.join('\n');for(const forbidden of ['n8n.poljanzew.app','Basic Auth','n8nUrl','__PASSWORT__','data-chat','/webhook/','Authorization: Basic'])assert(!txt.includes(forbidden),forbidden);
 assert.match(txt,/api\/dashboard/);assert.match(txt,/\/api\/logout/);assert(!/localStorage|sessionStorage/.test(txt));
 const sql=await readFile(path.join(root,'sql/dashboard_snapshot.sql'),'utf8');
 const definition=await readFile(path.join(root,'sql/dashboard_snapshot_definition.sql'),'utf8');
 assert.match(definition,/SECURITY DEFINER/);assert.match(sql,/REVOKE ALL ON FUNCTION/);assert.match(sql,/GRANT EXECUTE ON FUNCTION/);
 assert(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(definition));
 assert(!/\b(DELETE FROM|UPDATE trade_fair|INSERT INTO|TRUNCATE)\b/i.test(sql+definition));
});
