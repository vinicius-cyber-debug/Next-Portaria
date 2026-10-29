import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../demo/api.mjs';
import { createDemoSeed } from '../demo/seed.mjs';
import { validateState } from '../lib/domain.mjs';
import { request, setRequestTransport } from '../lib/http-client.ts';

const now=()=>new Date().toISOString();
const api=()=>createDemoApi({now});
const post=(transport,path,body)=>transport.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('demonstração usa um estado sintético válido com acesso, pessoas, veículos e ocorrências',()=>{
  const state=createDemoSeed(now());
  assert.doesNotThrow(()=>validateState(state));
  assert.ok(state.visitors.some(visit=>visit.status==='inside'));
  assert.ok(state.visitors.some(visit=>visit.status==='pending'));
  assert.ok(state.visitors.some(visit=>visit.status==='authorized'));
  assert.ok(state.vehicles.some(vehicle=>vehicle.status==='inside'));
  assert.ok(state.incidents.length>=3);
  assert.equal(state.stays.length+state.charges.length,0);
});

test('operações de demonstração são temporárias e não alteram outra sessão',async()=>{
  const first=api(),second=api(),snapshot=await (await first.request('/api/state')).json();
  const before=snapshot.state.companies.length;
  const result=await post(first,'/api/commands',{type:'MASTER_SAVE',payload:{kind:'companies',record:{name:'Empresa temporária (fictícia)'}},revision:snapshot.revision,idempotencyKey:'demo-company-test'});
  assert.equal(result.status,200);
  assert.equal((await result.json()).state.companies.length,before+1);
  assert.equal((await (await second.request('/api/state')).json()).state.companies.length,before);
  first.reset();
  assert.equal((await (await first.request('/api/state')).json()).state.companies.length,before);
});

test('transporte da demo nunca usa rede e rejeita contas, arquivos e destinos externos',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Não pode haver rede na demonstração.');};
  const demo=api();setRequestTransport(demo.request);
  try {
    assert.equal((await request('/api/session')).status,200);
    for(const path of ['/api/unknown','/api/backup','https://production.example.test/api/state','https://example.test/pixel'])assert.ok((await request(path)).status>=400,path);
    for(const path of ['/api/auth/login','/api/auth/logout','/api/auth/change-password','/api/restore','/api/users','/api/attachments'])assert.ok((await request(path,{method:'POST',body:'{}'})).status>=400,path);
    assert.equal(calls,0);
  }finally{setRequestTransport();globalThis.fetch=original;}
});

test('histórico da demo é paginado e filtros não repetem registros',async()=>{
  const demo=api(),one=await (await demo.request('/api/records?collection=visitors&page=1&pageSize=3')).json(),two=await (await demo.request('/api/records?collection=visitors&page=2&pageSize=3')).json();
  assert.equal(one.rows.length,3);assert.equal(two.rows.length,3);
  assert.equal(new Set([...one.rows,...two.rows].map(row=>row.id)).size,6);
  const inside=await (await demo.request('/api/records?collection=visitors&status=inside')).json();
  assert.ok(inside.rows.length>0);assert.ok(inside.rows.every(row=>row.status==='inside'));
  assert.equal((await demo.request('/api/records?collection=charges')).status,400);
});

test('demo respeita revisão, idempotência e conferência de identidade do domínio',async()=>{
  const demo=api(),snapshot=await (await demo.request('/api/state')).json(),visit=snapshot.state.visitors.find(row=>row.status==='authorized');
  const body={type:'VISITOR_CHECKIN',payload:{id:visit.id},revision:snapshot.revision,idempotencyKey:'demo-entry-test'};
  assert.equal((await (await post(demo,'/api/commands',body)).json()).error.code,'IDENTITY_REQUIRED');
  body.payload.identityConfirmed=true;
  const changed=await (await post(demo,'/api/commands',body)).json();
  assert.equal(changed.state.visitors.find(row=>row.id===visit.id).status,'inside');
  const repeated=await (await post(demo,'/api/commands',body)).json();assert.equal(repeated.revision,changed.revision);
  const stale=await post(demo,'/api/commands',{...body,idempotencyKey:'demo-other-command'});assert.equal(stale.status,409);
  const other=await (await post(demo,'/api/commands',{type:'MASTER_SAVE',payload:{kind:'companies',record:{name:'Alteração posterior (fictícia)'}},revision:changed.revision,idempotencyKey:'demo-new-company'})).json();
  const replay=await (await post(demo,'/api/commands',body)).json();
  assert.equal(replay.revision,other.revision);
  assert.ok(replay.state.companies.some(company=>company.name==='Alteração posterior (fictícia)'));
});
