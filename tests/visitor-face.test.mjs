import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createInitialState,execute,validateState} from '../lib/domain.mjs';
import {jpegDimensions} from '../lib/visitor-photo.mjs';
import {handleApi} from '../lib/server.ts';
import {testSession} from './fixture-auth.mjs';
import {visitorFacePlan} from '../lib/integrations/visitor-face-plan.mjs';
const admin={id:'admin',name:'Admin QA',role:'admin'},gate={id:'gate',name:'Porteiro QA',role:'gate'},at=new Date().toISOString(),until=new Date(Date.now()+3600000).toISOString();
const photo={attachmentId:'attachment_11111111-1111-4111-8111-111111111111',sha256:'a'.repeat(64)},payload={name:'Visitante fictício',company:'Empresa fictícia',purpose:'Reunião',host:'Contato QA',expectedAt:at,validUntil:until,identityConfirmed:true,visitorPhoto:photo};
const apply=(state,type,data=payload,actor=gate)=>execute(state,{type,payload:data,at},actor);
const jpeg=(width=640,height=480)=>Uint8Array.from([255,216,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,0,3,17,0,255,217]);
test('porteiro autoriza somente portaria, com foto, conferência e sem registrar passagem',()=>{
 let state=apply(createInitialState(),'ACCESS_AREA_SAVE',{name:'Produção'},admin).state;
 const result=apply(state,'VISITOR_GATE_REGISTER');state=result.state;assert.equal(result.result.status,'authorized');assert.equal(result.result.areaId,null);assert.equal(result.result.enteredAt,null);assert.equal(result.result.faceEnrollment.status,'pending_integration');assert.equal(result.result.initialApprovedById,gate.id);validateState(state);
 for(const data of [{...payload,areaId:state.accessAreas[0].id},{...payload,responsibleUserId:'outra-pessoa'},{...payload,gateName:'Outra portaria'}])assert.throws(()=>apply(state,'VISITOR_GATE_REGISTER',data),{code:'FORBIDDEN'});
 state.settings.gateNames.push('Portaria de produção');
 assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id:result.result.id,gateName:'Portaria de produção',identityConfirmed:true}),{code:'FORBIDDEN'});
 assert.equal(apply(state,'VISITOR_CHECKIN',{id:result.result.id,gateName:result.result.gateName,identityConfirmed:true}).result.status,'inside');
});
test('foto e identidade são obrigatórias; solicitação comum continua aguardando aprovação',()=>{
 const state=createInitialState();assert.throws(()=>apply(state,'VISITOR_GATE_REGISTER',{...payload,visitorPhoto:null}),{code:'PHOTO_REQUIRED'});assert.throws(()=>apply(state,'VISITOR_GATE_REGISTER',{...payload,identityConfirmed:false}),{code:'IDENTITY_REQUIRED'});
 assert.equal(apply(state,'VISITOR_REQUEST',payload).result.status,'pending');
 const employee=apply(state,'MASTER_SAVE',{kind:'people',record:{name:'Funcionário QA',category:'employee',securityStatus:'cleared'}},admin);assert.throws(()=>apply(employee.state,'VISITOR_GATE_REGISTER',{...payload,personId:employee.result.id}),{code:'FORBIDDEN'});
});
test('não amplia escopo ou transfere foto; porteiro cancela somente sua própria liberação',()=>{
 const first=apply(createInitialState(),'VISITOR_GATE_REGISTER'),id=first.result.id;
 assert.throws(()=>apply(first.state,'RECORD_CORRECT',{kind:'visitor',id,reason:'Teste',changes:{areaId:'outro-setor'}},admin),{code:'INVALID_TRANSITION'});
 assert.throws(()=>apply(first.state,'VISITOR_GATE_REVOKE',{id,reason:'Teste'},{...gate,id:'other'}),{code:'FORBIDDEN'});
 const revoked=apply(first.state,'VISITOR_GATE_REVOKE',{id,reason:'Cadastro corrigido'});assert.equal(revoked.result.status,'revoked');validateState(revoked.state);
 const invalid=structuredClone(first.state);invalid.visitors[0].areaId='outro-setor';assert.throws(()=>validateState(invalid));
});
test('foto JPEG tem limite, dimensões e assinatura verificáveis; qualidade facial permanece do equipamento',()=>{
 assert.deepEqual(jpegDimensions(jpeg()),{width:640,height:480});for(const bytes of [jpeg(100,100),jpeg(3000,1000),new Uint8Array(2000000),new TextEncoder().encode('<svg/>')])assert.throws(()=>jpegDimensions(bytes));
});
test('plano facial é somente leitura, fixa um equipamento e exclui autorização revogada',()=>{
 const created=apply(createInitialState(),'VISITOR_GATE_REGISTER'),config={mode:'prepared',scope:'gate_only',hardwareWritesEnabled:false,targetDeviceId:'2',targetName:'Portaria QA',model:17,firmware:'fixture'},devices=[{id:'2',name:'Portaria QA',model:17,firmware:'fixture'},{id:'3',name:'Produção QA',model:17,firmware:'fixture'}];
 const plan=visitorFacePlan(created.state,config,devices,at);assert.equal(plan.hardwareWritesEnabled,false);assert.equal(plan.requests[0].targetDeviceId,'2');
 assert.throws(()=>visitorFacePlan(created.state,{...config,hardwareWritesEnabled:true},devices,at));assert.throws(()=>visitorFacePlan(created.state,{...config,targetDeviceId:'3'},devices,at));
 const cancelled=apply(created.state,'VISITOR_GATE_REVOKE',{id:created.result.id,reason:'Teste'});assert.equal(visitorFacePlan(cancelled.state,config,devices,at).requests[0].status,'inactive');
});
class D1{
 constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const n of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(n,dir),'utf8'));}
 prepare(sql){const sqlite=this.sqlite;return {sql,params:[],bind(...params){return {...this,params}},async first(){return sqlite.prepare(this.sql).get(...this.params)??null},async all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.params)}},async run(){return {success:true,results:[],meta:{changes:Number(sqlite.prepare(this.sql).run(...this.params).changes)}}}};}
 async batch(items){this.sqlite.exec('BEGIN');try{const results=items.map(s=>({success:true,results:this.sqlite.prepare(s.sql).all(...s.params)}));this.sqlite.exec('COMMIT');return results;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
test('API vincula foto privada do operador e mantém replay idempotente, sem cadastro facial falso',async()=>{
 const db=new D1(),objects=new Map(),bucket={async put(key,value){objects.set(key,new Uint8Array(value));},async get(key){const b=objects.get(key);return b?{size:b.length,body:new Response(b).body}:null;},async head(key){const b=objects.get(key);return b?{size:b.length}:null;},async delete(key){objects.delete(key);}};
 try{
  const owner={id:'admin',name:'Admin QA',email:'admin@example.test'},cookie=testSession(db,owner),origin='https://fixture.example';
  async function call(path,method='GET',body,session=cookie){const response=await handleApi(new Request(origin+'/api'+path,{method,headers:{...(session?{cookie:session}:{}),...(method==='GET'?{}:{origin}),...(body instanceof FormData?{}:body?{'content-type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)}),db,{bucket});return {response,body:response.headers.get('content-type')?.includes('json')?await response.json():null};}
  await call('/state');let state=(await call('/state')).body;
  const form=new FormData();form.set('file',new File([jpeg()],'visitante.jpg',{type:'image/jpeg'}));const upload=await call('/visitor-photos','POST',form);assert.equal(upload.response.status,200);
  const command={type:'VISITOR_GATE_REGISTER',payload:{...payload,visitorPhoto:undefined,photoAttachmentId:upload.body.attachment.id},revision:upload.body.revision,idempotencyKey:'face-register-test'};
  const registered=await call('/commands','POST',command);assert.equal(registered.response.status,200,JSON.stringify(registered.body));assert.equal(registered.body.result.faceEnrollment.status,'pending_integration');
  const id=registered.body.result.id,replay=await call('/commands','POST',command);assert.equal(replay.response.status,200);assert.equal(replay.body.revision,registered.body.revision);
  assert.equal((await call('/visitor-photos/'+id,'GET',undefined,'')).response.status,401);const image=await call('/visitor-photos/'+id);assert.equal(image.response.status,200);assert.match(image.response.headers.get('cache-control'),/no-store/);
  state=(await call('/state')).body;assert.equal(state.state.visitors[0].enteredAt,null);validateState({...state.state,settings:{...createInitialState().settings,...state.state.settings}});
  const bad=new FormData();bad.set('file',new File(['fake'],'foto.jpg',{type:'image/jpeg'}));assert.equal((await call('/visitor-photos','POST',bad)).response.status,400);
 }finally{db.sqlite.close();}
});
