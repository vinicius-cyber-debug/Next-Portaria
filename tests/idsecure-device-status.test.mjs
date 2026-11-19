import assert from 'node:assert/strict';
import test from 'node:test';
import {IdSecureReader} from '../lib/integrations/idsecure.ts';

function reader(statuses){
 const calls=[],client=Object.create(IdSecureReader.prototype);
 client.call=async(path,method,body)=>{
  calls.push({path,method,body});
  if(path==='/api/device/')return {data:[{id:2,name:'Portaria QA',model:17,versao:'fixture',idfaceCount:2,isCurrentlyOnline:false,user:'private-user',password:'private-password'}]};
  if(path==='/api/util/DevicesSyncStatus')return statuses;
  throw Error('Consulta inesperada.');
 };
 return {client,calls};
}
test('status da tela não é confundido com o indicador histórico de conexão',async()=>{
 const {client,calls}=reader([{id:2,syncStatus:0}]);
 const [device]=await client.readDevices();
 assert.equal(device.online,false);
 assert.equal(device.synchronization,'synchronized');
 assert.deepEqual(calls,[{path:'/api/device/',method:'GET',body:undefined},{path:'/api/util/DevicesSyncStatus',method:'GET',body:undefined}]);
 assert.doesNotMatch(JSON.stringify(device),/private-user|private-password/);
});
test('falha, sincronização em andamento e status ausente permanecem distintos',async()=>{
 for(const [statuses,expected] of [[[{id:2,syncStatus:1}],'synchronizing'],[[{id:2,syncStatus:2}],'failed'],[[{id:2,syncStatus:3}],'collecting_logs'],[[],'unknown'],[[{id:2,syncStatus:99}],'unknown']]){
  const {client}=reader(statuses);assert.equal((await client.readDevices())[0].synchronization,expected);
 }
});
test('status ambíguo ou malformado não é aceito como prontidão',async()=>{
 for(const statuses of [null,{},[{id:2,syncStatus:0},{id:2,syncStatus:2}],[null],[{id:'invalid',syncStatus:0}]]){
  const {client}=reader(statuses);await assert.rejects(client.readDevices(),{kind:'invalid_input'});
 }
});
test('endpoint de status continua sem aceitar escrita ou parâmetros de comando',async()=>{
 const client=Object.create(IdSecureReader.prototype);
 for(const [path,method] of [['/api/util/DevicesSyncStatus','POST'],['/api/util/DevicesSyncStatus?command=sync','GET'],['/api/util/connect','POST']]){
  await assert.rejects(client.call(path,method,{}),{kind:'unsupported'});
 }
});
