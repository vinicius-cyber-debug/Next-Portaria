import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {PostgresDatabase} from '../../lib/persistence/postgres.ts';
import {migratePostgres,grantApplicationRole} from '../../scripts/postgres-migrations.mjs';

const localPath=resolve('.porto-runtime/postgres.json');
export const hasPostgres=Boolean(process.env.PORTO_TEST_POSTGRES_CONFIG)||existsSync(localPath);
export async function waitUntil(predicate,message,timeout=5000){
 const deadline=Date.now()+timeout;
 while(!await predicate()){if(Date.now()>deadline)throw Error(message);await new Promise(done=>setTimeout(done,15));}
}
/** Every mutable object belongs to a new database/role created by this invocation. */
export async function withPostgresFixture(operation){
 const local=existsSync(localPath)?JSON.parse(await readFile(localPath,'utf8')):null;
 const admin=process.env.PORTO_TEST_POSTGRES_CONFIG?JSON.parse(process.env.PORTO_TEST_POSTGRES_CONFIG):JSON.parse(await readFile(local.adminFile,'utf8'));
 const token=randomUUID().replaceAll('-',''),database='portaria_stability_'+token,role='qa_stability_'+token,password=randomBytes(32).toString('hex');
 const control=new pg.Pool({...admin,database:'postgres'}),poolErrors=[];
 control.on('error',error=>poolErrors.push(error.code??'connection'));
 let createdDatabase=false,createdRole=false,owner,db;const failures=[];
 try{
  await control.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);createdRole=true;
  await control.query(`CREATE DATABASE "${database}"`);createdDatabase=true;
  owner=new pg.Pool({...admin,database});owner.on('error',error=>poolErrors.push(error.code??'connection'));
  await migratePostgres(owner);await grantApplicationRole(owner,role);
  db=new PostgresDatabase({...admin,database,user:role,password,max:5,application_name:'stability-'+token});
  db.pool.on('error',error=>poolErrors.push(error.code??'connection'));
  return await operation({owner,db,database,role});
 }catch(error){failures.push(error);}
 finally{
  // Close all application/owner clients before removing ONLY our isolated fixtures.
  const closed=await Promise.allSettled([db?.close(),owner?.end()]);
  for(const result of closed)if(result.status==='rejected')failures.push(result.reason);
  async function cleanup(operation){try{await operation();}catch(error){failures.push(error);}}
  if(createdDatabase){
   let clean=false;
   await cleanup(async()=>{await waitUntil(async()=>Number((await control.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[database])).rows[0].n)===0,'Conexoes de QA nao encerraram.',2000);clean=true;});
   await cleanup(()=>control.query(`DROP DATABASE "${database}"${clean?'':' WITH (FORCE)'}`));
  }
  if(createdRole)await cleanup(()=>control.query(`DROP ROLE "${role}"`));
  await cleanup(()=>control.end());
  await cleanup(()=>assert.deepEqual(poolErrors,[],'Erro assíncrono de conexão durante a execução/limpeza.'));
  if(failures.length===1)throw failures[0];if(failures.length>1)throw new AggregateError(failures,'Falhas na execucao e/ou limpeza dos recursos de QA.');
 }
}
