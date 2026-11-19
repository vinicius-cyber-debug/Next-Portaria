import {stdin as input,stdout as output} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {postgresConfig} from './postgres-config.mjs';
import {validUsername,validPassword,hashPassword} from '../lib/local-auth.ts';
import {PASSWORD_MIN_LENGTH,PASSWORD_MAX_LENGTH} from '../lib/password-policy.mjs';
const config=postgresConfig(),pool=new pg.Pool(config.database);
async function secret(prompt){
 if(!input.isTTY||!input.setRawMode)throw Error('Execute em terminal interativo.');
 output.write(prompt);return new Promise((resolve,reject)=>{
  let text='';input.setRawMode(true);input.resume();
  const done=error=>{input.removeListener('data',listener);input.setRawMode(false);input.pause();output.write('\n');if(error)reject(error);else resolve(text);};
  const listener=chunk=>{for(const key of String(chunk)){if(key==='\r'||key==='\n'){done();return;}if(key==='\u0003'){done(Error('Cadastro cancelado.'));return;}if(key==='\b'||key==='\u007f'){if(text.length){text=text.slice(0,-1);output.write('\b \b');}}else if(key>=' '&&text.length<PASSWORD_MAX_LENGTH){text+=key;output.write('*');}}};input.on('data',listener);
 });
}
try{
 const complete=await pool.query("SELECT u.id FROM operational_users u JOIN operational_credentials c ON c.user_id=u.id WHERE u.role='admin' AND u.status='active' LIMIT 1");
 if(complete.rowCount){console.log('Administrador PostgreSQL ja cadastrado. Entre pela tela de login.');}
 else{
  if(!input.isTTY)throw Error('Crie o primeiro administrador em um terminal interativo.');
  const rl=createInterface({input,output});let name,username,email;
  try{name=(await rl.question('Nome completo: ')).trim();username=validUsername(await rl.question('Usuario: '));email=(await rl.question('E-mail: ')).trim().toLowerCase();}finally{rl.close();}
  if(name.length<2||name.length>150||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Nome ou e-mail invalido.');
  const password=validPassword(await secret(`Senha (minimo ${PASSWORD_MIN_LENGTH} caracteres): `)),confirmation=await secret('Confirme a senha: ');if(password!==confirmation)throw Error('As senhas sao diferentes.');
  const credential=await hashPassword(password),id='local_'+randomUUID(),now=new Date().toISOString(),auditId='audit_'+randomUUID();
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('portaria-bootstrap'))");
   if((await client.query('SELECT 1 FROM operational_credentials LIMIT 1')).rowCount)throw Error('Ja existem credenciais. Use o administrador existente.');
   await client.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$3,'admin','active',$4,$4)",[id,email,name,now]);
   await client.query('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at) VALUES($1,$2,$3,$4,$5,$6)',[id,username,credential.salt,credential.hash,credential.iterations,now]);
   await client.query('INSERT INTO operational_meta(id,revision) VALUES(1,0) ON CONFLICT DO NOTHING');
   await client.query('INSERT INTO operational_audit(id,at,body) VALUES($1,$2,$3)',[auditId,now,JSON.stringify({id:auditId,at:now,actor:name,actorId:id,role:'admin',action:'LOCAL_ADMIN_BOOTSTRAP',entity:'user',entityId:id,detail:'Criacao do primeiro administrador PostgreSQL',changes:[]})]);
   await client.query('UPDATE operational_meta SET revision=revision+1 WHERE id=1');await client.query('COMMIT');
   console.log('Administrador cadastrado com sucesso: '+username);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
}finally{await pool.end();}
