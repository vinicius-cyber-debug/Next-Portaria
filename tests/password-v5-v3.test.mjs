import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';
import {hashPassword,verifyPassword} from '../lib/local-auth.ts';

class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const file of readdirSync(dir).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(file,dir),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){const row=owner.sqlite.prepare(this.sql).get(...this.params)??null;if(owner.afterRead&&owner.readMatch?.test(this.sql)){const hook=owner.afterRead;owner.afterRead=null;hook();}return row;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:this.sqlite.prepare(s.sql).all(...s.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const url='http://127.0.0.1:5173',initialPassword='Senha-inicial-forte-123!',nextPassword='Minha-senha-pessoal-456!',resetPassword='Redefinida-admin-789!';
async function call(db,path,body,cookie=''){
 const post=body!==undefined,headers={};if(cookie)headers.cookie=cookie;
 if(post){headers['Content-Type']='application/json';headers.Origin=url;}
 const result=await handleApi(new Request(url+path,{method:post?'POST':'GET',headers,body:post?JSON.stringify(body):undefined}),db);
 return {status:result.status,headers:result.headers,data:await result.json(),cookie:result.headers.get('set-cookie')?.split(';')[0]};
}
async function setup(force=true){const db=new D1(),credential=await hashPassword(initialPassword),now=new Date().toISOString();
 db.sqlite.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('administrator','admin@example.test','Administrador','admin','active',now,now);
 db.sqlite.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES (?,?,?,?,?,?,?)').run('administrator','admin',credential.salt,credential.hash,credential.iterations,now,force?1:0);
 return {db,credential};}
const login=(db,password=initialPassword,username='admin')=>call(db,'/api/auth/login',{username,password});
const change=(db,cookie,currentPassword=initialPassword,newPassword=nextPassword)=>call(db,'/api/auth/change-password',{currentPassword,newPassword},cookie);

test('senha inicial obriga troca, gira sessões e nunca registra senha ou hash na auditoria',async()=>{
 const {db,credential}=await setup(),signed=await login(db),cookie=signed.cookie;
 assert.equal(signed.status,200);assert.equal(signed.data.mustChangePassword,true);
 assert.equal((await call(db,'/api/session',undefined,cookie)).data.user.mustChangePassword,true);
 for(const [path,body] of [['/api/state',undefined],['/api/records?collection=visitors',undefined],['/api/commands',{type:'VISITOR_REQUEST'}],['/api/backup',undefined]]){
   const denied=await call(db,path,body,cookie);assert.equal(denied.status,403);assert.equal(denied.data.error.code,'PASSWORD_CHANGE_REQUIRED');
 }
 assert.equal((await change(db,cookie,'senha-errada-forte')).data.error.code,'INVALID_PASSWORD');
 assert.equal((await change(db,cookie,initialPassword,initialPassword)).data.error.code,'PASSWORD_REUSED');
 assert.equal((await change(db,cookie,initialPassword,'curta')).status,400);
 const updated=await change(db,cookie);assert.equal(updated.status,200);assert.equal(updated.data.user.mustChangePassword,false);assert.notEqual(updated.cookie,cookie);
 assert.match(updated.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
 assert.equal((await call(db,'/api/session',undefined,cookie)).status,401);
 assert.equal((await call(db,'/api/state',undefined,updated.cookie)).status,200);
 assert.equal((await call(db,'/api/session',undefined,updated.cookie)).data.user.mustChangePassword,false);
 assert.equal((await login(db)).status,401);assert.equal((await login(db,nextPassword)).status,200);
 const stored=db.sqlite.prepare('SELECT password_salt,password_hash,must_change_password FROM operational_credentials').get();
 assert.equal(stored.must_change_password,0);assert.notEqual(stored.password_salt,credential.salt);assert.equal(await verifyPassword(nextPassword,stored.password_salt,stored.password_hash),true);
 const audits=db.sqlite.prepare('SELECT body FROM operational_audit').all().map(x=>x.body).join('');assert.match(audits,/USER_PASSWORD_CHANGE/);
 for(const secret of [initialPassword,nextPassword,credential.hash,stored.password_hash,credential.salt])assert.equal(audits.includes(secret),false);
});

test('usuário criado e senha redefinida exigem troca; redefinição invalida sessões',async()=>{
 const {db}=await setup(false),admin=await login(db),created=await call(db,'/api/users',{action:'create_local',username:'gatev5',name:'Portaria',email:'gatev5@example.test',role:'gate',password:initialPassword,idempotencyKey:'create-gate-v5'},admin.cookie);
 assert.equal(created.status,200);assert.ok(created.data.result.mustChangePassword);
 const gate=await login(db,initialPassword,'gatev5');assert.equal((await call(db,'/api/state',undefined,gate.cookie)).data.error.code,'PASSWORD_CHANGE_REQUIRED');
 const changed=await change(db,gate.cookie);assert.equal(changed.status,200);
 const reset=await call(db,'/api/users',{action:'reset_password',id:created.data.result.id,password:resetPassword,idempotencyKey:'reset-gate-v5'},admin.cookie);assert.equal(reset.status,200);
 assert.equal((await call(db,'/api/state',undefined,changed.cookie)).status,401);
 assert.equal((await login(db,nextPassword,'gatev5')).status,401);
 const resetLogin=await login(db,resetPassword,'gatev5');assert.equal(resetLogin.status,200);assert.equal(resetLogin.data.mustChangePassword,true);
 assert.equal((await call(db,'/api/state',undefined,resetLogin.cookie)).status,403);
});

test('tentativas de troca de senha respeitam bloqueio por cinco falhas',async()=>{
 const {db}=await setup(),signed=await login(db);for(let i=0;i<5;i++)assert.equal((await change(db,signed.cookie,'senha-errada-forte')).status,400);
 assert.equal((await change(db,signed.cookie)).status,429);assert.equal((await login(db)).status,429);
});

test('troca concorrente com redefinição não sobrescreve a senha do administrador',async()=>{
 const {db}=await setup(),signed=await login(db),reset=await hashPassword(resetPassword);
 db.readMatch=/SELECT password_salt AS salt/;db.afterRead=()=>{db.sqlite.prepare('UPDATE operational_credentials SET password_salt=?,password_hash=?,password_iterations=?,must_change_password=1 WHERE user_id=?').run(reset.salt,reset.hash,reset.iterations,'administrator');db.sqlite.prepare('DELETE FROM operational_sessions WHERE user_id=?').run('administrator');db.sqlite.prepare('UPDATE operational_meta SET revision=revision+1').run();};
 const updated=await change(db,signed.cookie);assert.equal(updated.status,409);assert.equal(updated.data.error.code,'REVISION_CONFLICT');
 assert.equal(db.sqlite.prepare('SELECT password_hash FROM operational_credentials').get().password_hash,reset.hash);
 assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM operational_audit WHERE json_extract(body,'$.action')='USER_PASSWORD_CHANGE'").get().n,0);
});

test('login em corrida com redefinição não emite sessão para a senha antiga',async()=>{
 const {db}=await setup(false),reset=await hashPassword(resetPassword);
 db.readMatch=/SELECT c.user_id AS id/;db.afterRead=()=>db.sqlite.prepare('UPDATE operational_credentials SET password_salt=?,password_hash=? WHERE user_id=?').run(reset.salt,reset.hash,'administrator');
 const signed=await login(db);assert.equal(signed.status,401);assert.equal(signed.cookie,undefined);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM operational_sessions').get().n,0);
 assert.equal((await login(db,resetPassword)).status,200);
});

test('logout concorrente impede troca mesmo sem mudança na revisão operacional',async()=>{
 const {db,credential}=await setup(false),signed=await login(db);
 db.readMatch=/SELECT password_salt AS salt/;db.afterRead=()=>db.sqlite.prepare('DELETE FROM operational_sessions').run();
 const updated=await change(db,signed.cookie);assert.equal(updated.status,403);assert.equal(updated.data.error.code,'FORBIDDEN');assert.equal(db.sqlite.prepare('SELECT password_hash FROM operational_credentials').get().password_hash,credential.hash);
 assert.equal(updated.cookie,undefined);
});

test('migração v5 conserva contas, sessões e credenciais e exige uma primeira troca',()=>{
 const db=new DatabaseSync(':memory:'),dir=new URL('../drizzle/',import.meta.url),now=new Date().toISOString();
 for(const file of readdirSync(dir).filter(p=>p.endsWith('.sql')&&p<'0004').sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
 db.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('old','old@example.test','Antigo','admin','active',now,now);
 db.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at) VALUES (?,?,?,?,?,?)').run('old','old','0'.repeat(32),'f'.repeat(64),310000,now);
 db.prepare('INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('a'.repeat(64),'old',now,new Date(Date.now()+3600000).toISOString());
 db.exec(readFileSync(new URL('0004_v5.sql',dir),'utf8'));
 assert.equal(db.prepare('SELECT must_change_password,password_hash FROM operational_credentials').get().must_change_password,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operational_sessions').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operational_users').get().n,1);
});
