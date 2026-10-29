/** Provisionamento interativo do primeiro administrador. Nunca coloca senha em argumentos ou arquivos. */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root=resolve(import.meta.dirname,'..');process.chdir(root);
const config='dist/server/wrangler.json';
if(!existsSync(config))throw Error('Execute npm run build e node scripts/setup-local.mjs primeiro.');
const wrangler=[ '--import','./scripts/runtime-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config',config,'--persist-to','.wrangler/state'];
function query(sql){
  const result=spawnSync(process.execPath,[...wrangler,'--command',sql,'--json'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  if(result.status!==0)throw Error('Banco D1 local indisponível: '+(result.stderr||result.stdout));
  const text=result.stdout;const begin=text.indexOf('[{');
  const parsed=JSON.parse(begin>=0?text.slice(begin):text);
  return (Array.isArray(parsed)?parsed[0]:parsed).results;
}
function escapeSql(value){return "'"+String(value).replaceAll("'","''")+"'";}
async function secret(prompt){
  if(!input.isTTY||!input.setRawMode)throw Error('É necessário executar num terminal interativo (PowerShell/CMD).');
  output.write(prompt);return new Promise((resolve,reject)=>{
    let data='';input.setRawMode(true);input.resume();
    const done=(error)=>{input.removeListener('data',listener);input.setRawMode(false);input.pause();output.write('\n');if(error)reject(error);else resolve(data);};
    const listener=(chunk)=>{for(const key of String(chunk)){
      if(key==='\r'||key==='\n'){done();return;}
      if(key==='\u0003'){done(Error('Operação cancelada.'));return;}
      if(key==='\u007f'||key==='\b'){if(data.length){data=data.slice(0,-1);output.write('\b \b');}continue;}
      if(key>=' '&&data.length<128){data+=key;output.write('*');}
    }};
    input.on('data',listener);
  });
}
const record=query('SELECT COUNT(*) AS n FROM operational_credentials;');
if(Number(record[0]?.n)>0){console.log('Administrador local já cadastrado. Entre pela tela de login.');process.exit(0);}
if(!input.isTTY)throw Error('O primeiro administrador deve ser criado interativamente.');
console.log('\nPRIMEIRO ACESSO - NEXT PORTARIA LOCAL');
console.log('Crie o administrador. A senha não será mostrada na tela.');
const rl=createInterface({input,output});
let name,username,email;
try{
  name=(await rl.question('Nome completo: ')).trim();
  username=(await rl.question('Usuário (ex.: admin.porto): ')).trim().toLowerCase();
  email=(await rl.question('E-mail: ')).trim().toLowerCase();
}finally{rl.close();}
if(name.length<2||name.length>150||! /^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Nome, usuário ou e-mail inválidos. Repita o cadastro.');
if(query(`SELECT id FROM operational_users WHERE email=${escapeSql(email)}`).length)throw Error('Já existe uma conta com esse e-mail. Use outro e-mail para a conta local.');
const password=await secret('Senha forte (mínimo 12 caracteres): ');
const confirm=await secret('Confirme a senha: ');
if(password.length<12||password.length>128||password!==confirm)throw Error('A senha não atende ao tamanho mínimo ou a confirmação é diferente.');
const salt=randomBytes(16).toString('hex'),hash=pbkdf2Sync(password,Buffer.from(salt,'hex'),310000,32,'sha256').toString('hex');
const id='local_'+randomUUID(),now=new Date().toISOString(),auditId='audit_'+randomUUID();
const event={id:auditId,at:now,actor:name,actorId:id,role:'admin',action:'LOCAL_ADMIN_BOOTSTRAP',entity:'user',entityId:id,detail:'Criação do primeiro administrador local',changes:[{kind:'user',id,before:null,after:{id,name,email,role:'admin',status:'active'}}]};
const script=[
 `INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (${[id,email,name,'admin','active',now,now].map(escapeSql).join(',')});`,
 `INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at) VALUES (${[id,username,salt,hash].map(escapeSql).join(',')},310000,${escapeSql(now)});`,
 `INSERT OR IGNORE INTO operational_meta(id,revision) VALUES (1,0);`,
 `INSERT INTO operational_audit(id,at,body) VALUES (${escapeSql(auditId)},${escapeSql(now)},${escapeSql(JSON.stringify(event))});`,
 // D1 administra as transações; COMMIT/BEGIN explícitos não são aceitos pelo Wrangler/workerd.
 `UPDATE operational_meta SET revision=revision+1 WHERE id=1;`
].join('\n');
const temp=mkdtempSync(join(tmpdir(),'porto-admin-'));
try{
  const file=join(temp,'admin.sql');writeFileSync(file,script,{mode:0o600});
  const result=spawnSync(process.execPath,[...wrangler,'--file',file],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  if(result.status!==0)throw Error('Falha ao criar administrador na base LOCAL: '+(result.stderr||result.stdout));
  // Wrangler pode confirmar comandos individualmente: validar todas as entidades antes de informar sucesso.
  const created=query(`SELECT u.id FROM operational_users u
    JOIN operational_credentials c ON c.user_id=u.id
    JOIN operational_audit a ON a.id=${escapeSql(auditId)}
    WHERE u.id=${escapeSql(id)} AND c.username=${escapeSql(username)}
      AND u.role='admin' AND u.status='active';`);
  if(created.length!==1)throw Error('O provisionamento local não foi confirmado integralmente. Faça backup de .wrangler/state antes de tentar reparar.');
    console.log('\nAdministrador cadastrado com sucesso: '+username);
}finally{rmSync(temp,{recursive:true,force:true});}
