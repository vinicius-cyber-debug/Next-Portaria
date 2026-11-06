import pg from 'pg';
import type {PoolConfig,PoolClient,QueryResultRow} from 'pg';
import type {Database,PreparedStatement,QueryResult} from './contracts.ts';
import {postgresError} from './postgres-errors.ts';
import {runPostgresTransaction} from './transaction.ts';
import type {Isolation} from './transaction.ts';

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
type Scope={client:PoolClient;active:boolean};
class PgStatement implements PreparedStatement {
  readonly owner:PostgresDatabase;readonly sql:string;readonly values:unknown[];readonly scope?:Scope;
  constructor(owner:PostgresDatabase,sql:string,values:unknown[]=[],scope?:Scope){this.owner=owner;this.sql=sql;this.values=values;this.scope=scope;}
  bind(...values:unknown[]){return new PgStatement(this.owner,this.sql,values,this.scope);}
  async all<T=Record<string,unknown>>(){return this.owner.query<T>(this,this.scope?.client);}
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
  /** Authentication inside an existing transaction must not acquire a second pool connection. */
  private scoped(scope:Scope):Database{
    return {prepare:(sql:string)=>new PgStatement(this,sql,[],scope),batch:async<T=Record<string,unknown>>(statements:PreparedStatement[])=>{
      if(!scope.active)throw Error('A transação já foi encerrada.');
      const results:QueryResult<T>[]=[];
      for(const statement of statements){if(!(statement instanceof PgStatement)||statement.owner!==this||statement.scope!==scope)throw Error('Comando fora da transacao ativa.');results.push(await this.query<T>(statement,scope.client));}
      return results;
    }};
  }
  async query<T>(statement:PgStatement,client?:PoolClient):Promise<QueryResult<T>> {
    if(statement.owner!==this||(statement.scope&&(!statement.scope.active||statement.scope.client!==client)))throw Error('Comando fora da transação ativa.');
    try{
      const result=await (client??this.pool).query<QueryResultRow>(postgresSql(statement.sql),statement.values);
      return {success:true,results:result.rows as T[],meta:{changes:result.rowCount??0}};
    }catch(error){throw postgresError(error);}
  }
  async transaction<T>(operation:(client:PoolClient,database:Database)=>Promise<T>,isolation:Isolation='read committed'){
    return runPostgresTransaction(this.pool,async client=>{
      const scope:Scope={client,active:true};
      try{return await operation(client,this.scoped(scope));}finally{scope.active=false;}
    },isolation);
  }
  async batch<T=Record<string,unknown>>(statements:PreparedStatement[]):Promise<QueryResult<T>[]> {
    if(statements.some(s=>!(s instanceof PgStatement)||s.owner!==this||s.scope))throw Error('Lote contem comandos de outra conexao.');
    return this.transaction(async client=>{
      const results:QueryResult<T>[]=[];
      for(const statement of statements)results.push(await this.query<T>(statement as PgStatement,client));
      return results;
    },'repeatable read');
  }
  async close(){await this.pool.end();}
}
