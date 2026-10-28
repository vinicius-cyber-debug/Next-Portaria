import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';
import {historyWindow} from '../lib/state-sync.ts';
import {testSession} from './fixture-auth.mjs';

class D1 {
  executed=[];
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));}
  prepare(sql){const db=this;return {sql,params:[],bind(...params){return {...this,params}},async first(){db.executed.push(this.sql);return db.sqlite.prepare(this.sql).get(...this.params)??null},async all(){db.executed.push(this.sql);return {results:db.sqlite.prepare(this.sql).all(...this.params),success:true}},async run(){db.executed.push(this.sql);const result=db.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}}}}}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(statement=>{this.executed.push(statement.sql);return {results:this.sqlite.prepare(statement.sql).all(...statement.params),success:true}});this.sqlite.exec('COMMIT');return result}catch(error){this.sqlite.exec('ROLLBACK');throw error}}
}
const origin='https://porto.example.test',owner={id:'sync-owner',name:'Administradora',email:'sync-owner@example.test'};
let commandKey=0;
async function call(db,path,method='GET',body,user=owner){
  const headers={cookie:testSession(db,user)};if(method!=='GET'){headers.origin=origin;headers['content-type']='application/json'}
  const response=await handleApi(new Request(origin+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),db);
  return {status:response.status,body:await response.json()};
}
async function setup(t){const db=new D1();t.after(()=>db.sqlite.close());assert.equal((await call(db,'/session')).status,200);return db}
async function snapshot(db,user=owner){const response=await call(db,'/state','GET',undefined,user);assert.equal(response.status,200,JSON.stringify(response.body));return response.body}
async function command(db,type,payload){const revision=(await snapshot(db)).revision,result=await call(db,'/commands','POST',{type,payload,revision,idempotencyKey:'sync-integration-'+(++commandKey)});assert.equal(result.status,200,JSON.stringify(result.body));return result.body}
function seed(db,collection,row){db.sqlite.prepare('INSERT INTO operational_records(collection,id,body) VALUES(?,?,?)').run(collection,row.id,JSON.stringify(row));return row}
function audit(db,row){db.sqlite.prepare('INSERT INTO operational_audit(id,at,body) VALUES(?,?,?)').run(row.id,row.at,JSON.stringify(row))}
function visit(id,status,at,extra={}){return {id,status,personId:'person-'+id,name:'Pessoa '+id,company:'Empresa de teste',host:'Responsável',purpose:'Homologação',requestedAt:at,expectedAt:at,validUntil:at,documentLast4:'4321',...extra}}
function addChange(db,body){const revision=Number(db.sqlite.prepare('SELECT revision FROM operational_meta WHERE id=1').get().revision)+1;db.sqlite.prepare('INSERT INTO operational_changes(revision,created_at,body) VALUES(?,?,?)').run(revision,new Date().toISOString(),JSON.stringify(body));db.sqlite.prepare('UPDATE operational_meta SET revision=? WHERE id=1').run(revision);return revision}
function readsOperationalHistory(sql){return /\bFROM\s+operational_(records|audit)\b/i.test(sql)}
function member(db,role='reader',overrides={}){const user={id:'sync-'+role,name:role,email:'sync-'+role+'@example.test'};testSession(db,user);db.sqlite.prepare("UPDATE operational_users SET role=?,status='active' WHERE id=?").run(role,user.id);db.sqlite.prepare('INSERT INTO operational_access(user_id,body) VALUES(?,?)').run(user.id,JSON.stringify(overrides));return user}

