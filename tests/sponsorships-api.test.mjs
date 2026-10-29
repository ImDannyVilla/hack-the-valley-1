import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {createSponsorshipDb,DEMO_USERS} from './helpers/sponsorship-db.mjs';
import {sponsorHash} from '../functions/_lib/domain/sponsorships.js';
async function setup(t) {
  const {db,close}=await createSponsorshipDb();t.after(close);
  for(const [name,userId] of Object.entries(DEMO_USERS)) await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').bind(`session-${name}`,userId,await sponsorHash(`token-${name}`),'2026-01-01','2099-01-01').run();
  return {HTV_DB:db,SPONSORSHIP_REMINDERS_MODE:'preview',HTV_AUTH_DEV_MODE:'local'};
}
function req(path='', {user='danny',method='GET',body,headers={}}={}) {
  return new Request(`http://localhost:8788/api/admin/sponsorships${path}`,{method,headers:{...(user?{cookie:`htv_session=token-${user}`}:{ }),...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{}),...headers},body:body?JSON.stringify(body):undefined});
}
test('sponsorship API requires session admin including inbox and media',async t=>{
  const env=await setup(t);
  for(const path of ['', '/contacts','/motions/unknown/logo','/reminders']){
    assert.equal((await worker.fetch(req(path,{user:null}),env)).status,401,path);
    assert.equal((await worker.fetch(req(path,{user:'member'}),env)).status,403,path);
  }
  for(const user of ['danny','alex'])assert.equal((await worker.fetch(req('',{user}),env)).status,200);
  assert.equal((await worker.fetch(req('',{user:null,headers:{Authorization:'Bearer recovery'}}),{...env,HTV_ADMIN_TOKEN:'recovery',HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED:'1'})).status,403);
});
test('organizer-only and event-scoped admin roles cannot access sponsorship reads or writes',async t=>{
  const env=await setup(t);
  await env.HTV_DB.prepare("INSERT INTO roles(id,user_id,role,scope_type,scope_id,created_at) VALUES('scoped-test-role',?,'organizer','global','*',?)").bind(DEMO_USERS.member,new Date().toISOString()).run();
  for(const role of ['global organizer','event admin']) {
    if(role==='event admin') await env.HTV_DB.prepare("UPDATE roles SET role='admin',scope_type='event',scope_id='hack-the-valley-2026' WHERE id='scoped-test-role'").run();
    for(const path of ['/contacts','/motions/unknown/logo','/reminders']) {
      assert.equal((await worker.fetch(req(path,{user:'member'}),env)).status,403,`${role}: ${path}`);
    }
    assert.equal((await worker.fetch(req('/contacts',{user:'member',method:'POST',body:{business_name:'Unauthorized prospect'}}),env)).status,403,`${role}: contact mutation`);
  }
  assert.equal((await env.HTV_DB.prepare('SELECT COUNT(*) AS n FROM sponsor_contacts').first()).n,0);
});
test('authorization is checked again before replaying a successful mutation',async t=>{
  const env=await setup(t),headers={'Idempotency-Key':'revoke-retry-test'};
  let response=await worker.fetch(req('/contacts',{method:'POST',body:{business_name:'Acme'},headers}),env);
  assert.equal(response.status,201);
  await env.HTV_DB.prepare('UPDATE roles SET revoked_at=? WHERE user_id=?').bind(new Date().toISOString(),DEMO_USERS.danny).run();
  response=await worker.fetch(req('/contacts',{method:'POST',body:{business_name:'Acme'},headers}),env);
  assert.equal(response.status,403);
});
test('API rejects cross-origin writes and missing retry keys, returns private paginated data',async t=>{
  const env=await setup(t);
  assert.equal((await worker.fetch(req('/contacts',{method:'POST',body:{business_name:'Acme'},headers:{Origin:'https://other.example'}}),env)).status,403);
  assert.equal((await worker.fetch(req('/contacts',{method:'POST',body:{business_name:'Acme'},headers:{'Idempotency-Key':''}}),env)).status,400);
  const added=await worker.fetch(req('/contacts',{method:'POST',body:{business_name:'Acme'}}),env);assert.equal(added.status,201);
  const result=await worker.fetch(req('/contacts?limit=1&offset=0'),env);
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  const data=await result.json();assert.equal(data.count,1);assert.equal(data.items[0].business_name,'Acme');
});

import {sponsorshipFixtureSql} from '../scripts/sponsorship-fixtures.mjs';
test('scheduled worker captures overdue sponsorship previews',async t=>{
 const env=await setup(t);
 await env.HTV_DB.exec(sponsorshipFixtureSql(new Date('2026-09-24T16:00:00Z')));
 const prepare=env.HTV_DB.prepare.bind(env.HTV_DB);
 env.RESEND_API_KEY='test-only-no-network';
 const log=console.error;console.error=()=>{};try{await worker.scheduled({scheduledTime:Date.parse('2026-09-24T16:00:00Z')},env);}finally{console.error=log;}
 assert.equal((await prepare('SELECT COUNT(*) AS n FROM sponsorship_reminder_digests').first()).n,2);
});
