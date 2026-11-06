import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function grantApplicationRole(pool,role='portaria_app'){
 if(!/^[a-z][a-z0-9_]*$/.test(role))throw Error('Papel PostgreSQL invalido.');const name='"'+role+'"';
 await pool.query(`GRANT USAGE ON SCHEMA public TO ${name}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${name}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${name}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${name}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${name}; REVOKE ALL ON portaria_migrations FROM ${name}; REVOKE UPDATE,DELETE ON operational_audit FROM ${name};`);
}
export async function migratePostgres(pool){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('next-portaria-migrations'))");
  await client.query('CREATE TABLE IF NOT EXISTS portaria_migrations(version TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const folder=new URL('../database/postgres/',import.meta.url);
  for(const file of (await readdir(folder)).filter(f=>/^\d+.*\.sql$/.test(f)).sort()){
   const sql=await readFile(new URL(file,folder),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
   const old=(await client.query('SELECT sha256 FROM portaria_migrations WHERE version=$1',[file])).rows[0];
   if(old){if(old.sha256!==hash)throw Error('Migracao ja aplicada foi alterada: '+file);continue;}
   await client.query(sql);await client.query('INSERT INTO portaria_migrations(version,sha256) VALUES($1,$2)',[file,hash]);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