test('janela de 30 dias exclui encerrados antigos e preserva todos os abertos, inclusive ocorrência in_progress',async t=>{
  const db=await setup(t),cutoff=historyWindow().since,old=new Date(Date.parse(cutoff)-1).toISOString(),recent=new Date(Date.parse(cutoff)+1).toISOString();
  for(const status of ['pending','authorized','inside','completed'])seed(db,'visitors',visit('old-'+status,status,old));
  seed(db,'visitors',visit('recent-closed','completed',recent));
  for(const [collection,field,active,closed] of [['vehicles','entryAt','inside','completed'],['stays','start','active','completed'],['charges','createdAt','partial','paid'],['incidents','createdAt','in_progress','closed'],['reservations','start','confirmed','cancelled'],['emergencyRollCalls','startedAt','open','closed']]){
    seed(db,collection,{id:collection+'-active',status:active,[field]:old});seed(db,collection,{id:collection+'-closed',status:closed,[field]:old});
  }
  seed(db,'people',{id:'old-person',name:'Cadastro antigo',updatedAt:old});seed(db,'personRequirements',{id:'old-requirement',personId:'old-person',name:'Integração',status:'pending',areaIds:[],reviewedAt:old,updatedAt:old});
  for(let index=0;index<110;index++)audit(db,{id:'history-audit-'+index,at:new Date(Date.now()-1000-index).toISOString(),action:'TEST',entity:'visitor'});
  const current=await snapshot(db);assert.equal(current.state.historyWindow.since,cutoff);assert.equal(current.state.historyWindow.complete,false);assert.equal(current.state.historyWindow.days,30);
  assert.deepEqual(new Set(current.state.visitors.map(row=>row.id)),new Set(['old-pending','old-authorized','old-inside','recent-closed']));
  for(const collection of ['vehicles','incidents','emergencyRollCalls'])assert.deepEqual(current.state[collection].map(row=>row.id),[collection+'-active'],collection);
  for(const collection of ['stays','charges','reservations'])assert.deepEqual(current.state[collection],[],collection);
  assert.equal(current.state.people[0].id,'old-person');assert.equal(current.state.personRequirements[0].id,'old-requirement');assert.equal(current.state.audit.length,100);
});

test('records consulta o histórico anterior à janela, ordena e pagina sem repetir ou omitir registros',async t=>{
  const db=await setup(t),base=Date.parse(historyWindow().since)-100*86400000;
  for(let index=0;index<45;index++)seed(db,'visitors',visit('history-'+String(index).padStart(2,'0'),'completed',new Date(base+index*1000).toISOString(),{areaId:index%2?'area-b':'area-a',category:'supplier',gateName:'Portaria principal'}));
  assert.equal((await snapshot(db)).state.visitors.length,0);
  const pages=[];for(let page=1;page<=3;page++){const result=await call(db,'/records?collection=visitors&page='+page+'&pageSize=20');assert.equal(result.status,200);assert.equal(result.body.total,45);assert.equal(result.body.totalPages,3);assert.equal(result.body.page,page);pages.push(...result.body.rows)}
  assert.equal(pages.length,45);assert.equal(new Set(pages.map(row=>row.id)).size,45);assert.equal(pages[0].id,'history-44');assert.equal(pages.at(-1).id,'history-00');
  const filtered=await call(db,'/records?collection=visitors&areaId=area-a&category=supplier&gateName=Portaria%20principal&status=completed&company=Empresa&q=Pessoa&pageSize=100');assert.equal(filtered.status,200);assert.equal(filtered.body.total,23);assert.ok(filtered.body.rows.every(row=>row.areaId==='area-a'));
  for(const query of ['page=0','page=-1','page=1.5','pageSize=101','pageSize=0','collection=unknown','from=2026-02-30','from=2026-03-02&to=2026-03-01'])assert.equal((await call(db,'/records?'+query)).status,400,query);
});

test('filtros de data usam a meia-noite do fuso da unidade, com limite final exclusivo',async t=>{
  const db=await setup(t),values=['2020-02-01T03:59:59.999Z','2020-02-01T04:00:00.000Z','2020-02-02T03:59:59.999Z','2020-02-02T04:00:00.000Z'];
  values.forEach((at,index)=>seed(db,'visitors',visit('tz-'+index,'completed',at)));
  const query='/records?collection=visitors&from=2020-02-01&to=2020-02-01&pageSize=100',manaus=await call(db,query);assert.equal(manaus.status,200);assert.deepEqual(manaus.body.rows.map(row=>row.id),['tz-2','tz-1']);
  const setting=JSON.parse(db.sqlite.prepare("SELECT body FROM operational_settings WHERE id='settings'").get().body);setting.timezone='America/Sao_Paulo';db.sqlite.prepare("UPDATE operational_settings SET body=? WHERE id='settings'").run(JSON.stringify(setting));
  const saoPaulo=await call(db,query);assert.equal(saoPaulo.status,200);assert.deepEqual(saoPaulo.body.rows.map(row=>row.id),['tz-1','tz-0']);
});

