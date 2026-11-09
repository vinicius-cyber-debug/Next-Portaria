import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {parseDirectoryJson,directoryPerson,directoryPhoto,IdSecureReader} from '../lib/integrations/idsecure.ts';
import {mergeDirectory,importDirectory} from '../lib/integrations/directory-import.ts';
import {createInitialState,execute,validateState} from '../lib/domain.mjs';
import {assertVisitEligibility} from '../lib/physical-access.mjs';
import {handleApi} from '../lib/server.ts';
import {testSession} from './fixture-auth.mjs';
import {hasPostgres,withPostgresFixture} from './support/postgres-fixture.mjs';
const at='2026-11-09T12:00:00.000Z',source='fixture-test',person={recordId:'11',nativeId:'9223372036854775807',name:'Funcionário fictício',registration:'M123',documentLast4:'1234',inactive:false,blocked:false,visitor:false};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1UAAAAASUVORK5CYII=','base64');
test('adaptador rejeita qualquer comando físico ou escrita antes de acessar credenciais',async()=>{
 const reader=Object.create(IdSecureReader.prototype);
 for(const [path,method] of [['/api/user/1','POST'],['/api/user/delete','POST'],['/api/device/open','POST'],['/api/login/','GET'],['/api/user/1?command=open','GET']])await assert.rejects(()=>reader.call(path,method,null),{kind:'unsupported'});
});
test('JSON preserva identificador de 64 bits e strings/números comuns',()=>{
 const parsed=parseDirectoryJson('{"idDevice":9223372036854775807,"id":12,"name":"idDevice: 9223372036854775807","n":1.5}');
 assert.equal(parsed.idDevice,'9223372036854775807');assert.equal(parsed.id,12);assert.equal(parsed.name,'idDevice: 9223372036854775807');assert.equal(parsed.n,1.5);
});
test('lista localizada usa coluna Ativo invertida; detalhe usa inativo booleano',()=>{
 const raw={id:1,idDevice:2,name:'Nome fictício',inativo:'Sim',blackList:'Não',idType:0};
 assert.equal(directoryPerson(raw,{list:true}).inactive,false);assert.equal(directoryPerson({...raw,inativo:'Não'},{list:true}).inactive,true);
 assert.equal(directoryPerson({...raw,inativo:false,blackList:true}).blocked,true);
 assert.throws(()=>directoryPerson({...raw,idDevice:9223372036854775807}));
 assert.throws(()=>directoryPerson({...raw,inativo:'desconhecido'},{list:true}));
 assert.throws(()=>directoryPerson({...raw,inativo:null},{list:true}));
 assert.equal(directoryPerson({...raw,registration:'12345678901'}).registration,'');
});
test('foto aceita raster limitado e rejeita HTML/SVG/base64 inválido',()=>{
 const photo=directoryPhoto(png.toString('base64'));assert.equal(photo.contentType,'image/png');assert.equal(photo.sha256,createHash('sha256').update(png).digest('hex'));
 assert.equal(directoryPhoto(null),null);for(const value of ['<svg/>',Buffer.from('<svg/>').toString('base64'),'%%%','A'.repeat(7*1024*1024)])assert.throws(()=>directoryPhoto(value));
});
test('merge idempotente por origem estável preserva revisão local e não concede autorização',()=>{
 let state=mergeDirectory(createInitialState(),source,[person],at).state;
 assert.equal(state.people[0].category,'employee');assert.equal(state.people[0].securityStatus,'pending');assert.equal(state.people[0].authorization,undefined);
 const id=state.people[0].id;
 state=execute(state,{type:'MASTER_SAVE',payload:{kind:'people',record:{id,company:'Empresa revisada',securityStatus:'cleared'}},at},{name:'Admin',role:'admin'}).state;
 const updated=mergeDirectory(state,source,[{...person,recordId:'99',name:'Nome na origem alterado'}],at);
 assert.equal(updated.created,0);assert.equal(updated.state.people[0].id,id);assert.equal(updated.state.people[0].company,'Empresa revisada');assert.equal(updated.state.people[0].name,person.name);assert.equal(updated.state.people[0].securityStatus,'cleared');
 assert.equal(mergeDirectory(updated.state,source,[{...person,recordId:'99'}],at).changes.length,0);
});
test('homônimos de origem não são fundidos; ausência/bloqueio impede acesso apesar da liberação local',()=>{
 const initial=mergeDirectory(createInitialState(),source,[person,{...person,nativeId:'2',recordId:'22'}],at).state;assert.equal(validateState(initial).people.length,2);
 initial.people[0].securityStatus='cleared';const state=mergeDirectory(initial,source,[{...person,blocked:true}],at).state;
 for(const p of state.people)assert.throws(()=>assertVisitEligibility(state,{personId:p.id},at),{code:'ACCESS_BLOCKED'});
 assert.throws(()=>mergeDirectory(initial,source,[person,person],at));
});
test('bloqueio na origem revoga autorização prévia e reativação não a concede novamente',()=>{
 let state=mergeDirectory(createInitialState(),source,[person],at).state;const id=state.people[0].id,actor={id:'a',name:'Admin QA',role:'admin'};
 state=execute(state,{type:'MASTER_SAVE',payload:{kind:'people',record:{id,securityStatus:'cleared'}},at},actor).state;
 state=execute(state,{type:'PERSON_AUTHORIZE',payload:{personId:id,areaIds:[null],exitControl:'controlled',reason:'Revisão QA'},at},actor).state;
 state=mergeDirectory(state,source,[{...person,blocked:true}],at).state;assert.equal(state.people[0].authorization.status,'revoked');
 state=mergeDirectory(state,source,[person],at).state;assert.equal(state.people[0].authorization.status,'revoked');
});

