import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient,QueryResultRow} from 'pg';
import {PostgresDatabase} from '../persistence/postgres.ts';
import type {MediaContext} from '../persistence/contracts.ts';
import {PortoError,PORTO_UNIT,PORTO_TIMEZONE,calendarCharge,fail,portoPermissions,requirePorto,tariffTable,portRequest,text} from './domain.mjs';

type Row=Record<string,unknown>;
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store, private','pragma':'no-cache','vary':'Cookie','x-content-type-options':'nosniff'};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
const id=(prefix:string)=>prefix+'_'+randomUUID();
function publicRow(value:unknown):unknown{
 if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(publicRow);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase()),publicRow(child)]));return value;
}
function canonical(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>JSON.stringify(key)+':'+canonical(child)).join(',')+'}';return JSON.stringify(value)}
function redact(value:unknown,financial:boolean):unknown{if(Array.isArray(value))return value.map(child=>redact(child,financial));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>financial||!/centavos$/i.test(key)).map(([key,child])=>[key,redact(child,financial)]));return value}
function page(query:URLSearchParams){const index=Number(query.get('page')||1),size=Number(query.get('pageSize')||20);if(!Number.isSafeInteger(index)||index<1||index>1000000||!Number.isSafeInteger(size)||size<1||size>50)fail('VALIDATION','Paginação inválida.');return {index,size,offset:(index-1)*size}}
function total(value:unknown){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)fail('AMOUNT_OVERFLOW','Total fora do intervalo seguro.');return n}
const actions:Record<string,'tariffs'|'request'|'approve'|'entry'>={TARIFAS_PUBLICAR:'tariffs',SOLICITAR_DESCIDA:'request',APROVAR_DESCIDA:'approve',RECUSAR_DESCIDA:'approve',REGISTRAR_ENTRADA:'entry'};

