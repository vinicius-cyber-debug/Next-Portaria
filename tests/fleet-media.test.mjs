import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {MediaService} from '../lib/media.ts';
import {FileObjectStore} from '../lib/storage/filesystem.ts';
import {hasPostgres,withPostgresFixture} from './support/postgres-fixture.mjs';

test('vistoria mantém álbuns privados distintos, retomada e bloqueio da etapa encerrada',{skip:!hasPostgres},async()=>{
 const root=await mkdtemp(join(tmpdir(),'portaria-fleet-media-'));
 try{await withPostgresFixture(async({db,owner})=>{
  const now=new Date().toISOString(),user={id:'qa_fleet',name:'QA Frota',role:'admin',status:'active',capabilities:{documentView:true,incidentManage:true}};
  await owner.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,'fleet@example.test',$2,'admin','active',$3,$3)",[user.id,user.name,now]);
  await owner.query('INSERT INTO operational_meta(id,revision) VALUES(1,0) ON CONFLICT DO NOTHING');
  await owner.query("INSERT INTO operational_records(collection,id,body) VALUES('fleetTrips','trip_qa',$1),('incidents','incident_qa',$2)",[JSON.stringify({id:'trip_qa',status:'out'}),JSON.stringify({id:'incident_qa',status:'open'})]);
  const media=new MediaService(db,new FileObjectStore(root)),context={user,authorize:async()=>user};
  async function call(path,{method='GET',data,bytes,actor=context}={}){
   const response=await media.handle(new Request('https://fixture.test/api/media/'+path,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(bytes?{'x-content-sha256':createHash('sha256').update(bytes).digest('hex')}: {})},body:data?JSON.stringify(data):bytes}),actor);
   return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.arrayBuffer()};
  }
  const image=Buffer.from([255,216,255,224,0,16,74,70,73,70]);
  const begin=(phase,record='trip_qa')=>call('uploads',{method:'POST',data:{recordId:record,recordCollection:'fleetTrips',phase,name:phase+'.jpg',type:'image/jpeg',size:image.length}});
  const complete=async(phase)=>{
   const upload=await begin(phase);assert.equal(upload.status,201,JSON.stringify(upload.data));
   assert.equal((await call('uploads/'+upload.data.id+'/parts/0',{method:'PUT',bytes:image})).status,200);
   assert.equal((await call('uploads/'+upload.data.id)).data.phase,phase);
   assert.equal((await call('uploads/'+upload.data.id+'/complete',{method:'POST'})).status,200);
   return upload.data;
  };
  assert.equal((await begin('return')).status,409);
  assert.equal((await begin('wrong')).status,400);
  assert.equal((await begin('departure','missing')).status,404);
  const departure=await complete('departure');
  assert.equal((await call('records?id=trip_qa&recordCollection=fleetTrips&phase=departure')).data.assets.length,1);
  assert.equal((await call('records?id=trip_qa&recordCollection=fleetTrips&phase=return')).data.assets.length,0);
  assert.equal((await call('records?id=incident_qa')).data.assets.length,0);
  const pending=await begin('departure');assert.equal(pending.status,201);
  assert.equal((await call('uploads?recordId=trip_qa&recordCollection=fleetTrips&phase=return')).data.uploads.length,0);
  await owner.query("UPDATE operational_records SET body=$1 WHERE collection='fleetTrips' AND id='trip_qa'",[JSON.stringify({id:'trip_qa',status:'returned'})]);
  assert.equal((await begin('departure')).status,409);
  assert.equal((await call('uploads/'+pending.data.id+'/parts/0',{method:'PUT',bytes:image})).status,409);
  assert.equal((await call('uploads/'+pending.data.id+'/complete',{method:'POST'})).status,409);
  assert.equal((await call('uploads/'+pending.data.id,{method:'DELETE'})).status,200);
  const returned=await complete('return');
  const list=await call('records?id=trip_qa&recordCollection=fleetTrips&phase=return');assert.equal(list.data.assets.length,1);assert.equal(list.data.assets[0].id,returned.assetId);
  const denied={user:{...user,capabilities:{documentView:false}},authorize:async()=>({...user,capabilities:{documentView:false}})};
  assert.equal((await call(departure.assetId+'/content',{actor:denied})).status,403);
  assert.equal((await call(departure.assetId+'/content')).status,200);
  assert.equal((await call(returned.assetId+'/content')).status,200);
  // Existing incidents still use the default phase and collection, without new fields.
  assert.equal((await call('uploads',{method:'POST',data:{recordId:'incident_qa',name:'legacy.jpg',type:'image/jpeg',size:image.length}})).status,201);
  const links=(await owner.query("SELECT collection,phase FROM media_links WHERE record_id='trip_qa' ORDER BY phase")).rows;
  assert.ok(links.every(row=>row.collection==='fleetTrips'&&['departure','return'].includes(row.phase)));
 });}finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep))throw Error('Pasta QA inválida.');await rm(root,{recursive:true,force:true});}
});