test('records aplica permissões, retira dados privados e não pesquisa documento oculto',async t=>{
  const db=await setup(t),reader=member(db,'reader',{auditView:true}),now=new Date().toISOString();
  seed(db,'visitors',visit('restricted','completed',now,{email:'segredo@example.test',phone:'559200000000',restrictions:'Documento confidencial'}));
  seed(db,'personRequirements',{id:'private-requirement',personId:'person-restricted',name:'Integração',status:'pending',areaIds:[],reviewedAt:now,notes:'Observação privada'});
  audit(db,{id:'private-file',at:now,entity:'attachment',action:'ATTACHMENT_UPLOAD',detail:'Arquivo confidencial'});
  const visible=await call(db,'/records?collection=visitors','GET',undefined,reader);assert.equal(visible.status,200);assert.equal(visible.body.rows.length,1);assert.doesNotMatch(JSON.stringify(visible.body),/4321|segredo@example|559200000000|Documento confidencial/);
  assert.equal((await call(db,'/records?collection=visitors&q=4321','GET',undefined,reader)).body.total,0);assert.equal((await call(db,'/records?collection=visitors&q=4321')).body.total,1);
  const requirements=await call(db,'/records?collection=personRequirements','GET',undefined,reader);assert.equal(requirements.body.rows[0].notes,undefined);
  const history=await call(db,'/records?collection=audit','GET',undefined,reader);assert.equal(history.status,200);assert.equal(history.body.rows.some(row=>row.id==='private-file'),false);
  for(const collection of ['charges','settlements','tariffHistory']){const retired=await call(db,'/records?collection='+collection,'GET',undefined,reader);assert.equal(retired.status,400,collection);assert.equal(retired.body.error.code,'MODULE_REMOVED');}
  const noAudit=member(db,'gate');assert.equal((await call(db,'/records?collection=audit','GET',undefined,noAudit)).status,403);
});

test('sync sem mudanças responde somente revisão e identidade, sem ler registros ou auditoria',async t=>{
  const db=await setup(t),current=await snapshot(db);db.executed.length=0;
  const result=await call(db,'/sync?since='+current.revision+'&windowSince='+encodeURIComponent(current.state.historyWindow.since));assert.equal(result.status,200);assert.equal(result.body.unchanged,true);assert.equal(result.body.revision,current.revision);assert.equal(result.body.state,undefined);assert.equal(result.body.delta,undefined);assert.equal(result.body.user.id,owner.id);assert.equal(db.executed.some(readsOperationalHistory),false,db.executed.join('\n'));
});

test('sync usa deltas de comandos reais e remove visita antiga ao encerrar sua presença',async t=>{
  const db=await setup(t),before=await snapshot(db),created=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'Empresa do delta'}});db.executed.length=0;
  const change=await call(db,'/sync?since='+before.revision);assert.equal(change.status,200);assert.equal(change.body.state,undefined);assert.equal(change.body.reset,undefined);assert.equal(change.body.delta.collections.companies.upsert[0].id,created.result.id);assert.equal(db.executed.some(readsOperationalHistory),false);
  const now=Date.now(),request=await command(db,'VISITOR_REQUEST',{name:'Pessoa do delta',company:'Empresa do delta',host:'Diretoria',purpose:'Homologação incremental',expectedAt:new Date(now-3600000).toISOString(),validUntil:new Date(now+3600000).toISOString()});
  const id=request.result.id;await command(db,'VISITOR_APPROVE',{id});await command(db,'VISITOR_CHECKIN',{id,identityConfirmed:true});
  const row=JSON.parse(db.sqlite.prepare("SELECT body FROM operational_records WHERE collection='visitors' AND id=?").get(id).body);row.requestedAt=new Date(Date.parse(historyWindow().since)-1000).toISOString();db.sqlite.prepare("UPDATE operational_records SET body=? WHERE collection='visitors' AND id=?").run(JSON.stringify(row),id);
  const inside=await snapshot(db);assert.equal(inside.state.visitors.some(row=>row.id===id),true);const checkout=await command(db,'VISITOR_CHECKOUT',{id});assert.equal(checkout.state.visitors.some(row=>row.id===id),false);
  const removed=await call(db,'/sync?since='+inside.revision);assert.equal(removed.status,200);assert.ok(removed.body.delta.collections.visitors.remove.includes(id));assert.equal(removed.body.delta.collections.visitors.upsert.some(row=>row.id===id),false);
  const fullHistory=await call(db,'/records?collection=visitors&personId='+row.personId);assert.equal(fullHistory.body.rows[0].status,'completed');
});

