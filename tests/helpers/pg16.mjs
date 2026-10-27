import { execFile as rawExec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from '../../gateway/node_modules/pg/lib/index.js';
const exec = promisify(rawExec);
const root = new URL('../../', import.meta.url);
export const ids = Array.from({length:8},(_,i)=>`FAIR-00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
export async function startPg16() {
 const name = 'wbs-r2-test-' + randomUUID().slice(0,8);
 const run = (args) => exec('docker',args,{maxBuffer:8*1024*1024});
 let pool;
 const close=async()=>{await pool?.end(); await run(['rm','-f',name]);};
 try {
  await run(['run','-d','--rm','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_USER=neondb_owner','-e','POSTGRES_PASSWORD=synthetic-local-only','-e','POSTGRES_DB=neondb','postgres:16-alpine']);
  const {stdout}=await run(['port',name,'5432']);
  const port=Number(stdout.trim().split(':').at(-1));
  pool=new pg.Pool({host:'127.0.0.1',port,user:'neondb_owner',password:'synthetic-local-only',database:'neondb',max:8});
  let ready=false;
  for(let i=0;i<80;i++){try{await pool.query('SELECT 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}
  if(!ready)throw Error('PG16 did not start');
  const version=(await pool.query('SHOW server_version')).rows[0].server_version;
  if(!version.startsWith('16.'))throw Error('Test requires PG16');
  await pool.query("CREATE SCHEMA trade_fair; CREATE ROLE trade_fair_dashboard LOGIN PASSWORD 'synthetic-local-only'; GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;");
  await pool.query(await readFile(new URL('sql/dashboard_confirmed_ddl.sql',root),'utf8'));
  await pool.query(await readFile(new URL('sql/dashboard_snapshot_definition.sql',root),'utf8'));
  await pool.query('REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;');
  await pool.query(`INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized) VALUES('11111111-1111-4111-8111-111111111111','Synthetic Company','synthetic company');
   INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic Person','synthetic@example.test');`);
  for (const id of ids) await pool.query(`INSERT INTO trade_fair.lead_submissions(lead_id,source,submission_id,company_id,contact_id,duplicate_status,raw_payload,normalized_payload,receipt,wf_b_payload,created_at) VALUES($1,'internal_form',$2,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','POSSIBLE_DUPLICATE','{}',$3,'{}','{}',now())`,[id,'synthetic-'+id,JSON.stringify({notes:'PRIVATE SYNTHETIC NOTE',budget_status:'planned',training_interest:'ai_automation',follow_up:'within_one_week'})]);
  const psql = async (path,variables=[]) => {
   const content=await readFile(new URL(path,root),'utf8');
   // psql meta commands and transaction guards are tested without rewriting SQL.
   return await new Promise((resolve,reject)=>{
    const child=rawExec('docker',['exec','-i',name,'psql','-X','-U','neondb_owner','-d','neondb',...variables],{maxBuffer:8*1024*1024},(err,stdout,stderr)=>err?reject(Object.assign(err,{stdout,stderr})):resolve({stdout,stderr}));child.stdin.end(content);
   });
  };
  await psql('sql/production/dashboard_crm_v1_up.sql',['-v','production_branch_confirmed=on']);
  await pool.query("CREATE ROLE synthetic_context_login LOGIN PASSWORD 'synthetic-local-only'; GRANT trade_fair_ai_context TO synthetic_context_login;");
  const rolePool=(role)=>new pg.Pool({host:'127.0.0.1',port,user:role==='trade_fair_ai_context'?'synthetic_context_login':role,password:'synthetic-local-only',database:'neondb',max:6});
  return {pool,rolePool,psql,version,close,name,port};
 } catch(e){await close();throw e;}
}
