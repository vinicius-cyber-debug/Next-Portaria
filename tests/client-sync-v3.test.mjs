import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSyncState} from '../lib/client-sync.mjs';

test('incremental sync updates and removes rows without mutating the offline snapshot',()=>{
  const original={visitors:[{id:'a',status:'inside'},{id:'b',status:'authorized'}],settings:{unitName:'Porto'},people:[{id:'p'}]};
  const next=mergeSyncState(original,{collections:{visitors:{upsert:[{id:'a',status:'completed'},{id:'c',status:'inside'}],remove:['b']}},values:{settings:{unitName:'Porto novo'}}});
  assert.deepEqual(next.visitors,[{id:'c',status:'inside'},{id:'a',status:'completed'}]);
  assert.deepEqual(original.visitors,[{id:'a',status:'inside'},{id:'b',status:'authorized'}]);
  assert.equal(original.settings.unitName,'Porto');assert.equal(next.settings.unitName,'Porto novo');assert.equal(next.people,original.people);
});
test('incremental audit retains the newest 100 records and handles expiry removals',()=>{
  const audit=Array.from({length:100},(_,index)=>({id:String(index),at:new Date(index*1000).toISOString()}));
  const next=mergeSyncState({audit},{collections:{audit:{upsert:[{id:'new',at:new Date(200000).toISOString()}],remove:['99']}}});
  assert.equal(next.audit.length,100);assert.equal(next.audit[0].id,'new');assert.equal(next.audit.some(row=>row.id==='99'),false);assert.equal(audit.length,100);
});
test('a removed record cannot be reintroduced by an overlapping delta entry',()=>{
  assert.deepEqual(mergeSyncState({visitors:[]},{collections:{visitors:{upsert:[{id:'expired'}],remove:['expired']}}}).visitors,[]);
  assert.throws(()=>mergeSyncState(null,{}),/estado inicial/);
});