test('sync agrega revisões e reaplica a redação de documentos e valores ao delta',async t=>{
  const db=await setup(t),reader=member(db,'reader'),current=await snapshot(db,reader);
  addChange(db,{collections:{people:{upsert:[{id:'person-a',name:'Versão anterior',email:'privado@example.test',documentLast4:'9876'}],remove:[]},charges:{upsert:[{id:'private-charge',totalCents:12345}],remove:[]},audit:{upsert:[{id:'private-audit',at:new Date().toISOString(),detail:'Auditoria privada'}],remove:[]}},values:{settings:{unitName:'Porto',dailyRateCents:98765}}});
  addChange(db,{collections:{people:{upsert:[{id:'person-a',name:'Versão atual',email:'atual@example.test',documentLast4:'9876'},{id:'person-b',name:'Pessoa removida'}],remove:[]}},values:{}});
  const revision=addChange(db,{collections:{people:{upsert:[],remove:['person-b']}},values:{}});
  const result=await call(db,'/sync?since='+current.revision,'GET',undefined,reader);assert.equal(result.status,200);assert.equal(result.body.revision,revision);assert.equal(result.body.delta.collections.people.upsert.length,1);assert.equal(result.body.delta.collections.people.upsert[0].name,'Versão atual');assert.deepEqual(result.body.delta.collections.people.remove,['person-b']);assert.equal(result.body.delta.collections.charges,undefined);assert.equal(result.body.delta.collections.audit,undefined);assert.doesNotMatch(JSON.stringify(result.body.delta),/privado@example|atual@example|9876|12345|98765|Auditoria privada/);
});

test('sync reinicia para lacuna, evento nulo, revisão futura, excesso de deltas e troca da janela',async t=>{
  const db=await setup(t);let current=await snapshot(db);
  const gap=await call(db,'/sync?since='+(current.revision-1));assert.equal(gap.status,200);assert.equal(gap.body.reset,true);assert.ok(gap.body.state);
  addChange(db,null);const nullEvent=await call(db,'/sync?since='+current.revision);assert.equal(nullEvent.status,200);assert.equal(nullEvent.body.reset,true);
  current=await snapshot(db);for(const suffix of ['&forceReset=true','&windowSince=2000-01-01T00%3A00%3A00.000Z']){const reset=await call(db,'/sync?since='+current.revision+suffix);assert.equal(reset.status,200);assert.equal(reset.body.reset,true);assert.equal(reset.body.state.historyWindow.since,historyWindow().since)}
  assert.equal((await call(db,'/sync?since='+(current.revision+1))).body.reset,true);
  for(let index=0;index<251;index++)addChange(db,{collections:{},values:{}});
  const excessive=await call(db,'/sync?since='+current.revision);assert.equal(excessive.status,200);assert.equal(excessive.body.reset,true);assert.ok(excessive.body.state);
  for(const since of ['-1','NaN','1.5'])assert.equal((await call(db,'/sync?since='+since)).status,400,since);
});

test('prévia mensal aposentada é rejeitada sem apagar cobranças históricas',async t=>{
  const db=await setup(t),legacy={id:'charge_legacy',client:'Cliente histórico',status:'partial',createdAt:'2020-02-29T12:00:00.000Z',totalCents:600,paidCents:200,balanceCents:400};seed(db,'charges',legacy);
  assert.deepEqual((await snapshot(db)).state.charges,[]);
  for(const user of [owner,member(db,'reader')]){const result=await call(db,'/monthly-preview?client=Cliente&month=2020-02','GET',undefined,user);assert.equal(result.status,400);assert.equal(result.body.error.code,'MODULE_REMOVED');}
  assert.deepEqual(JSON.parse(db.sqlite.prepare("SELECT body FROM operational_records WHERE collection='charges' AND id=?").get(legacy.id).body),legacy);
});