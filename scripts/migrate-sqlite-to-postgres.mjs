import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,readdir,rename} from 'node:fs/promises';
import {resolve,join,toNamespacedPath} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {postgresConfig,projectRoot} from './postgres-config.mjs';
import {FileObjectStore} from '../lib/storage/filesystem.ts';
const args=process.argv.slice(2),i=args.indexOf('--sqlite'),source=i<0?null:args[i+1];
if(!source||!args.includes('--offline'))throw Error('Encerre a aplicacao e use --offline --sqlite CAMINHO. A origem nunca e alterada.');
const config=postgresConfig(),admin=JSON.parse(await readFile(config.adminFile,'utf8'));
const pool=new pg.Pool({...admin,database:config.database.database}),client=await pool.connect();
const sqlite=new DatabaseSync(toNamespacedPath(resolve(source)),{readOnly:true});
const quote=s=>'"'+s.replaceAll('"','""')+'"',hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copied=[],store=new FileObjectStore(config.mediaRoot);
let commitAttempted=false;
async function files(folder){const result=[];for(const e of await readdir(folder,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){if(e.isSymbolicLink())throw Error('Link simbolico encontrado na origem.');const p=join(folder,e.name);if(e.isDirectory())result.push(...await files(p));else result.push(p);}return result;}
try{
 sqlite.exec('BEGIN');
 if(sqlite.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('A integridade do SQLite nao confere.');
 const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'operational_%' ORDER BY rowid").all().map(r=>r.name);
 await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await client.query("SELECT pg_advisory_xact_lock(hashtext('next-portaria-import'))");
 await client.query('LOCK TABLE '+tables.map(quote).join(',')+' IN ACCESS EXCLUSIVE MODE');
 for(const table of tables)if(Number((await client.query(`SELECT count(*) AS n FROM ${quote(table)}`)).rows[0].n)!==0)throw Error('A base PostgreSQL ja possui dados. Importacao interrompida sem sobrescrever registros.');
 const report={source:resolve(source),migratedAt:new Date().toISOString(),tables:[],objects:0};
 for(const table of tables){
  const columns=sqlite.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().filter(c=>c.hidden===0).map(c=>c.name);
  const rows=sqlite.prepare(`SELECT rowid AS source_rowid,${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY rowid`).all();
  const insertColumns=['rowid',...columns];
  for(const row of rows)await client.query(`INSERT INTO ${quote(table)} (${insertColumns.map(quote).join(',')}) VALUES (${insertColumns.map((_,i)=>'$'+(i+1)).join(',')})`,[row.source_rowid,...columns.map(c=>row[c])]);
  const recovered=(await client.query(`SELECT rowid AS source_rowid,${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY rowid`)).rows.map(row=>({...row,source_rowid:Number(row.source_rowid)}));
  // Preserve property order for the checksum, independent of driver's object construction.
  const canonical=value=>value.map(row=>Object.fromEntries(['source_rowid',...columns].map(c=>[c,row[c]])));
  if(hash(canonical(rows))!==hash(canonical(recovered)))throw Error('Conferencia divergente: '+table);
  await client.query(`SELECT setval(pg_get_serial_sequence($1,'rowid'),GREATEST(COALESCE(MAX(rowid),0),1),COUNT(*)>0) FROM ${quote(table)}`,[table]);
  report.tables.push({table,count:rows.length,sha256:hash(canonical(rows))});
 }
 const stateRoot=resolve(projectRoot,'.wrangler/state/v3/r2'),objectPaths=await files(stateRoot),blobs=new Map(objectPaths.filter(p=>p.includes('blobs')).map(p=>[p.split(/[\\/]/).at(-1),p])),objects=new Map();
 for(const file of objectPaths.filter(p=>p.endsWith('.sqlite'))){const db=new DatabaseSync(toNamespacedPath(file),{readOnly:true});try{if(db.prepare("SELECT name FROM sqlite_master WHERE name='_mf_objects'").get())for(const object of db.prepare('SELECT key,blob_id,size FROM _mf_objects').all()){if(objects.has(object.key))throw Error('Objetos com chave ambigua na origem.');if(object.blob_id)objects.set(object.key,object);}}finally{db.close();}}
 for(const [key,object] of objects){const path=blobs.get(object.blob_id);if(!path)throw Error('Objeto R2 ausente: '+key);if(await store.head(key))throw Error('O destino ja possui um objeto: '+key);const bytes=await readFile(path);if(bytes.length!==object.size)throw Error('Tamanho divergente no R2: '+key);await store.put(key,bytes);copied.push(key);const check=await store.get(key),read=Buffer.from(await new Response(check.body).arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==createHash('sha256').update(read).digest('hex'))throw Error('Objeto copiado diverge: '+key);report.objects++;}
 const reportPath=join(projectRoot,'.porto-runtime/sqlite-migration.json');
 await writeFile(reportPath+'.pending',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 commitAttempted=true;await client.query('COMMIT');sqlite.exec('ROLLBACK');
 await rename(reportPath+'.pending',reportPath);
 console.log(JSON.stringify({status:'verified',tables:report.tables.length,records:report.tables.find(t=>t.table==='operational_records')?.count,users:report.tables.find(t=>t.table==='operational_users')?.count,objects:report.objects}));
}catch(error){await client.query('ROLLBACK').catch(()=>{});if(!commitAttempted)for(const key of copied)await store.delete(key);throw error;}
finally{sqlite.close();client.release();await pool.end();}
