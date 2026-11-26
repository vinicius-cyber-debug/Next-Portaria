import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {centralFixture} from './support/idsecure-central-fixture.mjs';
import {IdSecureHttp} from '../lib/integrations/idsecure-http.ts';
import {IdSecureReader} from '../lib/integrations/idsecure.ts';
import {IdSecureExitGateway,validateExitGatewayConfig,targetHash} from '../lib/exit-access/idsecure-gateway.ts';

test('gateway HTTPS: identidade, regra manual individual, sentido de saída e confirmação',{timeout:40000},async t=>{
 const temporary=await mkdtemp(join(tmpdir(),'next-portaria-exit-gateway-')),central=await centralFixture(temporary);
 try{
  const http=new IdSecureHttp(central.credentials,central.tls.ca.toString('utf8')),gateway=new IdSecureExitGateway(central.config,http),binding={person_id:'employee-a',source_id:'qa-central',native_user_id:'101',target_hash:gateway.targetHash,manual_rule_id:null};
  await t.test('certificado fixado e configuração inválida nunca alcançam a rede',async()=>{
   assert.throws(()=>new IdSecureHttp({...central.credentials,password:central.credentials.username},central.tls.ca.toString()),error=>error.kind==='authentication');
   try{for(const status of [400,401,403]){central.state.loginStatus=status;const denied=new IdSecureHttp(central.credentials,central.tls.ca.toString());await assert.rejects(denied.call('/api/util/configUI','GET'),error=>error.kind==='authentication'&&error.httpStatus===status&&error.phase==='authentication');}}finally{central.state.loginStatus=200;}
   assert.equal(targetHash(central.target),targetHash(Object.fromEntries(Object.entries(central.target).reverse())));
   assert.throws(()=>new IdSecureHttp({...central.credentials,sourceId:undefined},central.tls.ca.toString()));
   assert.throws(()=>new IdSecureHttp({...central.credentials,fingerprint256:'AA:'.repeat(31)+'AA'},central.tls.ca.toString()));
   for(const target of [{...central.target,exitReaderId:'3'},{...central.target,deviceId:2},{...central.target,sourceId:undefined}])assert.throws(()=>validateExitGatewayConfig({...central.config,target}));
   for(const path of ['/api/../login','//evil.invalid/api/','https://evil.invalid/api/'])await assert.rejects(http.call(path,'GET'));
  });
  await t.test('somente regra manual de um funcionário na saída; preparo é idempotente',async()=>{
   binding.manual_rule_id=await gateway.provision(binding);assert.equal(await gateway.provision(binding),binding.manual_rule_id);
   assert.equal(central.rules.size,1);const rule=[...central.rules.values()][0];
   assert.deepEqual(rule.users,['301']);assert.deepEqual(rule.devices,['2']);assert.deepEqual(rule.areas,['4']);assert.deepEqual(rule.schedules,[1]);assert.deepEqual(rule.groups,[]);assert.equal(rule.ManualAuthorizationOption,1);
   assert.equal(central.requests.filter(row=>row.method==='POST'&&row.path==='/api/rule/').length,1);
  });
  await t.test('mudança no sentido, serial ou contingência recusa operação',async()=>{
   central.state.serial='OUTRO';await assert.rejects(gateway.inspect());central.state.serial=central.target.serial;
   central.state.configuration.DefaultContingency=true;await assert.rejects(gateway.inspect());central.state.configuration.DefaultContingency=false;
   const other=new IdSecureExitGateway({...central.config,target:{...central.target,exitRotation:'clockwise'}},http);await assert.rejects(other.inspect());await gateway.inspect();
  });
  await t.test('entrada, outros leitores e eventos não pendentes não viram comandos',async()=>{
   central.pending('101',{idReader:3,idArea:1,area:'Entrada QA'});central.pending('101',{idDevice:3});central.pending('101',{eventCode:13});central.pending('101',{functionDetail:0});central.pending();
   const events=await gateway.readEvents(),pending=events.filter(row=>row.state==='pending');assert.equal(pending.length,1);
   const event=pending[0];
   for(const changed of [{...event,eventId:'0'},{...event,deviceId:'3'},{...event,areaId:'1'},{...event,state:'authorized'},{...event,occurredAt:new Date(Date.now()-20000).toISOString()},{...event,nativeUserId:'102'}])await assert.rejects(gateway.authorize(changed,new Date(Date.now()+900000).toISOString()));
   await assert.rejects(gateway.authorize(event,new Date(Date.now()+1000).toISOString()));
   await gateway.authorize(event,new Date(Date.now()+900000).toISOString());assert.equal(await gateway.confirm(event),true);
   await assert.rejects(gateway.authorize(event,new Date(Date.now()+900000).toISOString()));
   assert.deepEqual(central.requests.filter(row=>row.path.includes('/action/')).map(row=>row.path),['/api/util/action/2/catra/allow=anticlockwise,reason=3/'+event.eventId]);
  });
  await t.test('leitor de importação continua sem capacidade de escrita',async()=>{
   const reader=await IdSecureReader.fromFile(central.config.credentialFile);
   await assert.rejects(reader.call('/api/rule/','POST',{}));await assert.rejects(reader.call('/api/util/action/2/catra/allow=both/0','GET'));
  });
  await t.test('regra adulterada não é apagada; remoção confirmada preserva regras alheias',async()=>{
   const rule=central.rules.get(binding.manual_rule_id);rule.areas.push('1');await assert.rejects(gateway.verifyBinding(binding));await assert.rejects(gateway.remove(binding));rule.areas=['4'];
   central.rules.set('999',{id:'999',name:'Regra anterior da empresa'});await gateway.remove(binding);assert.equal(central.rules.size,1);assert.ok(central.rules.has('999'));
   assert.ok(central.requests.every(row=>row.path==='/api/user/list'||!/^\/api\/(?:user\/|schedule|group)/.test(row.path)||row.method!=='POST'));
   assert.equal(central.requests.filter(row=>row.method==='DELETE').length,1);
  });
 }finally{await central.close();if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Pasta de QA fora do diretório temporário.');await rm(temporary,{recursive:true,force:true});}
});
