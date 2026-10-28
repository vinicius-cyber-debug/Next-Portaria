import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';
import {hashPassword} from '../lib/local-auth.ts';
class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const file of readdirSync(dir).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(file,dir),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:this.sqlite.prepare(s.sql).all(...s.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const url='http://127.0.0.1:5173';
async function call(db,path,body,cookie='',origin=url,other={}){
 const post=body!==undefined;
 const headers={...other};if(cookie)headers.cookie=cookie;
 if(post){headers['Content-Type']='application/json';if(origin)headers.Origin=origin;}
 const request=new Request(url+path,{method:post?'POST':'GET',headers,body:post?JSON.stringify(body):undefined});
 const res=await handleApi(request,db);
 return {status:res.status,headers:res.headers,data:await res.json()};
}
async function setup(){const db=new D1(),password='Senha-forte-local-123!',h=await hashPassword(password),now=new Date().toISOString();
 db.sqlite.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('administrator','admin@example.test','Administrador','admin','active',now,now);
 db.sqlite.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES (?,?,?,?,?,?,0)').run('administrator','admin',h.salt,h.hash,h.iterations,now);
 return {db,password};}
async function login(db,username,password){const result=await call(db,'/api/auth/login',{username,password});return {...result,cookie:result.headers.get('set-cookie')?.match(/porto_session=([a-f0-9]{64})/)?.[1]};}
const cookieOf=token=>'porto_session='+token;

test('cabeçalhos externos e tokens falsos não autenticam um usuário',async()=>{
 const {db}=await setup();
 assert.equal((await call(db,'/api/session',undefined,'',url,{'x-authenticated-user-id':'administrator','x-authenticated-user-email':'admin@example.test'})).status,401);
 assert.equal((await call(db,'/api/state',undefined,cookieOf('a'.repeat(64)))).status,401);
});
test('login usa senha com hash, cookie HttpOnly, sessão expira e logout revoga',async()=>{
 const {db,password}=await setup();const invalid=await login(db,'admin','errada');assert.equal(invalid.status,401);
 const good=await login(db,'ADMIN',password);assert.equal(good.status,200);assert.ok(good.cookie);
 assert.match(good.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
 assert.equal((await call(db,'/api/session',undefined,cookieOf(good.cookie))).data.user.role,'admin');
 assert.equal(db.sqlite.prepare('SELECT token_hash FROM operational_sessions').get().token_hash.includes(good.cookie),false);
 const end=await call(db,'/api/auth/logout',{},cookieOf(good.cookie));assert.equal(end.status,200);
 assert.match(end.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await call(db,'/api/session',undefined,cookieOf(good.cookie))).status,401);
});
test('conta bloqueia após cinco senhas erradas',async()=>{
 const {db,password}=await setup();for(let i=0;i<5;i++)assert.equal((await login(db,'admin','errada')).status,401);
 assert.equal((await login(db,'admin',password)).status,429);
});
test('administrador cria usuário, redefine senha e invalida sessões anteriores',async()=>{
 const {db,password}=await setup();const admin=await login(db,'admin',password);const adminCookie=cookieOf(admin.cookie);
 const create=await call(db,'/api/users',{action:'create_local',username:'portaria01',name:'Operador Portaria',email:'portaria@example.test',role:'gate',password:'Senha-portaria-123!',idempotencyKey:'create-portal-001'},adminCookie);
 assert.equal(create.status,200);assert.equal(create.data.result.username,'portaria01');assert.ok(!JSON.stringify(create.data).includes('Senha-portaria'));
 const badDuplicate=await call(db,'/api/users',{action:'create_local',username:'portaria01',name:'Duplicado',email:'duplicado@example.test',role:'gate',password:'Senha-portaria-123!',idempotencyKey:'create-portal-002'},adminCookie);assert.equal(badDuplicate.status,409);
 const gate=await login(db,'portaria01','Senha-portaria-123!');assert.equal(gate.status,200);
 assert.equal((await call(db,'/api/session',undefined,cookieOf(gate.cookie))).data.user.role,'gate');
 assert.equal((await call(db,'/api/users',undefined,cookieOf(gate.cookie))).status,403);
 const reset=await call(db,'/api/users',{action:'reset_password',id:create.data.result.id,password:'Senha-portaria-NOVA-12!',idempotencyKey:'reset-portal-001'},adminCookie);assert.equal(reset.status,200);
 assert.equal((await call(db,'/api/session',undefined,cookieOf(gate.cookie))).status,401);
 assert.equal((await login(db,'portaria01','Senha-portaria-123!')).status,401);
 assert.equal((await login(db,'portaria01','Senha-portaria-NOVA-12!')).status,200);
 assert.ok(!JSON.stringify((await call(db,'/api/state',undefined,adminCookie)).data).includes('Senha-portaria-NOVA'));
});
test('conta desativada não entra e sessão previamente emitida é recusada',async()=>{
 const {db,password}=await setup(),admin=await login(db,'admin',password),adminCookie=cookieOf(admin.cookie);
 const created=await call(db,'/api/users',{action:'create_local',username:'operador',email:'operator@example.test',name:'Operador',role:'gate',password:'Senha-operador-123!',idempotencyKey:'create-operator-01'},adminCookie);assert.equal(created.status,200);
 const gate=await login(db,'operador','Senha-operador-123!');const disable=await call(db,'/api/users',{action:'update',id:created.data.result.id,role:'gate',status:'disabled',idempotencyKey:'disable-operator-01'},adminCookie);assert.equal(disable.status,200);
 assert.equal((await call(db,'/api/session',undefined,cookieOf(gate.cookie))).status,401);
 assert.equal((await login(db,'operador','Senha-operador-123!')).status,403);
});
test('login POST exige origem do mesmo site',async()=>{
 const {db,password}=await setup();assert.equal((await call(db,'/api/auth/login',{username:'admin',password},'','https://outro.site')).status,403);
 assert.equal((await call(db,'/api/auth/login',{username:'admin',password},'',null)).status,403);
});
test('migração de login preserva registros existentes e protege único admin local',async()=>{
 const db=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);
 for(const file of ['0000_jazzy_scarecrow.sql','0001_tiny_ego.sql'])db.exec(readFileSync(new URL(file,dir),'utf8'));
 const now=new Date().toISOString();
 db.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('legacy','antigo@example.test','Usuário antigo','admin','active',now,now);
 db.prepare('INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)').run('visitors','visit1',JSON.stringify({id:'visit1',name:'Teste preservado'}));
 db.exec(readFileSync(new URL('0002_local_users.sql',dir),'utf8'));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operational_records').get().n,1);
 db.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('local','novo@example.test','Admin local','admin','active',now,now);
 db.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at) VALUES (?,?,?,?,?,?)').run('local','adminlocal','0'.repeat(32),'0'.repeat(64),310000,now);
 assert.throws(()=>db.prepare("UPDATE operational_users SET role='reader' WHERE id='local'").run(),/LAST_ADMIN/);
});

test('script de primeiro administrador não usa COMMIT/BEGIN incompatíveis com o D1',()=>{
 const source=readFileSync(new URL('../scripts/create-local-admin.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/['"](?:COMMIT|BEGIN(?:\s+TRANSACTION)?|SAVEPOINT|ROLLBACK)\s*;['"]/i);
 assert.match(source,/JOIN operational_credentials c/);
 assert.match(source,/JOIN operational_audit a/);
});
