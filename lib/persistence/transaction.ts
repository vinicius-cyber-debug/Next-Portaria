import type {Pool,PoolClient} from 'pg';
import {isPostgresFailure,postgresError} from './postgres-errors.ts';
export type Isolation='read committed'|'repeatable read';
const beginStatements:Record<Isolation,string>={
  'read committed':'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read':'BEGIN ISOLATION LEVEL REPEATABLE READ',
};

/** No implicit retries: callers must re-evaluate revisions and reuse command keys. */
export async function runPostgresTransaction<T>(pool:Pick<Pool,'connect'>,operation:(client:PoolClient)=>Promise<T>,isolation:Isolation='read committed'):Promise<T>{
  if(!Object.hasOwn(beginStatements,isolation))throw Error('Isolamento de transação inválido.');const begin=beginStatements[isolation];
  const client=await pool.connect().catch(error=>{throw postgresError(error);});let discard=false;
  async function boundary(sql:string){try{return await client.query(sql);}catch(error){throw postgresError(error);}}
  try{await boundary(begin);const result=await operation(client);await boundary('COMMIT');return result;}
  catch(error){
    try{await client.query('ROLLBACK');}catch{discard=true;}
    // Cleanup must never replace the reason the transaction failed.
    throw isPostgresFailure(error)?postgresError(error):error;
  }finally{client.release(discard);}
}
