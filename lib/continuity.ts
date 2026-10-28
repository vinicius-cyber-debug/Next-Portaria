import { ROLES, validateState } from './domain.mjs';
import { isAfterHours, personRequirementAlerts } from './physical-access.mjs';
import { ACTIVE_ROLES, RETIRED_NOTICE_KINDS } from './module-policy.mjs';

type ContinuityUser = {id:string;name:string;role:string;status:string;capabilities?:Record<string,boolean>};
type OperationalState = Record<string, any>;
export type ContinuityContext = {db:D1Database;bucket?:R2Bucket|null;user:ContinuityUser;state:OperationalState;revision:number};
type NoticeKind = 'visitor_pending'|'visitor_expired'|'visitor_overstay'|'visitor_after_hours'|'stay_overstay'|'charge_overdue'|'requirement_expiring'|'requirement_blocked';
type Config = {backupEnabled:boolean;everyHours:number;retentionDays:number;notificationsEnabled:boolean;noticeKinds:NoticeKind[];recipientRoles:string[];updatedAt?:string;updatedBy?:string};
type Backup = {id:string;createdAt:string;status:'running'|'ready'|'failed'|'expired';key:string;revision:number;attempts:number;trigger:string;sizeBytes?:number;sha256?:string;finishedAt?:string;error?:string;verifiedAt?:string;verification?:'passed'|'failed';verificationError?:string;expiredAt?:string;retentionError?:string};
type Notice = {id:string;kind:NoticeKind;entityId:string;createdAt:string;title:string;description:string;roles:string[];recipientUserIds?:string[];section:string;resolvedAt:string|null};
const HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
const NOTICE_KINDS:NoticeKind[] = ['visitor_pending','visitor_expired','visitor_overstay','visitor_after_hours','requirement_expiring','requirement_blocked'];
const MAX_BACKUP = 5*1024*1024-16*1024;
const LEASE_MS = 120_000;
const DEFAULT_CONFIG:Config = {backupEnabled:true,everyHours:24,retentionDays:30,notificationsEnabled:true,noticeKinds:NOTICE_KINDS,recipientRoles:['admin','director','gate','operations']};
const NOTICE_ROLES:Record<NoticeKind,string[]> = {visitor_pending:['admin','director','gate'],visitor_expired:['admin','director','gate'],visitor_overstay:['admin','director','gate'],visitor_after_hours:['admin','director','gate','operations'],stay_overstay:['admin','operations'],charge_overdue:['admin','finance'],requirement_expiring:['admin','director','gate','operations'],requirement_blocked:['admin','director','gate','operations']};
const TITLES:Record<NoticeKind,string> = {visitor_pending:'Solicitação de visita pendente',visitor_expired:'Autorização de visita vencida',visitor_overstay:'Visita com permanência excedida',visitor_after_hours:'Pessoa presente fora do funcionamento',stay_overstay:'Atracação com prazo excedido',charge_overdue:'Cobrança vencida',requirement_expiring:'Requisito próximo do vencimento',requirement_blocked:'Requisito impede nova entrada'};
class ContinuityError extends Error {code:string;status:number;constructor(code:string,message:string,status=400){super(message);this.code=code;this.status=status;}}
function reject(code:string,message:string,status=400):never {throw new ContinuityError(code,message,status);}
function json(value:unknown,status=200,headers:Record<string,string>={}) {return new Response(JSON.stringify(value),{status,headers:{...HEADERS,...headers}});}
function stmt(db:D1Database,sql:string,...values:unknown[]) {return db.prepare(sql).bind(...values);}
function rows<T>(value:D1Result<T>) {return value.results??[];}
async function digest(value:string) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function parseBody<T>(row:{body:string}|null):T|null {return row?JSON.parse(row.body) as T:null;}
function activeUser(user:ContinuityUser) {if(user.status!=='active'||!ROLES.includes(user.role))reject('FORBIDDEN','Seu acesso não permite esta ação.',403);}
function adminUser(user:ContinuityUser) {activeUser(user);if(user.role!=='admin')reject('FORBIDDEN','Somente administradores podem gerenciar a continuidade.',403);}
async function currentAdmin(context:ContinuityContext) {
  adminUser(context.user);
  const user=await stmt(context.db,'SELECT role,status FROM operational_users WHERE id = ?',context.user.id).first<{role:string;status:string}>();
  if(!user||user.role!=='admin'||user.status!=='active')reject('ACCESS_REVOKED','Seu acesso mudou. Atualize a página antes de continuar.',403);
}
async function guardedBatch(context:ContinuityContext,statements:D1PreparedStatement[]) {
  const token=`continuity_guard_${crypto.randomUUID()}`;
  return context.db.batch([stmt(context.db,'INSERT INTO operational_mutation_guard (token,expected_revision,actor_id,actor_role) VALUES (?,?,?,?)',token,context.revision,context.user.id,'admin'),...statements,stmt(context.db,'DELETE FROM operational_mutation_guard WHERE token = ?',token)]);
}
async function body(request:Request) {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))reject('CONTENT_TYPE','Envie dados no formato JSON.',415);
  const reader=request.body?.getReader();if(!reader)reject('VALIDATION','Informe os dados da solicitação.');
  const parts:Uint8Array[]=[];let length=0;
  while(true){const value=await reader.read();if(value.done)break;length+=value.value.byteLength;if(length>8192){await reader.cancel();reject('BODY_TOO_LARGE','Solicitação excede o tamanho permitido.',413);}parts.push(value.value);}
  const all=new Uint8Array(length);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}
  let answer:unknown;try{answer=JSON.parse(new TextDecoder().decode(all));}catch{reject('INVALID_JSON','JSON inválido.');}
  if(!answer||typeof answer!=='object'||Array.isArray(answer))reject('VALIDATION','Dados da solicitação inválidos.');
  return answer as Record<string,unknown>;
}
async function configuration(db:D1Database):Promise<Config> {
  const saved=parseBody<Config>(await stmt(db,'SELECT body FROM operational_continuity_config WHERE id = ?','default').first<{body:string}>())??structuredClone(DEFAULT_CONFIG);
  return {...saved,noticeKinds:saved.noticeKinds.filter(kind=>NOTICE_KINDS.includes(kind)),recipientRoles:saved.recipientRoles.filter(role=>ACTIVE_ROLES.includes(role))};
}
function validatedConfig(value:Record<string,unknown>):Config {
  if(Array.isArray(value.noticeKinds)&&value.noticeKinds.some(kind=>RETIRED_NOTICE_KINDS.includes(kind)))reject('MODULE_REMOVED','Os avisos de embarcações e financeiro foram removidos.');
  if(typeof value.backupEnabled!=='boolean'||typeof value.notificationsEnabled!=='boolean')reject('VALIDATION','Informe se o backup e as notificações estão habilitados.');
  if(!Number.isSafeInteger(value.everyHours)||Number(value.everyHours)<1||Number(value.everyHours)>168)reject('VALIDATION','O intervalo deve ser um inteiro entre 1 e 168 horas.');
  if(!Number.isSafeInteger(value.retentionDays)||Number(value.retentionDays)<1||Number(value.retentionDays)>90)reject('VALIDATION','A retenção deve ser um inteiro entre 1 e 90 dias.');
  if(!Array.isArray(value.noticeKinds)||value.noticeKinds.length>NOTICE_KINDS.length||value.noticeKinds.some(v=>!NOTICE_KINDS.includes(v as NoticeKind))||new Set(value.noticeKinds).size!==value.noticeKinds.length)reject('VALIDATION','Selecione tipos de aviso válidos e sem repetição.');
  if(!Array.isArray(value.recipientRoles)||value.recipientRoles.length>ACTIVE_ROLES.length||value.recipientRoles.some(v=>!ACTIVE_ROLES.includes(v))||new Set(value.recipientRoles).size!==value.recipientRoles.length)reject('VALIDATION','Selecione perfis destinatários válidos e sem repetição.');
  if(value.notificationsEnabled&&(!value.noticeKinds.length||!value.recipientRoles.length))reject('VALIDATION','Selecione pelo menos um tipo de aviso e um perfil destinatário.');
  return {backupEnabled:value.backupEnabled,everyHours:Number(value.everyHours),retentionDays:Number(value.retentionDays),notificationsEnabled:value.notificationsEnabled,noticeKinds:value.noticeKinds as NoticeKind[],recipientRoles:value.recipientRoles as string[]};
}
function auditStatement(context:ContinuityContext,action:string,entityId:string,detail:string,extra:Record<string,unknown>={},fence?:{id:string;token:string}) {
  const id=`continuity_audit_${crypto.randomUUID()}`,at=new Date().toISOString();
  const event={id,at,actor:context.user.name,actorId:context.user.id,role:context.user.role,action,entity:'continuity',entityId,detail,changes:[],...extra};
  return fence?stmt(context.db,'INSERT INTO operational_audit (id,at,body) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM operational_job_locks WHERE id = ? AND token = ?)',id,at,JSON.stringify(event),fence.id,fence.token):stmt(context.db,'INSERT INTO operational_audit (id,at,body) VALUES (?,?,?)',id,at,JSON.stringify(event));
}
async function saveBackup(context:ContinuityContext,backup:Backup) {await stmt(context.db,'INSERT INTO operational_backup_runs (id,created_at,status,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,status=excluded.status,body=excluded.body',backup.id,backup.createdAt,backup.status,JSON.stringify(backup)).run();}
async function lock(context:ContinuityContext,id:string,now:string) {
  const token=crypto.randomUUID(),until=new Date(Date.parse(now)+LEASE_MS).toISOString();
  await stmt(context.db,'INSERT INTO operational_job_locks (id,lease_until,token) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,token=excluded.token WHERE operational_job_locks.lease_until <= ?',id,until,token,now).run();
  const current=await stmt(context.db,'SELECT token FROM operational_job_locks WHERE id = ?',id).first<{token:string}>();
  return current?.token===token?token:null;
}
async function stillOwns(context:ContinuityContext,id:string,token:string) {return (await stmt(context.db,'SELECT token FROM operational_job_locks WHERE id = ?',id).first<{token:string}>())?.token===token;}
async function listBackups(db:D1Database,limit=100) {return rows(await stmt(db,'SELECT body FROM operational_backup_runs ORDER BY created_at DESC LIMIT ?',limit).all<{body:string}>()).map(row=>JSON.parse(row.body) as Backup);}
function safeBackup(backup:Backup) {const {key,...result}=backup;return result;}
function mayReadNotice(user:ContinuityUser,notice:Notice,config:Config) {return NOTICE_KINDS.includes(notice.kind)&&config.notificationsEnabled&&config.noticeKinds.includes(notice.kind)&&config.recipientRoles.includes(user.role)&&notice.roles.includes(user.role)&&(!notice.recipientUserIds?.length||['admin','gate','operations'].includes(user.role)||notice.recipientUserIds.includes(user.id));}
async function retention(context:ContinuityContext,config:Config,now:string) {
  const result={expired:0,failed:0};if(!context.bucket)return result;
  const saved=await listBackups(context.db,10000),ready=saved.filter(item=>item.status==='ready').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  // Preserve the newest recoverable snapshot even when it is older than the configured retention.
  const keep=ready[0]?.id,cutoff=Date.parse(now)-config.retentionDays*86400000;
  for(const item of ready){if(item.id===keep||Date.parse(item.createdAt)>=cutoff)continue;
    try {await context.bucket.delete(item.key);item.status='expired';item.expiredAt=now;delete item.retentionError;await context.db.batch([stmt(context.db,'UPDATE operational_backup_runs SET status = ?,body = ? WHERE id = ?','expired',JSON.stringify(item),item.id),auditStatement(context,'BACKUP_EXPIRED',item.id,'Backup removido conforme a retenção configurada.')]);result.expired++;}
    catch {result.failed++;item.retentionError='Falha ao remover o objeto; nova tentativa na próxima rotina.';await saveBackup(context,item);}
  }
  return result;
}
async function runBackup(context:ContinuityContext,config:Config,now:string,trigger:string) {
  if(!config.backupEnabled)return {backup:{status:'disabled'},retention:{expired:0,failed:0}};
  const window=Math.floor(Date.parse(now)/(config.everyHours*3600000)),id=`backup_${config.everyHours}h_${window}`,lockId=`snapshot:${id}`;
  const previous=parseBody<Backup>(await stmt(context.db,'SELECT body FROM operational_backup_runs WHERE id = ?',id).first<{body:string}>());
  if(previous?.status==='ready'||previous?.status==='expired')return {backup:{status:'already_completed',id},retention:previous.status==='ready'?await retention(context,config,now):{expired:0,failed:0}};
  const token=await lock(context,lockId,now);if(!token)return {backup:{status:'running',id},retention:{expired:0,failed:0}};
  const backup:Backup={id,createdAt:now,status:'running',key:`backups/${id}/${token}.json`,revision:context.revision,attempts:(previous?.attempts??0)+1,trigger};
  await saveBackup(context,backup);
  try {
    if(!context.bucket)reject('STORAGE_UNAVAILABLE','Armazenamento privado ainda não está disponível.',503);
    const state=structuredClone(context.state);state.audit=[];validateState(structuredClone(state));
    const contents=JSON.stringify({format:'porto-gestao-backup',version:2,exportedAt:now,revision:context.revision,state,auditIncluded:false});
    backup.sizeBytes=new TextEncoder().encode(contents).byteLength;
    if(backup.sizeBytes>MAX_BACKUP)reject('BACKUP_TOO_LARGE','O backup excede o limite operacional de aproximadamente 5 MiB.',413);
    backup.sha256=await digest(contents);
    if(!await stillOwns(context,lockId,token))return {backup:{status:'lease_lost',id},retention:{expired:0,failed:0}};
    await context.bucket.put(backup.key,contents,{httpMetadata:{contentType:'application/json'},customMetadata:{sha256:backup.sha256,revision:String(context.revision)}});
    if(!await stillOwns(context,lockId,token)){await context.bucket.delete(backup.key);return {backup:{status:'lease_lost',id},retention:{expired:0,failed:0}};}
    backup.status='ready';backup.finishedAt=new Date().toISOString();
    const committed=await context.db.batch([stmt(context.db,'UPDATE operational_backup_runs SET status = ?,body = ? WHERE id = ? AND EXISTS (SELECT 1 FROM operational_job_locks WHERE id = ? AND token = ?) RETURNING id','ready',JSON.stringify(backup),id,lockId,token),auditStatement(context,'BACKUP_CREATED',id,'Backup operacional privado criado.',{sizeBytes:backup.sizeBytes,revision:context.revision},{id:lockId,token})]);
    if(!rows(committed[0]).length){await context.bucket.delete(backup.key);return {backup:{status:'lease_lost',id},retention:{expired:0,failed:0}};}
    return {backup:{status:'ready',id},retention:await retention(context,config,now)};
  } catch(error) {
    if(!await stillOwns(context,lockId,token))return {backup:{status:'lease_lost',id},retention:{expired:0,failed:0}};
    backup.status='failed';backup.finishedAt=new Date().toISOString();backup.error=error instanceof ContinuityError?error.message:'Falha ao criar o backup privado. A rotina poderá tentar novamente após o prazo de recuperação.';
    await context.db.batch([stmt(context.db,'UPDATE operational_backup_runs SET status = ?,body = ? WHERE id = ? AND EXISTS (SELECT 1 FROM operational_job_locks WHERE id = ? AND token = ?)','failed',JSON.stringify(backup),id,lockId,token),auditStatement(context,'BACKUP_FAILED',id,backup.error,{}, {id:lockId,token})]);
    return {backup:{status:'failed',id,reason:backup.error},retention:{expired:0,failed:0}};
  }
}
async function candidateNotices(context:ContinuityContext,config:Config,now:string) {
  const notices:Notice[]=[],at=Date.parse(now),settings=context.state.settings??{};
  async function add(kind:NoticeKind,entity:Record<string,any>,marker:unknown,section:string,description:string) {
    if(!config.noticeKinds.includes(kind))return;const roles=config.recipientRoles.filter(role=>NOTICE_ROLES[kind].includes(role));if(!roles.length)return;
    const recipientUserIds=entity.responsibleUserId?[entity.responsibleUserId,entity.substituteUserId].filter(Boolean):[];
    notices.push({id:`notice_${await digest(`${kind}:${entity.id}:${String(marker)}:${recipientUserIds.join(',')}`)}`,kind,entityId:entity.id,createdAt:now,title:TITLES[kind],description,roles,recipientUserIds,section,resolvedAt:null});
  }
  if(!config.notificationsEnabled)return notices;
  const outsideHours=isAfterHours(settings,now);
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone??'America/Manaus',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  for(const visit of context.state.visitors??[]){
    if(visit.status==='pending'&&at<=Date.parse(visit.validUntil))await add('visitor_pending',visit,visit.requestedAt,'quickgate','Uma solicitação aguarda análise da diretoria.');
    if(['pending','authorized'].includes(visit.status)&&at>Date.parse(visit.validUntil))await add('visitor_expired',visit,visit.validUntil,'quickgate','O período previsto para uma visita terminou sem registro de entrada.');
    const deadline=Math.min(Date.parse(visit.validUntil),Date.parse(visit.enteredAt)+Number(settings.visitorOverstayHours??8)*3600000);
    if(visit.status==='inside'&&at>deadline)await add('visitor_overstay',visit,`${visit.enteredAt}:${deadline}`,'quickgate','Uma visita permanece na unidade além do prazo previsto ou do limite de permanência.');
    if(visit.status==='inside'&&outsideHours)await add('visitor_after_hours',visit,`${localDate}:${settings.openingTime}:${settings.closingTime}`,'quickgate','Uma pessoa continua registrada como presente fora do horário de funcionamento. Confira o setor e o responsável na Central de Acesso.');
  }
  for(const requirement of personRequirementAlerts(context.state,now)){
    const kind:NoticeKind=requirement.alertStatus==='expiring'?'requirement_expiring':'requirement_blocked';
    await add(kind,requirement,`${requirement.status}:${requirement.validUntil}:${requirement.reviewedAt}`,'quickgate',requirement.alertStatus==='expiring'?'Um requisito vence em até 30 dias. Confira os requisitos na Central de Acesso.':'Uma pessoa possui requisito pendente, revogado ou vencido. Novas entradas dependem de conferência válida.');
  }
  return notices;
}
async function runNotifications(context:ContinuityContext,config:Config,now:string) {
  const candidates=await candidateNotices(context,config,now),wanted=new Map(candidates.map(item=>[item.id,item])),existing=rows(await stmt(context.db,'SELECT body FROM operational_notifications').all<{body:string}>()).map(row=>JSON.parse(row.body) as Notice);let created=0;
  for(const notice of candidates){
    const old=existing.find(item=>item.id===notice.id);if(old){notice.createdAt=old.createdAt;if(old.resolvedAt||JSON.stringify(old.roles)!==JSON.stringify(notice.roles))await stmt(context.db,'UPDATE operational_notifications SET body = ? WHERE id = ?',JSON.stringify(notice),notice.id).run();continue;}
    const inserted=await stmt(context.db,'INSERT OR IGNORE INTO operational_notifications (id,kind,entity_id,created_at,body) VALUES (?,?,?,?,?) RETURNING id',notice.id,notice.kind,notice.entityId,notice.createdAt,JSON.stringify(notice)).all<{id:string}>();created+=rows(inserted).length;
  }
  for(const old of existing)if(!old.resolvedAt&&!wanted.has(old.id)){old.resolvedAt=now;await stmt(context.db,'UPDATE operational_notifications SET body = ? WHERE id = ?',JSON.stringify(old),old.id).run();}
  return {created,active:candidates.length};
}
async function runRoutine(context:ContinuityContext,trigger:string) {
  const config=await configuration(context.db),now=new Date().toISOString();
  const backup=await runBackup(context,config,now,trigger),notifications=await runNotifications(context,config,now);
  return {...backup,notifications,ranAt:now,storageAvailable:!!context.bucket};
}
/** Recompute only in-app notices after operational commands or during the authenticated inbox refresh. */
export async function refreshNotifications(context:ContinuityContext) {return runNotifications(context,await configuration(context.db),new Date().toISOString());}
async function notificationSummary(db:D1Database) {
  const notices=rows(await stmt(db,'SELECT body FROM operational_notifications').all<{body:string}>()).map(row=>JSON.parse(row.body) as Notice).filter(item=>!item.resolvedAt&&NOTICE_KINDS.includes(item.kind));
  return {active:notices.length,byKind:Object.fromEntries(NOTICE_KINDS.map(kind=>[kind,notices.filter(item=>item.kind===kind).length]))};
}
async function getBackup(context:ContinuityContext,id:string) {const backup=parseBody<Backup>(await stmt(context.db,'SELECT body FROM operational_backup_runs WHERE id = ?',id).first<{body:string}>());if(!backup||backup.status!=='ready')reject('NOT_FOUND','Backup disponível não encontrado.',404);if(!context.bucket)reject('STORAGE_UNAVAILABLE','Armazenamento privado ainda não está disponível.',503);return backup;}
async function attachmentAvailability(context:ContinuityContext,state:OperationalState) {
  const ids=[...new Set<string>((state.incidents??[]).flatMap((incident:Record<string,any>)=>incident.attachmentIds??[]))];let unavailable=0;
  for(const id of ids){
    const metadata=await stmt(context.db,'SELECT object_key,size FROM operational_attachments WHERE id = ?',id).first<{object_key:string;size:number}>();
    if(!metadata){unavailable++;continue;}
    const object=await context.bucket!.head(metadata.object_key);if(!object||object.size!==metadata.size)unavailable++;
  }
  if(unavailable)reject('BACKUP_ATTACHMENTS_UNAVAILABLE',`Anexos indisponíveis: ${unavailable} de ${ids.length}. Os arquivos não fazem parte do JSON e precisam permanecer no armazenamento privado.`);
}
async function verifiedContents(context:ContinuityContext,backup:Backup,checkAttachments=false) {
  const object=await context.bucket!.get(backup.key);if(!object)reject('BACKUP_OBJECT_MISSING','O arquivo deste backup não está disponível.',404);
  if(object.size>MAX_BACKUP)reject('INVALID_BACKUP','Arquivo acima do limite operacional.');
  const contents=await object.text();if(new TextEncoder().encode(contents).byteLength>MAX_BACKUP||await digest(contents)!==backup.sha256)reject('BACKUP_HASH_MISMATCH','A integridade do backup não confere.');
  let envelope:Record<string,any>;try{envelope=JSON.parse(contents);}catch{reject('INVALID_BACKUP','O arquivo não contém um backup JSON válido.');}
  if(envelope.format!=='porto-gestao-backup'||envelope.version!==2||envelope.auditIncluded!==false||!Array.isArray(envelope.state?.audit)||envelope.state.audit.length)reject('INVALID_BACKUP','Formato de backup incompatível.');
  validateState(structuredClone(envelope.state));if(checkAttachments)await attachmentAvailability(context,envelope.state);return contents;
}

