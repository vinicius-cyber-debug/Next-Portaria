import test from 'node:test';
import assert from 'node:assert/strict';
import {SimulatedDeviceAdapter,eventDeduplicationKey} from '../lib/integrations/simulator.ts';
import {CONTROL_ID_PREPARATION} from '../lib/integrations/controlid-preparation.ts';
const event={deviceId:'sim-a',generation:'generation-1',nativeEventId:'9007199254740993',sourceRevision:'v1',occurredAt:'2026-11-06T12:00:00Z',nativeUserId:'9007199254740995',direction:'entry',kind:'authorization_granted'};
const fixtures=()=>({deviceId:'sim-a',users:[{nativeUserId:event.nativeUserId,displayName:'Pessoa fictícia'}],events:[event,{...event,nativeEventId:'9007199254740994'}]});
test('simulador consulta informacao, usuarios e eventos sem rede ou comandos fisicos',async t=>{
 const network=t.mock.method(globalThis,'fetch',()=>{throw Error('Nenhuma rede autorizada.');}),adapter=new SimulatedDeviceAdapter(fixtures());
 assert.equal((await adapter.inspect()).mode,'simulation');assert.equal((await adapter.readUsers()).items[0].nativeUserId,'9007199254740995');assert.equal((await adapter.readEvents()).items[0].nativeEventId,'9007199254740993');assert.equal(network.mock.callCount(),0);
 assert.equal(typeof adapter.unlock,'undefined');assert.equal(typeof adapter.createUser,'undefined');assert.equal(typeof adapter.enrollFace,'undefined');
});
test('reinicio do simulador retoma cursor apenas da mesma fonte e conserva IDs de 64 bits',async()=>{
 const first=await new SimulatedDeviceAdapter(fixtures()).readEvents({limit:1}),restarted=new SimulatedDeviceAdapter(fixtures());
 const last=await restarted.readEvents({cursor:first.nextCursor});assert.equal(last.items[0].nativeEventId,'9007199254740994');assert.equal(last.nextCursor,null);
 await assert.rejects(restarted.readUsers({cursor:first.nextCursor}),e=>e.kind==='invalid_input');
 const changed=fixtures();changed.events.push({...event,nativeEventId:'9007199254740996'});await assert.rejects(new SimulatedDeviceAdapter(changed).readEvents({cursor:first.nextCursor}),e=>e.kind==='invalid_input');
});
test('offline e timeout falham sem devolver permissoes antigas; recuperacao e explicita',async()=>{
 const adapter=new SimulatedDeviceAdapter(fixtures());await adapter.inspect();
 for(const kind of ['offline','timeout','authentication']){adapter.setFailure(kind);await assert.rejects(adapter.readEvents(),e=>e.kind===kind&&e.retryable===(kind!=='authentication'));}
 adapter.setFailure(null);assert.equal((await adapter.readEvents()).items.length,2);
 const abort=new AbortController();abort.abort();await assert.rejects(adapter.inspect(abort.signal),e=>e.kind==='aborted');
});
test('deduplicacao distingue alteracao do log, equipamento, geracao e confirmacao de passagem',()=>{
 const key=eventDeduplicationKey(event);assert.equal(key,eventDeduplicationKey(structuredClone(event)));
 for(const changes of [{sourceRevision:'v2',kind:'passage_abandoned'},{deviceId:'sim-b'},{generation:'generation-2'},{kind:'passage_confirmed'}])assert.notEqual(key,eventDeduplicationKey({...event,...changes}));
});
test('fixtures invalidas, IDs numericos inseguros e cursores invalidos sao recusados',async()=>{
 assert.throws(()=>new SimulatedDeviceAdapter({...fixtures(),events:[{...event,nativeEventId:9007199254740992}]}),e=>e.kind==='invalid_input');
 assert.throws(()=>new SimulatedDeviceAdapter({...fixtures(),events:[{...event,deviceId:'sim-b'}]}),e=>e.kind==='invalid_input');
 const adapter=new SimulatedDeviceAdapter(fixtures());await assert.rejects(adapter.readEvents({limit:0}));await assert.rejects(adapter.readEvents({cursor:'invalid'}));
 await assert.rejects(adapter.readEvents({cursor:Buffer.from('null').toString('base64url')}),e=>e.kind==='invalid_input');
});
test('resultados nao alteram fixtures e simulacao nao comprova suporte em Control iD',async()=>{
 const data=fixtures(),adapter=new SimulatedDeviceAdapter(data),page=await adapter.readEvents();page.items[0].kind='passage_confirmed';assert.equal((await adapter.readEvents()).items[0].kind,'authorization_granted');
 assert.equal((await adapter.inspect()).capabilities.permissionSync.support,'unsupported');assert.equal((await adapter.inspect()).capabilities.inspect.evidence,'simulation');
 assert.equal(CONTROL_ID_PREPARATION.hardwareAdapterAvailable,false);assert.equal(CONTROL_ID_PREPARATION.physicalCommandsAvailable,false);
});
