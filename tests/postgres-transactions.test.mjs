import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresError} from '../lib/persistence/postgres-errors.ts';
import {runPostgresTransaction} from '../lib/persistence/transaction.ts';
import {handleApi} from '../lib/server.ts';
import {EventEmitter} from 'node:events';
import {trackPoolShutdown} from '../lib/persistence/pool-lifecycle.ts';

function fakePool({failCommit=false,failRollback=false,failBegin=false}={}){
 const calls=[],releases=[];
 const client={async query(sql){calls.push(sql);if((sql==='COMMIT'&&failCommit)||(sql==='ROLLBACK'&&failRollback)||(sql.startsWith('BEGIN')&&failBegin))throw Object.assign(Error('connection secret=do-not-expose'),{code:'ECONNRESET'});return {rows:[]};},release(value){releases.push(value);}};
 return {calls,releases,client,pool:{async connect(){return client;}}};
}
for(const sqlState of ['40001','40P01']){
 test(`SQLSTATE ${sqlState} conserva classificacao nas camadas e responde 409`,async()=>{
  const normalized=postgresError(Object.assign(Error('private detail'),{code:sqlState,severity:'ERROR'}));
  assert.equal(normalized.sqlState,sqlState);assert.equal(normalized.retryable,true);assert.equal(postgresError(normalized),normalized);
  const statement={bind(){return this;}},provider={prepare(){return statement;},async batch(){throw postgresError(normalized);}};
  const response=await handleApi(new Request('http://127.0.0.1/api/state'),provider),body=await response.json();assert.equal(response.status,409);assert.equal(body.error.code,'REVISION_CONFLICT');assert.ok(!JSON.stringify(body).includes(sqlState));assert.ok(!JSON.stringify(body).includes('private detail'));
 });
}
test('violacao de unicidade preserva o codigo publico sem expor SQLSTATE ou dados',()=>{
 const error=postgresError(Object.assign(Error('private'),{code:'23505',severity:'ERROR'}));assert.equal(postgresError(error).code,'DUPLICATE');assert.equal(error.retryable,false);assert.ok(!error.message.includes('private'));
});
test('rollback concluido devolve a conexao e nao repete a operacao',async()=>{
 const f=fakePool(),failure=Object.assign(Error('deadlock'),{code:'40P01',severity:'ERROR'});let attempts=0;
 await assert.rejects(runPostgresTransaction(f.pool,async()=>{attempts++;throw failure;}),e=>e.sqlState==='40P01');
 assert.equal(attempts,1);assert.deepEqual(f.calls,['BEGIN ISOLATION LEVEL READ COMMITTED','ROLLBACK']);assert.deepEqual(f.releases,[false]);
});
test('falha no rollback descarta a conexao sem ocultar o conflito original',async()=>{
 const f=fakePool({failRollback:true}),failure=postgresError({code:'40001'});
 await assert.rejects(runPostgresTransaction(f.pool,async()=>{throw failure;}),e=>e===failure);assert.deepEqual(f.releases,[true]);
});
test('erro de dominio mantem identidade e status mesmo quando rollback falha',async()=>{
 const f=fakePool({failRollback:true}),failure=Object.assign(Error('Permissao revogada'),{status:403});
 await assert.rejects(runPostgresTransaction(f.pool,async()=>{throw failure;}),e=>e===failure);assert.deepEqual(f.releases,[true]);
});
test('commit de resultado incerto nao e repetido e devolve erro sem segredos',async()=>{
 const f=fakePool({failCommit:true,failRollback:true});let attempts=0;
 await assert.rejects(runPostgresTransaction(f.pool,async()=>{attempts++;return 'value';}),e=>!e.retryable&&!e.message.includes('secret'));
 assert.equal(attempts,1);assert.deepEqual(f.calls,['BEGIN ISOLATION LEVEL READ COMMITTED','COMMIT','ROLLBACK']);assert.deepEqual(f.releases,[true]);
});
test('BEGIN que falha nao executa o corpo e ainda libera a conexao',async()=>{
 const f=fakePool({failBegin:true});let entered=false;
 await assert.rejects(runPostgresTransaction(f.pool,async()=>{entered=true;}));assert.equal(entered,false);assert.deepEqual(f.releases,[false]);
});
test('falha na aquisicao e encapsulada sem expor credenciais',async()=>{
 await assert.rejects(runPostgresTransaction({async connect(){throw Object.assign(Error('postgres://secret'),{code:'ECONNREFUSED'});}},async()=>{}),error=>error.code===undefined&&!error.message.includes('secret'));
});
test('fechamento aguarda end dos clientes ja removidos pelo pool e e idempotente',async()=>{
 const pool=new EventEmitter(),client=new EventEmitter();let endCalls=0,finished=false;
 pool.end=async()=>{endCalls++;};const close=trackPoolShutdown(pool);pool.emit('connect',client);pool.emit('remove',client);
 const pending=close();pending.then(()=>{finished=true;});assert.equal(close(),pending);
 await new Promise(done=>setImmediate(done));assert.equal(finished,false);client.emit('end');await pending;assert.equal(finished,true);assert.equal(endCalls,1);
});
