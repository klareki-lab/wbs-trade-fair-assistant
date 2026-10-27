import test from 'node:test';
import assert from 'node:assert/strict';
import {startPg16,ids} from '../helpers/pg16.mjs';
let db, dashboard;
test.before(async()=>{db=await startPg16();dashboard=db.rolePool('trade_fair_dashboard'); console.log('PostgreSQL',db.version,'confirmed DDL + original R2 UP applied');});
test.after(async()=>{await dashboard?.end();await db?.close();});
const call=async(name,args,client=dashboard)=> (await client.query(`SELECT trade_fair.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result;
const merge=(xs=ids.slice(0,2),client=dashboard)=>call('crm_group_merge',[JSON.stringify(xs),'Synthetic merge','test',null],client);
const reset=()=>db.pool.query('TRUNCATE trade_fair.lead_group_audit,trade_fair.lead_group_members,trade_fair.lead_groups RESTART IDENTITY CASCADE');
const state=async()=> (await db.pool.query(`SELECT jsonb_build_object('groups',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY group_id),'[]') FROM trade_fair.lead_groups g),'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY group_id,lead_id),'[]') FROM trade_fair.lead_group_members m),'audit',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY event_no),'[]') FROM trade_fair.lead_group_audit a)) AS s`)).rows[0].s;
const invariant=async()=>assert.equal((await db.pool.query('SELECT lead_id FROM trade_fair.lead_group_members WHERE removed_at IS NULL GROUP BY lead_id HAVING count(*)>1')).rowCount,0);
test('PG16: strict invalid arrays reject atomically, including duplicate, null, wrong types, missing IDs',async()=>{
 await reset();
 for(const bad of [null,{},42,'bad',[],[null],[1],[{}],['FAIR-short'],[ids[0],'bad',ids[1]],[ids[0],ids[0]],[...ids, ...ids],['FAIR-00000000-0000-4000-8000-999999999999',ids[0]]]){
  const before=await state();const r=await call('crm_group_merge',[JSON.stringify(bad),'valid','test',null]);assert.equal(r.ok,false,JSON.stringify(bad));assert.deepEqual(await state(),before);
 }
});
test('PG16: merge and ignore inverse preserve base leads, audit and prior state',async()=>{
 for(const action of ['merge','ignore']){
  await reset();const r=await call('crm_group_'+action,[JSON.stringify(ids.slice(0,2)),'Synthetic','test',null]);assert.equal(r.ok,true);
  const reverted=await call('crm_group_revert',[r.audit_id,'other-session',null]);assert.equal(reverted.ok,true);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM trade_fair.lead_group_members WHERE removed_at IS NULL')).rows[0].n,0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM trade_fair.lead_group_audit')).rows[0].n,2);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM trade_fair.lead_submissions')).rows[0].n,8);
  const before=await state();assert.equal((await call('crm_group_revert',[r.audit_id,'test',null])).error_code,'ALREADY_REVERTED');assert.deepEqual(await state(),before);
 }
});
test('PG16: split and extract revert restore EXACT original membership (including source group)',async()=>{
 for(const action of ['split','extract']){
  await reset();const first=await merge();const prior=(await state());
  const args=action==='extract'?[first.group_id,ids[0],'test',null]:[first.group_id,'test',null];
  const r=await call('crm_group_'+action,args);assert.equal(r.ok,true);
  assert.equal((await call('crm_group_revert',[r.audit_id,'test',null])).ok,true);
  const after=await state();assert.deepEqual(after.members.filter(m=>m.group_id===first.group_id),prior.members);
  assert.deepEqual(after.groups.find(g=>g.group_id===first.group_id),prior.groups[0]);await invariant();
 }
});
test('PG16: stale merge/split/extract undo fails without any DML or audit',async()=>{
 await reset();const a=await merge();const s=await call('crm_group_split',[a.group_id,'test',null]);await merge([ids[0],ids[2]]);
 for(const audit of [a.audit_id,s.audit_id]){const before=await state();assert.equal((await call('crm_group_revert',[audit,'test',null])).error_code,'STALE_REVERT');assert.deepEqual(await state(),before);}
 await reset();const g=await merge();const e=await call('crm_group_extract',[g.group_id,ids[0],'test',null]);await call('crm_group_split',[e.group_id,'test',null]);
 const before=await state();assert.equal((await call('crm_group_revert',[e.audit_id,'test',null])).error_code,'STALE_REVERT');assert.deepEqual(await state(),before);await invariant();
});
test('PG16: grouped merge/ignore conflicts leave all state unchanged',async()=>{
 await reset();await merge();
 for(const action of ['merge','ignore']){const before=await state();assert.equal((await call('crm_group_'+action,[JSON.stringify([ids[0],ids[2]]),'conflict','test',null])).error_code,'MEMBERSHIP_CONFLICT');assert.deepEqual(await state(),before);}
});
test('PG16: simultaneous merge/ignore, split/extract, duplicate revert serialize across real sessions',async()=>{
 const c1=await dashboard.connect(),c2=await dashboard.connect();
 try{
  for(const actions of [['merge','merge'],['merge','ignore']]){
   await reset();await c1.query('BEGIN');const first=await merge(ids.slice(0,2),c1);assert.equal(first.ok,true);
   let finished=false;const second=call('crm_group_'+actions[1],[JSON.stringify(ids.slice(0,2)),'race','test',null],c2).then(r=>{finished=true;return r;});
   await new Promise(r=>setTimeout(r,150));assert.equal(finished,false,'second transaction must wait');await c1.query('COMMIT');assert.equal((await second).error_code,'MEMBERSHIP_CONFLICT');await invariant();
  }
  await reset();const g=await merge();await c1.query('BEGIN');const split=await call('crm_group_split',[g.group_id,'test',null],c1);
  const extracting=call('crm_group_extract',[g.group_id,ids[0],'test',null],c2);await c1.query('COMMIT');assert.equal((await extracting).error_code,'UNKNOWN_OR_INACTIVE_GROUP');
  await c1.query('BEGIN');assert.equal((await call('crm_group_revert',[split.audit_id,'test',null],c1)).ok,true);
  const reverting=call('crm_group_revert',[split.audit_id,'test',null],c2);await c1.query('COMMIT');assert.equal((await reverting).error_code,'ALREADY_REVERTED');await invariant();
 }finally{await c1.query('ROLLBACK');c1.release();c2.release();}
});
test('PG16: audit persists and available undo survives a new role connection',async()=>{
 await reset();const g=await merge();const fresh=db.rolePool('trade_fair_dashboard');
 try{const list=await call('crm_groups_snapshot',[25,0,false,0],fresh);assert.equal(list.audit[0].audit_id,g.audit_id);assert.equal(list.audit[0].can_revert,true);assert.equal((await call('crm_group_revert',[g.audit_id,'new-login',null],fresh)).ok,true);}finally{await fresh.end();}
});
test('PG16: ACL denies direct tables, helper functions, PUBLIC and AI writes; scoped context omits PII',async()=>{
 const ai=db.rolePool('trade_fair_ai_context');
 try{
  for(const sql of ['SELECT * FROM trade_fair.lead_submissions','SELECT * FROM trade_fair.lead_group_audit','INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES(\'x\',\'active\',\'x\')','SELECT trade_fair._crm_validate_lead_ids(\'[]\')'])await assert.rejects(dashboard.query(sql),{code:'42501'});
  await assert.rejects(ai.query(`SELECT trade_fair.crm_group_merge('[]','x','x',null)`),{code:'42501'});
  await assert.rejects(ai.query('SELECT * FROM trade_fair.contacts'),{code:'42501'});
  await assert.rejects(dashboard.query('CREATE TABLE trade_fair.unauthorized_test(x int)'),{code:'42501'});
  const direct = await dashboard.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')`);assert.equal(direct.rowCount,0);
  const privateExec = await dashboard.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname LIKE '_crm_%' AND has_function_privilege(current_user,p.oid,'EXECUTE')`);assert.equal(privateExec.rowCount,0);
  await assert.rejects(ai.query(`SELECT trade_fair.dashboard_snapshot(1,0,'','','','','','created','desc')`),{code:'42501'});
  const context=await call('ai_lead_context',[JSON.stringify([ids[7]])],ai);assert.equal(context.context.length,1);assert.equal(context.context[0].lead_id,ids[7]);assert.equal(context.context[0].budget_status,'planned');
  assert(!/Synthetic Person|synthetic@example|PRIVATE|company|contact|notes|phone|normalized_payload/.test(JSON.stringify(context)));
  for(const bad of [[],{},[ids[0],ids[0]],['FAIR-00000000-0000-4000-8000-999999999999']])await assert.rejects(call('ai_lead_context',[JSON.stringify(bad)],ai),{code:'22023'});
  const publicGrants=await db.pool.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND (p.proname LIKE 'crm_%' OR p.proname LIKE '_crm_%' OR p.proname='ai_lead_context') AND has_function_privilege('public',p.oid,'EXECUTE')`);assert.equal(publicGrants.rowCount,0);
 }finally{await ai.end();}
});
test('PG16: migration refuses rerun and missing Owner gate; safe DOWN retains all CRM state',async()=>{
 const before=await state();await assert.rejects(db.psql('sql/production/dashboard_crm_v1_up.sql'));
 await assert.rejects(db.psql('sql/production/dashboard_crm_v1_up.sql',['-v','production_branch_confirmed=on']));assert.deepEqual(await state(),before);
 await db.psql('sql/production/dashboard_crm_v1_down.sql');assert.deepEqual(await state(),before);
});