export class PortoService {
 readonly db:PostgresDatabase;readonly enabled:boolean;
 constructor(db:PostgresDatabase,enabled=false){this.db=db;this.enabled=enabled}
 async restoreGuard(){const present=await this.db.prepare("SELECT to_regclass('public.porto_solicitacoes') AS present").first<{present:string|null}>();return present?.present?[this.db.prepare('SELECT porto_assert_json_restore()')]:[]}
 private async transaction<T>(context:MediaContext,operation:(client:PoolClient,user:MediaContext['user'],now:string)=>Promise<T>){
  return this.db.transaction(async(client,scoped)=>{
   // The same lock serializes user/capability changes, JSON restoration and Porto mutations.
   await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
   const user=await context.authorize(scoped);requirePorto(user,'view');
   const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
   return operation(client,user,now);
  });
 }
 private async audit(client:PoolClient,user:MediaContext['user'],action:string,entity:string,data:Row){await client.query('INSERT INTO porto_eventos(id,unidade_id,entidade_id,acao,ator_id,ator_nome,dados) VALUES($1,$2,$3,$4,$5,$6,$7)',[id('pe'),PORTO_UNIT,entity,action,user.id,user.name,JSON.stringify(data)])}
 private async fleet(client:PoolClient,vehicleId:string){const vehicle=(await client.query<{body:string}>("SELECT body FROM operational_records WHERE collection='fleet' AND id=$1 FOR UPDATE",[vehicleId])).rows[0];if(!vehicle)fail('NOT_FOUND','Veículo não encontrado no cadastro.',404);const record=JSON.parse(vehicle.body);if(record.active===false)fail('VEHICLE_INACTIVE','O veículo está desativado.');return record as {plate:string}}
 private async driver(client:PoolClient,driverId:string|null){if(!driverId)return;const person=(await client.query<{body:string}>("SELECT body FROM operational_records WHERE collection='people' AND id=$1 FOR UPDATE",[driverId])).rows[0];if(!person)fail('NOT_FOUND','Motorista não encontrado no cadastro.',404);if(JSON.parse(person.body).active===false)fail('DRIVER_INACTIVE','O motorista está desativado.')}
 private async activeTariffs(client:PoolClient,now:string){const table=(await client.query('SELECT * FROM porto_tabelas_tarifarias WHERE unidade_id=$1 AND vigencia_inicio<=$2 ORDER BY vigencia_inicio DESC LIMIT 1',[PORTO_UNIT,now])).rows[0];const entries=table?(await client.query('SELECT * FROM porto_tarifas WHERE tabela_id=$1 ORDER BY categoria_nome,id',[table.id])).rows:[];return {table,entries}}
 async handle(request:Request,context:MediaContext,body?:Row):Promise<Response>{
  try{
   const url=new URL(request.url),path=url.pathname.replace(/\/$/,''),method=request.method;
   if(path==='/api/porto/status'&&method==='GET')return json({enabled:this.enabled,phase:1,timezone:PORTO_TIMEZONE,permissions:portoPermissions(context.user)});
   if(!this.enabled)fail('PORTO_DISABLED','Gestão do Porto não habilitada nesta instalação.',503);
   const available=await this.db.prepare("SELECT to_regclass('public.porto_permanencias') AS present").first<{present:string|null}>();
   if(!available?.present)fail('PORTO_MIGRATION_REQUIRED','A migração PostgreSQL da Gestão do Porto ainda não foi aplicada.',503);
   return await this.transaction(context,async(client,user,now)=>{
    const permissions=portoPermissions(user);
    if(method==='POST'&&path==='/api/porto/comandos'){
     const type=text(body?.tipo,'Comando',60),key=text(body?.idempotencyKey,'Identificador da operação',100),payload=body?.payload;
     if(!/^[a-zA-Z0-9_-]{16,100}$/.test(key)||!payload||typeof payload!=='object'||Array.isArray(payload))fail('VALIDATION','Comando ou identificador inválido.');
     if(!Object.hasOwn(actions,type))fail('PHASE_NOT_AVAILABLE','Operação não disponível na Fase 1. Saída e cobrança serão implementadas na mesma transação na Fase 2.');
     requirePorto(user,actions[type]);
     const hash=createHash('sha256').update(canonical({type,payload})).digest('hex');
     const previous=(await client.query('SELECT * FROM porto_comandos WHERE id=$1',[key])).rows[0];
     if(previous){if(previous.ator_id!==user.id||previous.hash!==hash)fail('IDEMPOTENCY_CONFLICT','Identificador já utilizado por outra operação.',409);return json({result:redact(publicRow(previous.resultado),permissions.financial),replayed:true})}
     const result=await this.execute(client,user,type,payload as Row,now);
     await client.query('INSERT INTO porto_comandos(id,ator_id,hash,resultado) VALUES($1,$2,$3,$4)',[key,user.id,hash,JSON.stringify(result)]);
     return json({result:redact(publicRow(result),permissions.financial),replayed:false});
    }
    if(method!=='GET')fail('METHOD_NOT_ALLOWED','Método não permitido.',405);
    if(path==='/api/porto/resumo'){
     const counts=(await client.query("SELECT count(*) FILTER(WHERE status='pendente') AS pendentes,count(*) FILTER(WHERE status='aprovada' AND NOT EXISTS(SELECT 1 FROM porto_permanencias p WHERE p.solicitacao_id=s.id)) AS aprovadas FROM porto_solicitacoes s WHERE unidade_id=$1",[PORTO_UNIT])).rows[0];
     const active=(await client.query("SELECT count(*) AS presentes,COALESCE(sum((((($2::timestamptz AT TIME ZONE 'America/Manaus')::date-(entrada_em AT TIME ZONE 'America/Manaus')::date)+1)::bigint)*valor_diaria_centavos),0) AS estimativa FROM porto_permanencias WHERE unidade_id=$1 AND saida_em IS NULL",[PORTO_UNIT,now])).rows[0];
     return json({phase:1,agora:now,fuso:PORTO_TIMEZONE,permissions,pendentes:total(counts.pendentes),aprovadas:total(counts.aprovadas),presentes:total(active.presentes),...(permissions.financial?{estimativaTotalCentavos:total(active.estimativa)}:{})});
    }
    if(path==='/api/porto/tarifas'){
     const active=await this.activeTariffs(client,now);return json(redact(publicRow({tabela:active.table??null,tarifas:active.entries,agora:now}),permissions.financial));
    }
    const pagination=page(url.searchParams),q=(url.searchParams.get('q')||'').trim();if(q.length>150)fail('VALIDATION','Busca muito longa.');
    if(path==='/api/porto/tabelas'){
     requirePorto(user,'tariffs');const rows=(await client.query('SELECT * FROM porto_tabelas_tarifarias WHERE unidade_id=$1 ORDER BY vigencia_inicio DESC,id LIMIT $2 OFFSET $3',[PORTO_UNIT,pagination.size,pagination.offset])).rows;
     const count=total((await client.query('SELECT count(*) AS total FROM porto_tabelas_tarifarias WHERE unidade_id=$1',[PORTO_UNIT])).rows[0].total);
     return json({rows:publicRow(rows),page:pagination.index,total:count,totalPages:Math.max(1,Math.ceil(count/pagination.size))});
    }
    if(path==='/api/porto/cadastros'){
     const collection=url.searchParams.get('collection');if(!['fleet','people'].includes(collection||''))fail('VALIDATION','Cadastro inválido.');
     const found=(await client.query("SELECT id,body FROM operational_records WHERE collection=$1 AND COALESCE(body::jsonb->>'active','true')<>'false' AND position(lower($2) in lower(COALESCE(body::jsonb->>'name','')||' '||COALESCE(body::jsonb->>'plate','')||' '||COALESCE(body::jsonb->>'company',''))) >0 ORDER BY id LIMIT $3 OFFSET $4",[collection,q,pagination.size,pagination.offset])).rows;
     return json({rows:found.map(row=>{const value=JSON.parse(row.body);return {id:row.id,name:value.name??'',plate:value.plate??'',driver:value.driver??'',company:value.company??''}}),page:pagination.index});
    }
    if(path==='/api/porto/eventos'){
     requirePorto(user,'audit');const rows=(await client.query('SELECT id,entidade_id,acao,ocorrido_em,ator_id,ator_nome,dados FROM porto_eventos WHERE unidade_id=$1 ORDER BY sequencia DESC LIMIT $2 OFFSET $3',[PORTO_UNIT,pagination.size,pagination.offset])).rows;
     const count=total((await client.query('SELECT count(*) AS total FROM porto_eventos WHERE unidade_id=$1',[PORTO_UNIT])).rows[0].total);return json({rows:publicRow(rows),page:pagination.index,total:count,totalPages:Math.max(1,Math.ceil(count/pagination.size))});
    }
    if(path==='/api/porto/solicitacoes'||path==='/api/porto/permanencias'){
     const requests=path.endsWith('/solicitacoes'),status=url.searchParams.get('status')||'',valid=requests?['pendente','aprovada','recusada']:['em_andamento','encerrada'];
     if(status&&!valid.includes(status))fail('VALIDATION','Situação inválida.');
     const from=requests?'porto_solicitacoes s LEFT JOIN porto_permanencias p ON p.solicitacao_id=s.id':'porto_permanencias s JOIN porto_solicitacoes r ON r.id=s.solicitacao_id';
     const where="s.unidade_id=$1 AND ($2='' OR s.status=$2) AND position(lower($3) in lower(s.placa||' '||s.motorista_nome))>0";
     const rows=(await client.query(`SELECT ${requests?'s.*,p.id AS permanencia_id':'s.*,r.embarcacao_destino,r.finalidade'} FROM ${from} WHERE ${where} ORDER BY s.${requests?'solicitada_em':'entrada_em'} DESC,s.id LIMIT $4 OFFSET $5`,[PORTO_UNIT,status,q,pagination.size,pagination.offset])).rows;
     const count=total((await client.query(`SELECT count(*) AS total FROM ${from} WHERE ${where}`,[PORTO_UNIT,status,q])).rows[0].total);
     const values=rows.map(row=>requests?row:{...row,previa:calendarCharge(row.entrada_em.toISOString(),row.saida_em?.toISOString()??now,row.valor_diaria_centavos)});
     return json(redact(publicRow({rows:values,total:count,page:pagination.index,totalPages:Math.max(1,Math.ceil(count/pagination.size)),agora:now}),permissions.financial));
    }
    fail('NOT_FOUND','Recurso da Gestão do Porto não encontrado.',404);
   });
  }catch(error){
   if(error instanceof PortoError)return json({error:{code:error.code,message:error.message}},error.status);
   const failure=error as {sqlState?:string;code?:string};
   if(failure.sqlState==='23505'||failure.code==='23505')return json({error:{code:'DUPLICATE','message':'O veículo já tem permanência aberta ou a operação já foi registrada.'}},409);
   throw error;
  }
 }
 private async execute(client:PoolClient,user:MediaContext['user'],type:string,payload:Row,now:string):Promise<QueryResultRow>{
  if(type==='TARIFAS_PUBLICAR'){
   const table=tariffTable(payload,now),tableId=id('pt');
   await client.query('INSERT INTO porto_tabelas_tarifarias(id,unidade_id,nome,vigencia_inicio,publicado_em,publicado_por,justificativa) VALUES($1,$2,$3,$4,$5,$6,$7)',[tableId,PORTO_UNIT,table.nome,table.vigenciaInicio,now,user.id,table.justificativa]);
   for(const entry of table.tarifas)await client.query('INSERT INTO porto_tarifas(id,tabela_id,categoria_codigo,categoria_nome,diaria_centavos) VALUES($1,$2,$3,$4,$5)',[id('pr'),tableId,entry.codigo,entry.nome,entry.valorDiariaCentavos]);
   await this.audit(client,user,type,tableId,{nome:table.nome,vigenciaInicio:table.vigenciaInicio,tarifas:table.tarifas,justificativa:table.justificativa});return {id:tableId};
  }
  if(type==='SOLICITAR_DESCIDA'){
   const data=portRequest(payload),fleet=await this.fleet(client,data.veiculoId);await this.driver(client,data.motoristaId);
   const active=await this.activeTariffs(client,now);if(!active.entries.some(entry=>entry.categoria_codigo===data.categoriaCodigo))fail('TARIFF_UNAVAILABLE','Cadastre uma tarifa vigente para essa categoria antes de solicitar a descida.');
   const requestId=id('ps');await client.query('INSERT INTO porto_solicitacoes(id,unidade_id,veiculo_id,placa,motorista_id,motorista_nome,categoria_codigo,finalidade,embarcacao_destino,observacoes,solicitada_em,solicitada_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[requestId,PORTO_UNIT,data.veiculoId,fleet.plate,data.motoristaId,data.motoristaNome,data.categoriaCodigo,data.finalidade,data.embarcacaoDestino,data.observacoes,now,user.id]);
   await this.audit(client,user,type,requestId,{...data,placa:fleet.plate});return {id:requestId};
  }
  const requestId=text(payload.id,'Solicitação',120),record=(await client.query('SELECT * FROM porto_solicitacoes WHERE id=$1 AND unidade_id=$2 FOR UPDATE',[requestId,PORTO_UNIT])).rows[0];
  if(!record)fail('NOT_FOUND','Solicitação não encontrada.',404);
  if(type==='APROVAR_DESCIDA'||type==='RECUSAR_DESCIDA'){
   if(record.status!=='pendente')fail('INVALID_TRANSITION','A solicitação já foi decidida.',409);
   const reason=text(payload.justificativa,'Justificativa',500),status=type==='APROVAR_DESCIDA'?'aprovada':'recusada';
   await client.query('UPDATE porto_solicitacoes SET status=$1,decidida_em=$2,decidida_por=$3,motivo_decisao=$4 WHERE id=$5',[status,now,user.id,reason,requestId]);
   await this.audit(client,user,type,requestId,{status,justificativa:reason});return {id:requestId,status};
  }
  if(record.status!=='aprovada')fail('APPROVAL_REQUIRED','A descida precisa estar aprovada antes da entrada.',409);
  if(payload.veiculoConferido!==true)fail('IDENTITY_REQUIRED','Confirme a conferência do veículo apresentado.');
  const vehicle=await this.fleet(client,record.veiculo_id);await this.driver(client,record.motorista_id);
  if(vehicle.plate!==record.placa)fail('VEHICLE_CHANGED','O cadastro da placa mudou após a solicitação. Registre uma nova solicitação.');
  const exists=(await client.query('SELECT id FROM porto_permanencias WHERE unidade_id=$1 AND (solicitacao_id=$2 OR (veiculo_id=$3 AND saida_em IS NULL))',[PORTO_UNIT,requestId,record.veiculo_id])).rows[0];
  if(exists)fail('VEHICLE_ALREADY_INSIDE','O veículo ou a solicitação já possui permanência aberta.',409);
  const active=await this.activeTariffs(client,now),rate=active.entries.find(entry=>entry.categoria_codigo===record.categoria_codigo);
  if(!rate)fail('TARIFF_UNAVAILABLE','Não há tarifa vigente para essa categoria na entrada.');
  const stayId=id('pp'),stay=(await client.query('INSERT INTO porto_permanencias(id,unidade_id,solicitacao_id,veiculo_id,placa,motorista_id,motorista_nome,tarifa_id,tabela_tarifaria_id,categoria_codigo,categoria_nome,valor_diaria_centavos,entrada_em,entrada_operador_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',[stayId,PORTO_UNIT,requestId,record.veiculo_id,record.placa,record.motorista_id,record.motorista_nome,rate.id,rate.tabela_id,rate.categoria_codigo,rate.categoria_nome,rate.diaria_centavos,now,user.id])).rows[0];
  await this.audit(client,user,type,stayId,{solicitacaoId:requestId,veiculoId:record.veiculo_id,entradaEm:now,tarifaId:rate.id,tabelaTarifariaId:rate.tabela_id,valorDiariaCentavos:rate.diaria_centavos});return stay;
 }
}