/** Routes require authenticated identities and same-origin checks in the caller. The automation route additionally requires its service token. */
export async function handleContinuity(request:Request,context:ContinuityContext):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/api/continuity')&&!path.startsWith('/api/notifications')&&path!=='/api/automation/run')return null;
  try {
    if(path==='/api/automation/run'&&request.method==='POST')return json(await runRoutine(context,'automation'));
    if(path.startsWith('/api/continuity'))adminUser(context.user);else activeUser(context.user);
    if(path==='/api/continuity'&&request.method==='GET')return json({config:await configuration(context.db),backups:(await listBackups(context.db)).map(safeBackup),notificationSummary:await notificationSummary(context.db),storageAvailable:!!context.bucket});
    if(path==='/api/continuity/config'&&request.method==='POST') {
      const before=await configuration(context.db),config={...validatedConfig(await body(request)),updatedAt:new Date().toISOString(),updatedBy:context.user.name};
      await guardedBatch(context,[stmt(context.db,'INSERT INTO operational_continuity_config (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body','default',JSON.stringify(config)),auditStatement(context,'CONTINUITY_CONFIG_UPDATE','default','Configuração de backup e notificações atualizada.',{changes:[{kind:'continuityConfig',id:'default',before,after:config}]})]);
      return json({config,storageAvailable:!!context.bucket});
    }
    if(path==='/api/continuity/run'&&request.method==='POST'){await currentAdmin(context);return json(await runRoutine(context,'manual'));}
    const match=path.match(/^\/api\/continuity\/backups\/(backup_[a-zA-Z0-9_-]+)(\/verify)?$/);
    if(match&&request.method===(match[2]?'POST':'GET')) {
      const backup=await getBackup(context,match[1]);
      if(!match[2])return new Response(await verifiedContents(context,backup),{headers:{...HEADERS,'Content-Disposition':`attachment; filename="porto-gestao-${backup.id}.json"`}});
      await currentAdmin(context);
      let passed=true,error='';try{await verifiedContents(context,backup,true);}catch(value){passed=false;error=value instanceof Error?value.message:'Falha na verificação do backup.';}
      backup.verifiedAt=new Date().toISOString();backup.verification=passed?'passed':'failed';if(error)backup.verificationError=error;else delete backup.verificationError;
      await guardedBatch(context,[stmt(context.db,'UPDATE operational_backup_runs SET body = ? WHERE id = ?',JSON.stringify(backup),backup.id),auditStatement(context,passed?'BACKUP_VERIFY_OK':'BACKUP_VERIFY_FAILED',backup.id,passed?'Verificação validou integridade, regras dos dados e disponibilidade dos anexos referenciados sem alterar a operação.':'Verificação do backup falhou.',{verificationError:error||undefined})]);
      return json({id:backup.id,verification:backup.verification,verifiedAt:backup.verifiedAt,...(error?{error:{code:'BACKUP_VERIFICATION_FAILED',message:error}}:{})},passed?200:422);
    }
    if(path==='/api/notifications'&&request.method==='GET') {
      await refreshNotifications(context);
      const config=await configuration(context.db),notices=rows(await stmt(context.db,'SELECT n.body,r.read_at FROM operational_notifications n LEFT JOIN operational_notification_reads r ON r.notification_id = n.id AND r.user_id = ? ORDER BY n.created_at DESC',context.user.id).all<{body:string;read_at:string|null}>()).map(row=>({...JSON.parse(row.body) as Notice,readAt:row.read_at})).filter(item=>!item.resolvedAt&&mayReadNotice(context.user,item,config));
      return json({notifications:notices.slice(0,100),unreadCount:notices.filter(item=>!item.readAt).length});
    }
    if(path==='/api/notifications/read'&&request.method==='POST') {
      const value=await body(request);if(typeof value.id!=='string'||value.id.length>150)reject('VALIDATION','Identificador do aviso inválido.');
      const config=await configuration(context.db),notice=parseBody<Notice>(await stmt(context.db,'SELECT body FROM operational_notifications WHERE id = ?',value.id).first<{body:string}>());if(!notice||!mayReadNotice(context.user,notice,config))reject('NOT_FOUND','Aviso não encontrado.',404);
      const now=new Date().toISOString();await stmt(context.db,'INSERT OR IGNORE INTO operational_notification_reads (notification_id,user_id,read_at) VALUES (?,?,?)',notice.id,context.user.id,now).run();
      const receipt=await stmt(context.db,'SELECT read_at FROM operational_notification_reads WHERE notification_id = ? AND user_id = ?',notice.id,context.user.id).first<{read_at:string}>();return json({ok:true,id:notice.id,readAt:receipt?.read_at??now});
    }
    return null;
  } catch(error) {
    if(error instanceof ContinuityError)return json({error:{code:error.code,message:error.message}},error.status);
    const message=error instanceof Error?error.message:String(error);
    if(message.includes('ACCESS_REVOKED'))return json({error:{code:'ACCESS_REVOKED',message:'Seu acesso mudou. Atualize a página antes de continuar.'}},403);
    if(message.includes('REVISION_CONFLICT'))return json({error:{code:'REVISION_CONFLICT',message:'Os dados foram atualizados por outro usuário. Atualize e tente novamente.'}},409);
    return json({error:{code:'CONTINUITY_FAILURE',message:'Não foi possível concluir a operação de continuidade. Tente novamente.'}},500);
  }
}