class D1{
 constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const n of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(n,dir),'utf8'));}
 prepare(sql){const sqlite=this.sqlite;return {sql,params:[],bind(...params){return {...this,params}},async first(){return sqlite.prepare(this.sql).get(...this.params)??null},async run(){return {success:true,results:[],meta:{changes:Number(sqlite.prepare(this.sql).run(...this.params).changes)}}}};}
 async batch(items){this.sqlite.exec('BEGIN');try{const result=items.map(s=>({success:true,results:this.sqlite.prepare(s.sql).all(...s.params)}));this.sqlite.exec('COMMIT');return result;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
test('foto exige sessão e documentView; não existe URL pública nem caminho arbitrário',async()=>{
 const db=new D1(),user={id:'admin',name:'Admin',email:'admin@example.test'},cookie=testSession(db,user),photo={objectKey:'directory-photos/'+source+'/'+createHash('sha256').update(png).digest('hex'),sha256:createHash('sha256').update(png).digest('hex'),size:png.length,contentType:'image/png'};
 const state=mergeDirectory(createInitialState(),source,[{...person,photo}],at).state,p=state.people[0];
 db.sqlite.prepare('INSERT INTO operational_records(collection,id,body) VALUES(?,?,?)').run('people',p.id,JSON.stringify(p));
 const bucket={async get(key){assert.equal(key,photo.objectKey);return {size:png.length,body:new Response(png).body}}};
 const call=c=>handleApi(new Request('https://fixture.example/api/people/'+p.id+'/photo',{headers:c?{cookie:c}:{}}),db,{bucket});
 assert.equal((await call()).status,401);const response=await call(cookie);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 const readerCookie=testSession(db,{id:'reader',name:'Leitor',email:'reader@example.test'});db.sqlite.prepare("UPDATE operational_users SET status='active' WHERE id='reader'").run();assert.equal((await call(readerCookie)).status,403);db.sqlite.close();
});
test('importação PostgreSQL é atômica, idempotente e publica auditoria no delta',{skip:!hasPostgres},async()=>withPostgresFixture(async({db})=>{
 const initial=createInitialState();await db.batch([db.prepare('INSERT INTO operational_meta(id,revision) VALUES(1,0)'),...['settings','berths'].map(id=>db.prepare('INSERT INTO operational_settings(id,body) VALUES(?,?)').bind(id,JSON.stringify(initial[id])))]);
 const objects=new Map(),bucket={async put(key,value){objects.set(key,value)}};
 const reader={sourceId:source,async readPage(){return {items:[{...person}],total:1}},async readPhoto(){return directoryPhoto(png.toString('base64'))}};
 const result=await importDirectory(db,bucket,reader);assert.equal(result.created,1);assert.equal(objects.size,1);
 const delta=JSON.parse((await db.prepare('SELECT body FROM operational_changes WHERE revision=1').first()).body);assert.equal(delta.collections.audit.upsert[0].action,'DIRECTORY_IMPORT');
 const again=await importDirectory(db,bucket,reader);assert.equal(again.changed,false);assert.equal((await db.prepare('SELECT revision FROM operational_meta WHERE id=1').first()).revision,1);
 const row=JSON.parse((await db.prepare("SELECT body FROM operational_records WHERE collection='people'").first()).body);assert.equal(row.securityStatus,'pending');assert.equal(row.authorization,undefined);
 const bad={...reader,async readPage(){return {items:[person,person],total:2}}};await assert.rejects(()=>importDirectory(db,bucket,bad));assert.equal((await db.prepare('SELECT revision FROM operational_meta WHERE id=1').first()).revision,1);
}));
