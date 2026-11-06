import pg from 'pg';
import type {PoolConfig,PoolClient,QueryResultRow} from 'pg';
import type {Database,PreparedStatement,QueryResult} from './contracts.ts';

/** Compatibility limited to the application's parameterized SQL, never user SQL. */
export function postgresSql(input:string):string {
  input=input.trim().replace(/;\s*$/,'');
  let quoted=false,index=0,sql='';
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    if(ch==="'"){
      sql+=ch;
      if(quoted&&input[i+1]==="'"){sql+=input[++i];continue;}
      quoted=!quoted;
    }else sql+=ch==='?'&&!quoted?`$${++index}`:ch;
  }
  sql=sql.replace(/\bjson_extract\s*\(/gi,'portaria_json_text(').replace(/\binstr\s*\(/gi,'strpos(');
  sql=sql.replace(/\bAS\s+([a-zA-Z_]\w*)/gi,(match,name:string)=>/[A-Z]/.test(name)?`AS "${name}"`:match);
  if(/^\s*INSERT OR IGNORE INTO\b/i.test(sql)){
    sql=sql.replace(/INSERT OR IGNORE INTO/i,'INSERT INTO');
    const returning=sql.search(/\bRETURNING\b/i);
    sql=returning<0?sql+' ON CONFLICT DO NOTHING':sql.slice(0,returning)+' ON CONFLICT DO NOTHING '+sql.slice(returning);
  }
  return sql;
}

function safeNumber(value:string){const n=Number(value);if(!Number.isSafeInteger(n))throw Error('Valor inteiro fora da faixa segura.');return n;}
function normalizedError(error:unknown):Error {
  const value=error as {code?:string;message?:string};
  if(value.code==='40001'||value.code==='40P01')return Error('REVISION_CONFLICT');
  if(value.code==='23505')return Object.assign(Error('Ja existe um registro com estes identificadores.'),{code:'DUPLICATE'});
  // SQLSTATE is not a domain error and must not be exposed as a public API code.
  return Error(value.message??'Falha no PostgreSQL.');
}
class PgStatement implements PreparedStatement {
  readonly owner:PostgresDatabase;readonly sql:string;readonly values:unknown[];
  constructor(owner:PostgresDatabase,sql:string,values:unknown[]=[]){this.owner=owner;this.sql=sql;this.values=values;}
  bind(...values:unknown[]){return new PgStatement(this.owner,this.sql,values);}
  async all<T=Record<string,unknown>>(){return this.owner.query<T>(this);}
  async first<T=Record<string,unknown>>(){return (await this.all<T>()).results[0]??null;}
  async run<T=Record<string,unknown>>(){return this.all<T>();}
}
export class PostgresDatabase implements Database {
  readonly pool:pg.Pool;
  constructor(config:PoolConfig){
    this.pool=new pg.Pool({...config,max:config.max??10,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
      types:{getTypeParser:(oid:number,format?:string)=>oid===20?safeNumber:pg.types.getTypeParser(oid,format as 'text')}});
    this.pool.on('error',()=>console.error('Uma conexao ociosa do PostgreSQL foi encerrada.'));
  }
  prepare(sql:string){return new PgStatement(this,sql);}
  async query<T>(statement:PgStatement,client?:PoolClient):Promise<QueryResult<T>> {
    try{
      const result=await (client??this.pool).query<QueryResultRow>(postgresSql(statement.sql),statement.values);
      return {success:true,results:result.rows as T[],meta:{changes:result.rowCount??0}};
    }catch(error){throw normalizedError(error);}
  }
  async batch<T=Record<string,unknown>>(statements:PreparedStatement[]):Promise<QueryResult<T>[]> {
    if(statements.some(s=>!(s instanceof PgStatement)||s.owner!==this))throw Error('Lote contem comandos de outra conexao.');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const results:QueryResult<T>[]=[];
      for(const statement of statements)results.push(await this.query<T>(statement as PgStatement,client));
      await client.query('COMMIT');return results;
    }catch(error){await client.query('ROLLBACK');throw normalizedError(error);}
    finally{client.release();}
  }
  async close(){await this.pool.end();}
}