test('PG16: extracting the only member retires source, then undo restores it; direct duplicate insert is constrained',async()=>{
 await reset();const g=await merge();const e1=await call('crm_group_extract',[g.group_id,ids[0],'test',null]);assert.equal(e1.ok,true);
 const prior=await state();const e2=await call('crm_group_extract',[g.group_id,ids[1],'test',null]);assert.equal(e2.ok,true);
 assert.equal((await db.pool.query('SELECT status FROM trade_fair.lead_groups WHERE group_id=$1',[g.group_id])).rows[0].status,'retired');
 assert.equal((await call('crm_group_revert',[e2.audit_id,'test',null])).ok,true);
 assert.deepEqual((await state()).members.filter(m=>m.group_id===g.group_id),prior.members.filter(m=>m.group_id===g.group_id));
 await assert.rejects(db.pool.query('INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by) VALUES($1,$2,$3)',[e2.group_id,ids[0],'owner-test']),{code:'23505'});await invariant();
});
test('PG16: simultaneous extracts and extract versus old merge undo have no partial writes',async()=>{
 await reset();const g=await merge();const a=await dashboard.connect(),b=await dashboard.connect();
 try{
  await a.query('BEGIN');assert.equal((await call('crm_group_extract',[g.group_id,ids[0],'test',null],a)).ok,true);
  const competing=call('crm_group_extract',[g.group_id,ids[0],'test',null],b);await a.query('COMMIT');assert.equal((await competing).error_code,'LEAD_NOT_IN_GROUP');
  const before=await state();assert.equal((await call('crm_group_revert',[g.audit_id,'test',null],b)).error_code,'STALE_REVERT');assert.deepEqual(await state(),before);await invariant();
  await assert.rejects(b.query('SET ROLE neondb_owner'),{code:'42501'});
 }finally{await a.query('ROLLBACK');a.release();b.release();}
});

test('PG16: concurrent newer merge versus old split undo is deterministic in both transaction orders',async()=>{
 const a=await dashboard.connect(),b=await dashboard.connect();
 try{
  for(const order of ['merge-first','undo-first']){
   await reset();const g=await merge();const s=await call('crm_group_split',[g.group_id,'test',null]);
   await a.query('BEGIN');
   if(order==='merge-first'){
    assert.equal((await merge([ids[0],ids[2]],a)).ok,true);
    const undo=call('crm_group_revert',[s.audit_id,'test',null],b);await a.query('COMMIT');assert.equal((await undo).error_code,'STALE_REVERT');
   }else{
    assert.equal((await call('crm_group_revert',[s.audit_id,'test',null],a)).ok,true);
    const merging=merge([ids[0],ids[2]],b);await a.query('COMMIT');assert.equal((await merging).error_code,'MEMBERSHIP_CONFLICT');
   }
   await invariant();assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM trade_fair.lead_group_audit')).rows[0].n,3);
  }
 }finally{await a.query('ROLLBACK');a.release();b.release();}
});

test('PG16: group and audit pagination are independent and deterministic',async()=>{
 await reset();await merge(ids.slice(0,2));await merge(ids.slice(2,4));await merge(ids.slice(4,6));
 const first=await call('crm_groups_snapshot',[1,0,false,0]);const second=await call('crm_groups_snapshot',[1,1,false,1]);
 assert.equal(first.total,3);assert.equal(first.audit_total,3);assert.equal(first.groups.length,1);assert.equal(second.audit.length,1);
 assert.notEqual(first.groups[0].group_id,second.groups[0].group_id);assert.notEqual(first.audit[0].audit_id,second.audit[0].audit_id);
 const auditOnly=await call('crm_groups_snapshot',[1,0,false,1]);assert.equal(auditOnly.groups[0].group_id,first.groups[0].group_id);assert.equal(auditOnly.audit[0].audit_id,second.audit[0].audit_id);
});
