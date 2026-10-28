import { COLLECTIONS, can, canonicalRole, createInitialState, execute, validateState } from './domain.mjs';
import { ACTIVE_ROLES, assertActiveCollection, assertActiveCommand, moduleRemoved } from './module-policy.mjs';
import { CAPABILITY_DEFINITIONS, defaultCapabilities, effectiveCapabilities, validateOverrides, canWithCapabilities, visibleSnapshot, redactValue } from './access.mjs';
import { handleContinuity, refreshNotifications } from './continuity.ts';
import { AUTH_COOKIE, PASSWORD_ITERATIONS, SESSION_HOURS, validUsername, validPassword, hashPassword, verifyPassword, sessionToken, tokenHash, cookieToken, sessionCookie } from './local-auth.ts';
import { assertVisitEligibility } from './physical-access.mjs';
import { readOperationalSnapshot, operationalVisible, stateDelta, syncState, pagedRecords } from './state-sync.ts';

type User = {id:string;email:string;name:string;role:string;status:string;mustChangePassword?:boolean;createdAt?:string;updatedAt?:string;capabilities?:Record<string,boolean>;overrides?:Record<string,boolean>};
type Resources = {bucket?:R2Bucket;jobToken?:string;allowHttpLan?:boolean};
type Audit = Record<string, unknown> & {id:string;at:string};
type State = {version:number;settings:Record<string,any>;visitors:Record<string,any>[];audit:Audit[];berths:string[];[collection:string]:any};
type Snapshot = {state:State;revision:number};
type SavedCommand = {id:string;actor_id:string;hash:string;result:string;revision:number};
const JSON_HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
const MAX_BODY = 64 * 1024;
const MAX_RESTORE = 5 * 1024 * 1024;
const MAX_BACKUP = MAX_RESTORE - 16 * 1024; // margem para o envelope, revisão e justificativa da restauração

class ApiError extends Error {
  code:string;status:number;
  constructor(code:string,message:string,status=400){super(message);this.code=code;this.status=status;}
}
function reject(code:string,message:string,status=400):never {throw new ApiError(code,message,status);}
function response(value:unknown,status=200,headers:Record<string,string>={}) {return new Response(JSON.stringify(value),{status,headers:{...JSON_HEADERS,...headers}});}
function field(value:unknown,label:string,max=200) {if(typeof value!=='string'||!value.trim()||value.trim().length>max) reject('VALIDATION',`${label} inválido.`);return value.trim();}
function normalizeEmail(value:unknown) {const email=field(value,'E-mail',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reject('VALIDATION','Informe um e-mail válido.');return email;}
function roleOf(value:unknown) {const role=canonicalRole(value);if(role==='finance')moduleRemoved();if(!ACTIVE_ROLES.includes(role)) reject('VALIDATION','Perfil inválido.');return role;}
function requireAdmin(user:User) {if(user.status!=='active'||user.role!=='admin') reject('FORBIDDEN','Somente administradores podem executar esta ação.',403);}
function requireRead(user:User) {if(user.status!=='active'||!can(user.role,'READ')) reject('PENDING_ACCESS',user.status==='disabled'?'Seu acesso foi desativado.':'Seu acesso aguarda aprovação do administrador.',403);}
function requireCapability(user:User,key:string) {if(!user.capabilities?.[key])reject('FORBIDDEN','Seu acesso não permite esta ação. Consulte o administrador.',403);}
async function withCapabilities(db:D1Database,user:User):Promise<User> {
  const saved=await statement(db,'SELECT body FROM operational_access WHERE user_id = ?',user.id).first<{body:string}>();
  const overrides=saved?JSON.parse(saved.body):{};return {...user,overrides,capabilities:effectiveCapabilities(user,overrides)};
}
function statement(db:D1Database,sql:string,...params:unknown[]) {return db.prepare(sql).bind(...params);}
function asRows<T>(result:D1Result<T>):T[] {return result.results??[];}
function uuid(prefix:string) {return `${prefix}_${crypto.randomUUID()}`;}
function privateNetworkHost(hostname:string) {
  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname))return false;
  const parts=hostname.split('.').map(Number);
  if(parts.some(part=>part>255))return false;
  return parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168);
}
function environment(request:Request,resources:Resources={}) {const host=new URL(request.url).hostname;return ['localhost','127.0.0.1','[::1]'].includes(host)||(resources.allowHttpLan===true&&privateNetworkHost(host))?'local':'hosted';}
function requireSecureTransport(request:Request,resources:Resources) {
  const url=new URL(request.url);
  if(url.protocol==='http:'&&resources.allowHttpLan===true&&privateNetworkHost(url.hostname))return;
  // Cabeçalhos enviados pelo cliente não podem habilitar o envio de senhas em HTTP.
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    reject('HTTPS_REQUIRED','Use uma conexão HTTPS para acessar o sistema pela rede. HTTP está disponível apenas no próprio computador.',403);
}

function verifyOrigin(request:Request) {
  if(!['POST','PUT','PATCH','DELETE'].includes(request.method)) return;
  const origin=request.headers.get('origin');
  if(!origin||origin!==new URL(request.url).origin) reject('CSRF','Origem da solicitação inválida. Atualize a página e tente novamente.',403);
  const fetchSite=request.headers.get('sec-fetch-site');if(fetchSite&&fetchSite!=='same-origin'&&fetchSite!=='none') reject('CSRF','Solicitação fora da origem da aplicação.',403);
}
async function readBody(request:Request,limit=MAX_BODY):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) reject('CONTENT_TYPE','Envie dados no formato JSON.',415);
  const declared=Number(request.headers.get('content-length')??0);if(declared>limit) reject('BODY_TOO_LARGE','Solicitação excede o tamanho permitido.',413);
  if(!request.body) reject('VALIDATION','Informe os dados da solicitação.');
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done) break;length+=value.byteLength;if(length>limit){await reader.cancel();reject('BODY_TOO_LARGE','Solicitação excede o tamanho permitido.',413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body:unknown;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{reject('INVALID_JSON','JSON inválido.');}
  if(!body||typeof body!=='object'||Array.isArray(body)) reject('VALIDATION','Dados da solicitação inválidos.');
  return body as Record<string,unknown>;
}
async function initialize(db:D1Database) {
  const initial=createInitialState();
  await db.batch([
    statement(db,'INSERT OR IGNORE INTO operational_meta (id, revision) VALUES (1, 0)'),
    statement(db,'INSERT OR IGNORE INTO operational_settings (id, body) VALUES (?, ?)', 'settings', JSON.stringify(initial.settings)),
    statement(db,'INSERT OR IGNORE INTO operational_settings (id, body) VALUES (?, ?)', 'berths', '[]'),
  ]);
}

/** Identidade vem somente de sessão assinada por token opaco no banco local. */
async function identify(request:Request,db:D1Database):Promise<User> {
  const token=cookieToken(request);
  if(!token)reject('UNAUTHENTICATED','Faça login com seu usuário e senha.',401);
  const digest=await tokenHash(token);
  const current=await statement(db,`SELECT u.id,u.email,u.name,u.role,u.status,u.created_at AS createdAt,u.updated_at AS updatedAt,c.must_change_password AS mustChangePassword
    FROM operational_sessions s JOIN operational_users u ON u.id=s.user_id
    JOIN operational_credentials c ON c.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`,digest,new Date().toISOString()).first<User>();
  if(!current)reject('UNAUTHENTICATED','Sua sessão expirou. Entre novamente.',401);
  return {...current,mustChangePassword:Boolean(current.mustChangePassword)};
}
async function logIn(request:Request,db:D1Database) {
  if(request.method!=='POST')reject('METHOD_NOT_ALLOWED','Método não permitido.',405);
  const body=await readBody(request);
  let username:string;try{username=validUsername(body.username);}catch{reject('INVALID_LOGIN','Usuário ou senha inválidos.',401);}
  const password=body.password;
  if(typeof password!=='string'||password.length>128)reject('INVALID_LOGIN','Usuário ou senha inválidos.',401);
  const account=await statement(db,`SELECT c.user_id AS id,c.password_salt AS salt,c.password_hash AS hash,c.password_iterations AS iterations,
    c.failed_attempts AS failures,c.locked_until AS lockedUntil,c.must_change_password AS mustChangePassword,u.status
    FROM operational_credentials c JOIN operational_users u ON u.id=c.user_id WHERE c.username=?`,username).first<{id:string;salt:string;hash:string;iterations:number;failures:number;lockedUntil:string|null;status:string;mustChangePassword:number}>();
  const now=new Date();
  if(!account){reject('INVALID_LOGIN','Usuário ou senha inválidos.',401);}
  if(account.lockedUntil&&account.lockedUntil>now.toISOString())reject('ACCOUNT_LOCKED','Conta temporariamente bloqueada. Tente novamente em 15 minutos.',429);
  const valid=account.iterations===PASSWORD_ITERATIONS&&await verifyPassword(password,account.salt,account.hash);
  if(!valid) {
    const until=new Date(now.getTime()+15*60_000).toISOString();
    await statement(db,`UPDATE operational_credentials SET failed_attempts=failed_attempts+1,
      locked_until=CASE WHEN failed_attempts+1>=5 THEN ? ELSE NULL END WHERE user_id=? AND password_hash=? AND password_salt=?`,until,account.id,account.hash,account.salt).run();
    reject('INVALID_LOGIN','Usuário ou senha inválidos.',401);
  }
  if(account.status!=='active')reject('ACCOUNT_DISABLED','Sua conta está pendente ou desativada. Consulte o administrador.',403);
  const token=sessionToken(),digest=await tokenHash(token),expires=new Date(now.getTime()+SESSION_HOURS*3600_000).toISOString();
  const authenticated=await db.batch([
    statement(db,'UPDATE operational_credentials SET failed_attempts=0,locked_until=NULL WHERE user_id=? AND password_hash=? AND password_salt=? AND (locked_until IS NULL OR locked_until<=?)',account.id,account.hash,account.salt,now.toISOString()),
    statement(db,`INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) SELECT ?,c.user_id,?,? FROM operational_credentials c JOIN operational_users u ON u.id=c.user_id WHERE c.user_id=? AND c.password_hash=? AND c.password_salt=? AND c.password_iterations=? AND u.status='active' AND (c.locked_until IS NULL OR c.locked_until<=?) RETURNING token_hash`,digest,now.toISOString(),expires,account.id,account.hash,account.salt,account.iterations,now.toISOString()),
    statement(db,'DELETE FROM operational_sessions WHERE expires_at<=?',now.toISOString()),
  ]);
  if(!asRows(authenticated[1]).length)reject('INVALID_LOGIN','As credenciais mudaram ou a conta foi bloqueada. Entre novamente.',401);
  return response({ok:true,mustChangePassword:Boolean(account.mustChangePassword)},200,{'Set-Cookie':sessionCookie(request,token)});
}
async function logOut(request:Request,db:D1Database) {
  if(request.method!=='POST')reject('METHOD_NOT_ALLOWED','Método não permitido.',405);
  const token=cookieToken(request);
  if(token)await statement(db,'DELETE FROM operational_sessions WHERE token_hash=?',await tokenHash(token)).run();
  return response({ok:true},200,{'Set-Cookie':sessionCookie(request,null)});
}

export async function readSnapshot(db:D1Database):Promise<Snapshot> {
  const results=await db.batch([
    statement(db,'SELECT revision FROM operational_meta WHERE id = 1'),
    statement(db,'SELECT collection,id,body FROM operational_records ORDER BY rowid DESC'),
    statement(db,'SELECT id,body FROM operational_settings'),
    statement(db,'SELECT body FROM operational_audit ORDER BY at DESC, rowid DESC'),
  ]);
  const state=createInitialState() as unknown as State;
  for(const record of asRows(results[1]) as {collection:string;id:string;body:string}[]) {
    if(COLLECTIONS.includes(record.collection)) (state as unknown as Record<string,unknown[]>)[record.collection].push(JSON.parse(record.body));
  }
  for(const setting of asRows(results[2]) as {id:string;body:string}[]) {if(setting.id==='settings'||setting.id==='berths') (state as Record<string,unknown>)[setting.id]=JSON.parse(setting.body);}
  state.audit=(asRows(results[3]) as {body:string}[]).map(row=>JSON.parse(row.body));
  const revision=(asRows(results[0])[0] as {revision:number}|undefined)?.revision;
  if(!Number.isSafeInteger(revision)) reject('DATABASE_UNAVAILABLE','A base ainda não está disponível.',503);
  return {state,revision:revision as number};
}
function recordStatements(db:D1Database,before:State,after:State) {
  const statements:D1PreparedStatement[]=[];
  // Libera as presenças anteriores antes de gravar as novas. A restauração pode
  // trocar qual visita representa a mesma pessoa presente; todo o lote é atômico.
  const nextVisits=new Map(after.visitors.map(visit=>[visit.id,visit]));
  for(const old of before.visitors) {
    const target=nextVisits.get(old.id);
    if(old.status==='inside'&&(!target||target.status!=='inside'||target.personId!==old.personId))
      statements.push(statement(db,"DELETE FROM operational_records WHERE collection='visitors' AND id=?",old.id));
  }
  for(const collection of COLLECTIONS) {
    const previous=new Map((before as unknown as Record<string,Array<{id:string}>>)[collection].map(record=>[record.id,record]));
    for(const record of (after as unknown as Record<string,Array<{id:string}>>)[collection]) {
      const old=previous.get(record.id);if(JSON.stringify(old)!==JSON.stringify(record)) statements.push(statement(db,'INSERT INTO operational_records (collection,id,body) VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body = excluded.body',collection,record.id,JSON.stringify(record)));previous.delete(record.id);
    }
    for(const old of previous.values()) statements.push(statement(db,'DELETE FROM operational_records WHERE collection = ? AND id = ?',collection,old.id));
  }
  for(const key of ['settings','berths']) {if(JSON.stringify((before as Record<string,unknown>)[key])!==JSON.stringify((after as Record<string,unknown>)[key])) statements.push(statement(db,'UPDATE operational_settings SET body = ? WHERE id = ?',JSON.stringify((after as Record<string,unknown>)[key]),key));}
  return statements;
}
function appendAudit(db:D1Database,event:Audit) {return statement(db,'INSERT INTO operational_audit (id,at,body) VALUES (?,?,?)',event.id,event.at,JSON.stringify(event));}
async function sha(value:unknown) {const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function expectedRevision(value:unknown) {if(!Number.isSafeInteger(value)||Number(value)<0) reject('VALIDATION','Informe a revisão atual dos dados.');return Number(value);}
function commandId(user:User,value:unknown) {const key=field(value,'Chave de idempotência',150);if(!/^[a-zA-Z0-9_.:-]{8,150}$/.test(key)) reject('VALIDATION','Chave de idempotência inválida.');return `${user.id}:${key}`;}
async function previousCommand(db:D1Database,id:string,hash:string):Promise<SavedCommand|null> {
  const previous=await statement(db,'SELECT id,actor_id,hash,result,revision FROM operational_commands WHERE id = ?',id).first<SavedCommand>();
  if(previous&&previous.hash!==hash) reject('IDEMPOTENCY_CONFLICT','Esta chave já foi usada para uma operação diferente.',409);
  return previous;
}
async function commit(db:D1Database,user:User,revision:number,statements:D1PreparedStatement[],id:string,hash:string,result:unknown,change:unknown=null) {
  const token=uuid('guard');
  try {
    await db.batch([
      statement(db,'INSERT INTO operational_mutation_guard (token,expected_revision,actor_id,actor_role) VALUES (?,?,?,?)',token,revision,user.id,user.role),
      ...statements,
      statement(db,'UPDATE operational_meta SET revision = revision + 1 WHERE id = 1'),
      statement(db,'INSERT INTO operational_changes(revision,created_at,body) VALUES(?,?,?)',revision+1,new Date().toISOString(),JSON.stringify(change)),
      statement(db,'DELETE FROM operational_changes WHERE revision<?',Math.max(0,revision-1000)),
      statement(db,'INSERT INTO operational_commands (id,actor_id,hash,result,revision,created_at) VALUES (?,?,?,?,?,?)',id,user.id,hash,JSON.stringify(result??null),revision+1,new Date().toISOString()),
      statement(db,'DELETE FROM operational_mutation_guard WHERE token = ?',token),
    ]);
  } catch(error) {
    const saved=await previousCommand(db,id,hash);if(saved) return {saved};
    const message=String(error);
    if(message.includes('REVISION_CONFLICT')) reject('REVISION_CONFLICT','Os dados foram atualizados por outro usuário. Atualize e tente novamente.',409);
    if(message.includes('ACCESS_REVOKED')) reject('FORBIDDEN','Seu acesso mudou. Atualize a página antes de continuar.',403);
    if(message.includes('LAST_ADMIN')) reject('LAST_ADMIN','Mantenha pelo menos um administrador ativo.',409);
    throw error;
  }
  return {saved:null};
}
async function replay(db:D1Database,saved:SavedCommand,user:User) {const current=await readOperationalSnapshot(db);return response({...operationalVisible(current,user),result:redactValue(JSON.parse(saved.result),user.capabilities),replayed:true,originalRevision:saved.revision});}
function makeAudit(user:User,action:string,entity:string,entityId:string,before:unknown,after:unknown,reason:string|null=null):Audit {
  return {id:uuid('audit'),at:new Date().toISOString(),actor:user.name,actorId:user.id,role:user.role,action,entity,entityId,detail:action,reason,changes:[{kind:entity,id:entityId,before,after}]};
}
async function changeOwnPassword(request:Request,db:D1Database,user:User) {
  if(request.method!=='POST')reject('METHOD_NOT_ALLOWED','Método não permitido.',405);
  const body=await readBody(request),nextPassword=validPassword(body.newPassword),currentPassword=body.currentPassword;
  if(typeof currentPassword!=='string'||currentPassword.length>128)reject('INVALID_PASSWORD','Informe a senha atual.');
  const current=await readSnapshot(db);
  const account=await statement(db,'SELECT password_salt AS salt,password_hash AS hash,password_iterations AS iterations,locked_until AS lockedUntil FROM operational_credentials WHERE user_id=?',user.id).first<{salt:string;hash:string;iterations:number;lockedUntil:string|null}>();
  if(!account)reject('NOT_FOUND','Conta local não encontrada.',404);
  const now=new Date().toISOString();
  if(account.lockedUntil&&account.lockedUntil>now)reject('ACCOUNT_LOCKED','Conta temporariamente bloqueada. Tente novamente em 15 minutos.',429);
  if(account.iterations!==PASSWORD_ITERATIONS||!await verifyPassword(currentPassword,account.salt,account.hash)) {
    await statement(db,`UPDATE operational_credentials SET failed_attempts=failed_attempts+1,locked_until=CASE WHEN failed_attempts+1>=5 THEN ? ELSE locked_until END WHERE user_id=? AND password_hash=? AND password_salt=?`,new Date(Date.now()+15*60_000).toISOString(),user.id,account.hash,account.salt).run();
    reject('INVALID_PASSWORD','A senha atual não confere.');
  }
  if(nextPassword===currentPassword)reject('PASSWORD_REUSED','Escolha uma senha diferente da senha atual.');
  const credential=await hashPassword(nextPassword),token=sessionToken(),digest=await tokenHash(token),oldToken=cookieToken(request),oldDigest=oldToken?await tokenHash(oldToken):'',sessionGuard=uuid('reauth');
  const updated={...user,mustChangePassword:false},result={passwordChanged:true};
  await commit(db,user,current.revision,[
    statement(db,`INSERT INTO operational_mutation_guard(token,expected_revision,actor_id,actor_role) VALUES(?,?,CASE WHEN EXISTS(SELECT 1 FROM operational_sessions s JOIN operational_credentials c ON c.user_id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND c.password_hash=? AND c.password_salt=?) THEN ? ELSE NULL END,?)`,sessionGuard,current.revision,oldDigest,user.id,now,account.hash,account.salt,user.id,user.role),
    statement(db,'UPDATE operational_credentials SET password_salt=?,password_hash=?,password_iterations=?,password_changed_at=?,must_change_password=0,failed_attempts=0,locked_until=NULL WHERE user_id=?',credential.salt,credential.hash,credential.iterations,now,user.id),
    statement(db,'UPDATE operational_users SET updated_at=? WHERE id=?',now,user.id),
    statement(db,'DELETE FROM operational_sessions WHERE user_id=?',user.id),
    statement(db,'INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',digest,user.id,now,new Date(Date.now()+SESSION_HOURS*3600_000).toISOString()),
    appendAudit(db,makeAudit(user,'USER_PASSWORD_CHANGE','user',user.id,{mustChangePassword:!!user.mustChangePassword},{mustChangePassword:false,sessionsRotated:true})),
    statement(db,'DELETE FROM operational_mutation_guard WHERE token=?',sessionGuard),
  ],commandId(user,uuid('password')),await sha({action:'USER_PASSWORD_CHANGE',at:now,userId:user.id}),result);
  return response({ok:true,user:updated,capabilities:updated.capabilities},200,{'Set-Cookie':sessionCookie(request,token)});
}
async function approvers(db:D1Database) {
  const saved=await statement(db,"SELECT id,name,email,role,status FROM operational_users WHERE status='active' AND role IN ('admin','director') ORDER BY name").all<User>();
  const eligible=await Promise.all(asRows(saved).map(user=>withCapabilities(db,user)));
  return eligible.filter(user=>canWithCapabilities(user,'VISITOR_APPROVE')).map(({id,name,role})=>({id,name,role}));
}
async function validateAssignments(db:D1Database,fields:Record<string,any>,historical=false) {
  for(const name of ['responsibleUserId','substituteUserId'])if(fields[name]) {
    const id=field(fields[name],name==='responsibleUserId'?'Responsável':'Substituto',150),person=await statement(db,'SELECT id,name,email,role,status FROM operational_users WHERE id=?',id).first<User>();
    if(!person||(!historical&&!canWithCapabilities(await withCapabilities(db,person),'VISITOR_APPROVE')))reject('INVALID_APPROVER','Selecione um responsável ativo com permissão para aprovar visitas.');
  }
}
async function userList(db:D1Database) {
  const [users,invites]=await db.batch([
    statement(db,`SELECT u.id,u.email,u.name,u.role,u.status,c.username,c.must_change_password AS mustChangePassword,u.created_at AS createdAt,u.updated_at AS updatedAt FROM operational_users u LEFT JOIN operational_credentials c ON c.user_id=u.id ORDER BY u.created_at DESC`),
    statement(db,'SELECT id,email,name,role,status,created_at AS createdAt,created_by AS createdBy,accepted_at AS acceptedAt,accepted_by AS acceptedBy FROM operational_invites ORDER BY created_at DESC'),
  ]);
  return {users:asRows(users),invites:asRows(invites)};
}

async function accessList(db:D1Database) {
  const list=await userList(db),users=await Promise.all((list.users as User[]).map(user=>withCapabilities(db,user)));
  return {definitions:CAPABILITY_DEFINITIONS,users,defaults:Object.fromEntries(ACTIVE_ROLES.map(role=>[role,defaultCapabilities(role)]))};
}
async function attachmentBytes(request:Request) {
  const limit=5*1024*1024+16384,reader=request.body?.getReader();if(!reader)reject('VALIDATION','Selecione um arquivo.');
  const chunks:Uint8Array[]=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();reject('BODY_TOO_LARGE','O arquivo deve ter até 5 MiB.',413);}chunks.push(part.value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}return all;
}
function validFileType(type:string,bytes:Uint8Array) {
  if(type==='image/png')return [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  if(type==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(type==='image/webp')return new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
  if(type==='application/pdf')return new TextDecoder().decode(bytes.slice(0,5))==='%PDF-';return false;
}
async function assertRestoreAttachments(db:D1Database,bucket:R2Bucket|undefined,state:State) {
  const ids=[...new Set<string>((state.incidents??[]).flatMap((incident:{attachmentIds?:string[]})=>incident.attachmentIds??[]))];
  if(ids.length&&!bucket)reject('ATTACHMENTS_UNAVAILABLE','O backup referencia anexos, mas o armazenamento privado está indisponível.',422);
  for(let offset=0;offset<ids.length;offset+=20)await Promise.all(ids.slice(offset,offset+20).map(async id=>{
    const metadata=await statement(db,'SELECT object_key,size FROM operational_attachments WHERE id = ?',id).first<{object_key:string;size:number}>();
    const object=metadata?await bucket!.head(metadata.object_key):null;
    if(!metadata||!object||object.size!==metadata.size)reject('ATTACHMENTS_UNAVAILABLE','Um anexo referenciado no backup está ausente ou inconsistente. Recupere o arquivo antes de restaurar os registros. O JSON não contém fotos ou PDFs.',422);
  }));
}
function csvValue(value:unknown) {const s=String(value??'');return '"'+(/^[\s]*[=+@-]/.test(s)?"'"+s:s).replace(/"/g,'""')+'"';}
function exportCsv(request:Request,state:State,user:User) {
  requireCapability(user,'dataExport');const q=new URL(request.url).searchParams,kind=q.get('kind')??'visitors';
  assertActiveCollection(kind);
  if(!['visitors','vehicles'].includes(kind))reject('VALIDATION','Tipo de relatório inválido.');
  const from=q.get('from')??'',to=q.get('to')??'';if([from,to].some(v=>v&&!/^\d{4}-\d{2}-\d{2}$/.test(v)))reject('VALIDATION','Período inválido.');
  const company=(q.get('company')??'').toLocaleLowerCase('pt-BR'),status=q.get('status')??'all';
  const timeField:Record<string,string>={visitors:'requestedAt',vehicles:'entryAt'};
  const fields:Record<string,string[]>={visitors:['name','company','purpose','host','expectedAt','enteredAt','leftAt','status'],vehicles:['plate','driver','company','purpose','gateName','entryAt','exitAt','status']};
  const labels:Record<string,string>={name:'Visitante',company:'Empresa',purpose:'Motivo',host:'Responsável',expectedAt:'Previsão',enteredAt:'Entrada',leftAt:'Saída',status:'Situação',plate:'Placa',driver:'Motorista',gateName:'Portaria',entryAt:'Entrada',exitAt:'Saída'};
  const data=(state as unknown as Record<string,Record<string,unknown>[]>)[kind].filter(row=>{const at=row[timeField[kind]],date=at?new Intl.DateTimeFormat('sv-SE',{timeZone:state.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(String(at))):'';return (!from||date>=from)&&(!to||date<=to)&&(!company||String(row.company??row.client??'').toLocaleLowerCase('pt-BR').includes(company))&&(status==='all'||row.status===status);});
  const contents='\uFEFF'+[fields[kind].map(k=>csvValue(labels[k])).join(';'),...data.map(row=>fields[kind].map(k=>csvValue(row[k])).join(';'))].join('\r\n');
  return new Response(contents,{headers:{...JSON_HEADERS,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="porto-${kind}-${new Date().toISOString().slice(0,10)}.csv"`}});
}

/** Entrada única para rotas /api; não recebe papéis ou identidade do corpo enviado pelo navegador. */
export async function handleApi(request:Request,db:D1Database,resources:Resources={}):Promise<Response> {
  try {
    requireSecureTransport(request,resources);
    const path=new URL(request.url).pathname.replace(/\/$/,'');
    const servicePath=['/api/automation/run','/api/automation/status','/api/automation/schedule'].includes(path);
    if(!servicePath)verifyOrigin(request);
    if(!db) reject('DATABASE_UNAVAILABLE','Banco de dados indisponível. Procure o administrador.',503);
    await initialize(db);
    if(servicePath) {
      if(request.method!==(path==='/api/automation/status'?'GET':'POST'))reject('METHOD_NOT_ALLOWED','Método não permitido.',405);
      const supplied=request.headers.get('x-porto-job-token')??'',expected=resources.jobToken??'';
      let mismatch=supplied.length^expected.length;for(let i=0;i<Math.max(supplied.length,expected.length);i++)mismatch|=(supplied.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);
      if(!expected||mismatch)reject('UNAUTHENTICATED','Rotina automática não autenticada.',401);
      if(path==='/api/automation/status') {
        const last=await statement(db,'SELECT id,created_at,status,body FROM operational_backup_runs ORDER BY created_at DESC LIMIT 1').first<{id:string;created_at:string;status:string;body:string}>(),info=last?JSON.parse(last.body):null;
        return response({version:'0.5.0',storageAvailable:!!resources.bucket,lastBackup:last?{id:last.id,createdAt:last.created_at,status:last.status,verification:info.verification??null,verifiedAt:info.verifiedAt??null}:null});
      }
      if(path==='/api/automation/schedule') {
        const body=await readBody(request),scheduleId=field(body.scheduleId,'Agendamento',200);if(typeof body.enabled!=='boolean')reject('VALIDATION','Informe a situação do agendamento.');
        const timezone=field(body.timezone,'Fuso',100);try{new Intl.DateTimeFormat('pt-BR',{timeZone:timezone}).format();}catch{reject('VALIDATION','Fuso inválido.');}
        const automation={scheduleId,enabled:body.enabled,cadence:'hourly',timezone,updatedAt:new Date().toISOString()};
        await statement(db,'INSERT INTO operational_continuity_config (id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body','cloudSchedule',JSON.stringify(automation)).run();return response({automation});
      }
      const current=await readSnapshot(db),system={id:'automation',name:'Rotina automática',role:'admin',status:'active'};
      return (await handleContinuity(request,{db,bucket:resources.bucket,user:{...system,capabilities:defaultCapabilities('admin')},...current}))??response({error:{code:'NOT_FOUND',message:'Rotina não encontrada.'}},404);
    }
    if(path==='/api/auth/login')return await logIn(request,db);
    if(path==='/api/auth/logout')return await logOut(request,db);
    const user=await withCapabilities(db,await identify(request,db));
    if(path==='/api/session'&&request.method==='GET') return response({user,environment:environment(request,resources)});
    requireRead(user);
    if(path==='/api/auth/change-password')return await changeOwnPassword(request,db,user);
    if(user.mustChangePassword)reject('PASSWORD_CHANGE_REQUIRED','Altere sua senha inicial antes de acessar a operação.',403);
    if(path==='/api/state'&&request.method==='GET') return response(operationalVisible(await readOperationalSnapshot(db),user));
    if(path==='/api/sync'&&request.method==='GET') {
      const query=new URL(request.url).searchParams,since=expectedRevision(Number(query.get('since')));
      return response(await syncState(db,user,since,query.get('forceReset')==='true',query.get('windowSince')));
    }
    if(path==='/api/records'&&request.method==='GET')return response(await pagedRecords(db,user,new URL(request.url).searchParams));
    if(path==='/api/approvers'&&request.method==='GET')return response({users:await approvers(db)});
    if(path==='/api/monthly-preview'&&request.method==='GET') {
      moduleRemoved();
    }
    if(path==='/api/access'&&request.method==='GET'){requireAdmin(user);return response(await accessList(db));}
    if(path==='/api/access'&&request.method==='POST') {
      requireAdmin(user);const body=await readBody(request),revision=expectedRevision(body.revision),userId=field(body.userId,'Usuário',200),overrides=validateOverrides(body.overrides),reason=field(body.reason,'Justificativa',1000),id=commandId(user,body.idempotencyKey),hash=await sha({userId,overrides,reason});
      const previous=await previousCommand(db,id,hash);if(previous)return response({...await accessList(db),revision:(await readSnapshot(db)).revision,replayed:true});
      const current=await readSnapshot(db);if(current.revision!==revision)reject('REVISION_CONFLICT','A base mudou. Atualize e revise as permissões.',409);
      const target=await statement(db,'SELECT id,email,name,role,status FROM operational_users WHERE id = ?',userId).first<User>();if(!target)reject('NOT_FOUND','Usuário não encontrado.',404);if(target.role==='admin')reject('ADMIN_FIXED','Administradores mantêm acesso integral. Para restringir, altere primeiro o perfil base.');
      const old=await withCapabilities(db,target),after={...target,overrides,capabilities:effectiveCapabilities(target,overrides)};
      const result={userId,capabilities:after.capabilities};await commit(db,user,revision,[statement(db,'INSERT INTO operational_access (user_id,body) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body',userId,JSON.stringify(overrides)),appendAudit(db,makeAudit(user,'ACCESS_UPDATE','user',userId,old,after,reason))],id,hash,result);
      return response({...await accessList(db),revision:revision+1,result});
    }
    if(path==='/api/exports'&&request.method==='GET')return exportCsv(request,(await readSnapshot(db)).state,user);
    if(path==='/api/passes/issue'&&request.method==='POST') {
      requireCapability(user,'dataExport');if(!(user.role==='admin'||(user.role==='gate'&&user.capabilities?.gateOperate)||canWithCapabilities(user,'VISITOR_APPROVE')))reject('FORBIDDEN','Seu perfil não pode emitir crachás.',403);
      const body=await readBody(request),visitorId=field(body.visitorId,'Visita',150),revision=expectedRevision(body.revision),id=commandId(user,body.idempotencyKey),hash=await sha({action:'PASS_ISSUE',visitorId});
      const previous=await previousCommand(db,id,hash),current=await readSnapshot(db);
      const visitor=current.state.visitors.find(v=>v.id===visitorId) as Record<string,unknown>|undefined;
      if(!visitor)reject('NOT_FOUND','Visita não encontrada.',404);if(!['authorized','inside'].includes(String(visitor.status))||Date.parse(String(visitor.validUntil))<Date.now())reject('INVALID_TRANSITION','O crachá exige uma visita autorizada e dentro da validade.');
      assertVisitEligibility(current.state,visitor,new Date().toISOString());
      if(previous) {
        const issued=JSON.parse(previous.result),active=await statement(db,'SELECT token_hash FROM operational_passes WHERE visitor_id=?',visitorId).first<{token_hash:string}>();
        if(!active||active.token_hash!==await sha(issued.code))reject('INVALID_TRANSITION','Este crachá foi substituído ou revogado. Emita uma nova credencial.');
        return response({pass:issued,revision:current.revision,replayed:true,originalRevision:previous.revision});
      }
      if(current.revision!==revision)reject('REVISION_CONFLICT','Os dados mudaram. Atualize antes de emitir o crachá.',409);
      const code='PGV1.'+[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join(''),now=new Date().toISOString(),pass={id:uuid('pass'),visitorId,expiresAt:visitor.validUntil,code};
      const committed=await commit(db,user,revision,[statement(db,'INSERT INTO operational_passes (id,visitor_id,token_hash,expires_at,created_at,created_by) VALUES (?,?,?,?,?,?) ON CONFLICT(visitor_id) DO UPDATE SET id=excluded.id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=excluded.created_at,created_by=excluded.created_by',pass.id,visitorId,await sha(code),pass.expiresAt,now,user.id),appendAudit(db,makeAudit(user,'PASS_ISSUE','visitor',visitorId,null,{id:pass.id,visitorId,expiresAt:pass.expiresAt}))],id,hash,pass);
      if(committed.saved)return response({pass:JSON.parse(committed.saved.result),revision:committed.saved.revision,replayed:true});
      return response({pass,revision:revision+1});
    }
    if(path==='/api/passes/lookup'&&request.method==='POST') {
      requireCapability(user,'gateOperate');if(!can(user.role,'VISITOR_CHECKIN'))reject('FORBIDDEN','Seu perfil não pode operar a leitura de entrada.',403);
      const body=await readBody(request),code=field(body.code,'Código do crachá',200);if(!/^PGV1\.[a-f0-9]{64}$/.test(code))reject('VALIDATION','Código de crachá inválido.');
      const pass=await statement(db,'SELECT id,visitor_id AS visitorId,expires_at AS expiresAt FROM operational_passes WHERE token_hash = ?',await sha(code)).first<{id:string;visitorId:string;expiresAt:string}>();if(!pass)reject('NOT_FOUND','Crachá não encontrado ou substituído.',404);
      const current=await readSnapshot(db),visitor=current.state.visitors.find(v=>v.id===pass.visitorId) as Record<string,unknown>|undefined;
      if(!visitor||!['authorized','inside'].includes(String(visitor.status)))reject('INVALID_TRANSITION','A autorização foi encerrada, recusada ou revogada.');
      const now=Date.now();if(now>Date.parse(pass.expiresAt)||now>Date.parse(String(visitor.validUntil))||now<Date.parse(String(visitor.expectedAt)))reject('OUTSIDE_VALIDITY','O crachá está fora do período autorizado.');
      assertVisitEligibility(current.state,visitor,new Date(now).toISOString(),{entry:true});
      return response({visitor:redactValue(visitor,user.capabilities),pass,revision:current.revision});
    }
    if(path==='/api/attachments'&&request.method==='POST') {
      requireCapability(user,'documentView');requireCapability(user,'incidentManage');if(!canWithCapabilities(user,'INCIDENT_CREATE'))reject('FORBIDDEN','Seu perfil não pode anexar arquivos.',403);if(!resources.bucket)reject('STORAGE_UNAVAILABLE','Armazenamento privado indisponível.',503);
      if(!request.headers.get('content-type')?.startsWith('multipart/form-data'))reject('CONTENT_TYPE','Selecione um arquivo para enviar.',415);
      const bytes=await attachmentBytes(request),form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')!}}).formData(),file=form.get('file');
      if(!(file instanceof File)||file.size<1||file.size>5*1024*1024)reject('VALIDATION','Selecione um arquivo de até 5 MiB.');
      const contents=new Uint8Array(await file.arrayBuffer());if(!validFileType(file.type,contents))reject('VALIDATION','O conteúdo deve ser PNG, JPEG, WebP ou PDF válido.');
      const name=file.name.replace(/[\\/\x00-\x1f"<>]/g,'_').slice(0,150)||'arquivo',id=uuid('attachment'),objectKey=`attachments/${id}`,createdAt=new Date().toISOString(),attachment={id,name,type:file.type,size:file.size,createdAt,createdBy:user.id};
      const current=await readSnapshot(db);await resources.bucket.put(objectKey,contents,{httpMetadata:{contentType:file.type}});
      try{await commit(db,user,current.revision,[statement(db,'INSERT INTO operational_attachments (id,object_key,name,type,size,created_at,created_by) VALUES (?,?,?,?,?,?,?)',id,objectKey,name,file.type,file.size,createdAt,user.id),appendAudit(db,makeAudit(user,'ATTACHMENT_UPLOAD','attachment',id,null,attachment))],commandId(user,uuid('upload')),await sha(attachment),attachment);}catch(error){await resources.bucket.delete(objectKey);throw error;}
      return response({attachment,revision:current.revision+1});
    }
    if(path.startsWith('/api/attachments/')&&request.method==='GET') {
      requireCapability(user,'documentView');const id=path.slice('/api/attachments/'.length),attachment=await statement(db,'SELECT object_key,name,type,size FROM operational_attachments WHERE id = ?',id).first<{object_key:string;name:string;type:string;size:number}>();if(!attachment)reject('NOT_FOUND','Anexo não encontrado.',404);if(!resources.bucket)reject('STORAGE_UNAVAILABLE','Armazenamento privado indisponível.',503);
      const object=await resources.bucket.get(attachment.object_key);if(!object)reject('NOT_FOUND','Arquivo não encontrado.',404);
      return new Response(object.body,{headers:{...JSON_HEADERS,'Content-Type':attachment.type,'Content-Length':String(attachment.size),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,'Content-Security-Policy':"sandbox; default-src 'none'"}});
    }
    if(path.startsWith('/api/continuity')){requireAdmin(user);const current=await readSnapshot(db);const handled=await handleContinuity(request,{db,bucket:resources.bucket,user,...current});if(handled){if(path==='/api/continuity'&&request.method==='GET'&&handled.ok){const schedule=await statement(db,'SELECT body FROM operational_continuity_config WHERE id = ?','cloudSchedule').first<{body:string}>();const body:unknown=await handled.json();if(!body||typeof body!=='object'||Array.isArray(body))reject('INTERNAL_ERROR','Resposta de continuidade inválida.',500);return response({...body,automation:schedule?JSON.parse(schedule.body):{enabled:false}});}return handled;}}
    if(path.startsWith('/api/notifications')){const current=await readOperationalSnapshot(db);const handled=await handleContinuity(request,{db,bucket:resources.bucket,user,...current});if(handled)return handled;}
    if(path==='/api/commands'&&request.method==='POST') {
      const body=await readBody(request),revision=expectedRevision(body.revision),id=commandId(user,body.idempotencyKey);
      const type=field(body.type,'Operação',80);assertActiveCommand({type,payload:body.payload??{}});if(!canWithCapabilities(user,type)) reject('FORBIDDEN','Seu perfil e suas permissões não permitem esta operação.',403);
      const payload=body.payload??{},hash=await sha({type,payload});const previous=await previousCommand(db,id,hash);if(previous) return replay(db,previous,user);
      const current=await readSnapshot(db);if(current.revision!==revision) reject('REVISION_CONFLICT','Os dados mudaram. Atualize a página antes de repetir a operação.',409);
      if(type==='MASTER_SAVE') {
        const data=payload as Record<string,any>,record=data.record;
        if(data.kind==='people'&&record&&typeof record==='object'&&!Array.isArray(record)) {
          const old=current.state.people.find((person:Record<string,any>)=>person.id===record.id);
          const changingRequirement=['securityStatus','restrictions','allowedAreaIds'].some(key=>Object.hasOwn(record,key)&&JSON.stringify(record[key])!==JSON.stringify(old?.[key]??({securityStatus:'cleared',restrictions:'',allowedAreaIds:[]} as Record<string,any>)[key]));
          if(changingRequirement||(old?.active===false&&record.active===true)||(record.category==='employee'&&old?.category!=='employee')||(record.category==='contractor'&&record.securityStatus==='cleared'&&old?.category!=='contractor'))requireCapability(user,'accessManage');
        }
      }
      if(type==='VISITOR_REQUEST'&&!(payload as Record<string,any>).personId&&(payload as Record<string,any>).category==='employee')requireCapability(user,'accessManage');
      if(['ACCESS_AREA_SAVE','VISITOR_REQUEST','RECORD_CORRECT'].includes(type)) {
        const data=payload as Record<string,any>,fields=type==='ACCESS_AREA_SAVE'?(data.record??data):type==='RECORD_CORRECT'?(data.changes??{}):data;
        await validateAssignments(db,fields);
        if(type==='RECORD_CORRECT'&&['responsibleUserId','substituteUserId'].some(key=>Object.hasOwn(fields,key)))requireCapability(user,'accessManage');
        if(type==='VISITOR_REQUEST'&&data.areaId){const area=current.state.accessAreas.find((row:Record<string,any>)=>row.id===data.areaId);if(area&&['responsibleUserId','substituteUserId'].some(key=>Object.hasOwn(data,key)&&(data[key]||null)!==(area[key]||null)))requireCapability(user,'accessManage');}
      }
      if(type==='INCIDENT_CREATE') {
        const ids=(payload as Record<string,unknown>).attachmentIds;
        if(Array.isArray(ids)&&ids.length)requireCapability(user,'documentView');
        for(const attachmentId of Array.isArray(ids)?ids:[]) {const attachment=await statement(db,'SELECT id,created_by FROM operational_attachments WHERE id = ?',attachmentId).first<{id:string;created_by:string}>();if(!attachment||(attachment.created_by!==user.id&&user.role!=='admin'))reject('VALIDATION','Um anexo não está disponível para esta ocorrência.');}
      }
      const outcome=execute(current.state,{type,payload,at:new Date().toISOString()},{id:user.id,name:user.name,role:user.role});
      if(['VISITOR_REQUEST','ACCESS_AREA_SAVE'].includes(type))await validateAssignments(db,outcome.result);
      if(type==='RECORD_CORRECT'&&(payload as Record<string,any>).kind==='visitor'){
        const old=current.state.visitors.find(visit=>visit.id===outcome.result.id);
        if(old&&['responsibleUserId','substituteUserId'].some(key=>(old[key]??null)!==(outcome.result[key]??null))){requireCapability(user,'accessManage');await validateAssignments(db,outcome.result);}
      }
      const existingAuditIds=new Set(current.state.audit.map((event:{id:string})=>event.id));
      const mutations=[...recordStatements(db,current.state,outcome.state),...outcome.state.audit.filter((event:{id:string})=>!existingAuditIds.has(event.id)).map((event:Audit)=>appendAudit(db,event))];
      // Uma pessoa desligada ou bloqueada perde os códigos já emitidos, inclusive
      // quando sua permanência continua aberta para saída e conferência física.
      const invalidPeople=new Set<string>(outcome.state.people.filter((person:Record<string,any>)=>!person.active||['pending','blocked'].includes(person.securityStatus)).map((person:Record<string,any>)=>person.id));
      for(const visit of outcome.state.visitors)if(visit.personId&&invalidPeople.has(visit.personId))mutations.push(statement(db,'DELETE FROM operational_passes WHERE visitor_id=?',visit.id));
      if(type==='PERSON_REQUIREMENT_SAVE')for(const visit of outcome.state.visitors){const old=current.state.visitors.find(row=>row.id===visit.id);if(old&&['authorized','inside'].includes(old.status)&&!['authorized','inside'].includes(visit.status))mutations.push(statement(db,'DELETE FROM operational_passes WHERE visitor_id=?',visit.id));}
      if(type==='RECORD_CORRECT'&&(payload as Record<string,unknown>).kind==='visitor') {
        const changed=outcome.result as Record<string,any>,old=current.state.visitors.find(visit=>visit.id===changed.id);
        if(old&&['personId','areaId','stayId','responsibleUserId','substituteUserId'].some(key=>(old[key]??null)!==(changed[key]??null)))mutations.push(statement(db,'DELETE FROM operational_passes WHERE visitor_id=?',changed.id));
      }
      const committed=await commit(db,user,revision,mutations,id,hash,outcome.result,stateDelta(current.state,outcome.state));if(committed.saved) return replay(db,committed.saved,user);
      try {await refreshNotifications({db,bucket:resources.bucket,user,state:outcome.state,revision:revision+1});}catch{console.error('Não foi possível atualizar os avisos da operação. A próxima consulta tentará novamente.');}
      return response({...operationalVisible({state:outcome.state,revision:revision+1},user),result:redactValue(outcome.result,user.capabilities)});
    }
    if(path==='/api/users'&&request.method==='GET') {requireAdmin(user);return response(await userList(db));}
    if(path==='/api/users'&&request.method==='POST') {
      requireAdmin(user);const body=await readBody(request),id=commandId(user,body.idempotencyKey??uuid('users')),hash=await sha({action:body.action,payload:body});
      const prior=await previousCommand(db,id,hash);if(prior)return response({...await userList(db),revision:prior.revision,result:JSON.parse(prior.result),replayed:true});
      const current=await readSnapshot(db);const now=new Date().toISOString();let result:unknown;const mutations:D1PreparedStatement[]=[];let event:Audit;
      if(body.action==='create_local') {
        const username=validUsername(body.username),password=validPassword(body.password);
        const email=normalizeEmail(body.email),name=field(body.name,'Nome',150),role=roleOf(body.role);
        if(await statement(db,'SELECT id FROM operational_users WHERE email=?',email).first() ||
           await statement(db,'SELECT user_id FROM operational_credentials WHERE username=?',username).first())reject('DUPLICATE','Este usuário ou e-mail já está cadastrado.',409);
        const newId=uuid('local');const credential=await hashPassword(password);
        const created={id:newId,email,name,role,status:'active',username,mustChangePassword:true,createdAt:now,updatedAt:now};result=created;
        mutations.push(statement(db,'INSERT INTO operational_users (id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',newId,email,name,role,'active',now,now));
        mutations.push(statement(db,`INSERT INTO operational_credentials (user_id,username,password_salt,password_hash,password_iterations,password_changed_at) VALUES (?,?,?,?,?,?)`,newId,username,credential.salt,credential.hash,credential.iterations,now));
        event=makeAudit(user,'USER_CREATE_LOCAL','user',newId,null,created);
      } else if(body.action==='reset_password') {
        const targetId=field(body.id,'Usuário',200),newPassword=validPassword(body.password);
        const target=await statement(db,'SELECT id,email,name,role,status FROM operational_users WHERE id=?',targetId).first<User>();
        const account=await statement(db,'SELECT user_id FROM operational_credentials WHERE user_id=?',targetId).first();
        if(!target||!account)reject('NOT_FOUND','Conta local não encontrada.',404);
        const credential=await hashPassword(newPassword);
        result={id:targetId,reset:true};
        mutations.push(statement(db,`UPDATE operational_credentials SET password_salt=?,password_hash=?,password_iterations=?,password_changed_at=?,must_change_password=1,failed_attempts=0,locked_until=NULL WHERE user_id=?`,credential.salt,credential.hash,credential.iterations,now,targetId));
        mutations.push(statement(db,'DELETE FROM operational_sessions WHERE user_id=?',targetId));
        event=makeAudit(user,'USER_PASSWORD_RESET','user',targetId,{id:targetId},{id:targetId,credentialsRotated:true});
      } else if(body.action==='invite') {
        const email=normalizeEmail(body.email),name=field(body.name??email,'Nome',150),role=roleOf(body.role);
        const existingUser=await statement(db,'SELECT id FROM operational_users WHERE email = ?',email).first();if(existingUser) reject('DUPLICATE','Este usuário já está cadastrado. Altere seu perfil na lista de usuários.',409);
        const old=await statement(db,'SELECT id,email,name,role,status FROM operational_invites WHERE email = ?',email).first<{id:string;status:string}>();if(old?.status==='pending') reject('DUPLICATE','Já existe uma liberação pendente para este e-mail.',409);
        const invite={id:old?.id??uuid('invite'),email,name,role,status:'pending',createdAt:now,createdBy:user.id};result=invite;
        mutations.push(statement(db,`INSERT INTO operational_invites (id,email,name,role,status,created_at,created_by) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,status='pending',created_at=excluded.created_at,created_by=excluded.created_by,accepted_at=NULL,accepted_by=NULL`,invite.id,email,name,role,'pending',now,user.id));
        event=makeAudit(user,'USER_INVITE','invite',invite.id,old,invite);
      } else if(body.action==='update') {
        const id=field(body.id,'Usuário',200),status=field(body.status,'Situação',20);if(!['active','pending','disabled'].includes(status)) reject('VALIDATION','Situação de usuário inválida.');
        const old=await statement(db,'SELECT id,email,name,role,status FROM operational_users WHERE id = ?',id).first<User>();if(!old) reject('NOT_FOUND','Usuário não encontrado.',404);
        const role=old.role==='finance'&&body.role==='finance'?old.role:roleOf(body.role);
        const updated={...old,role,status,updatedAt:now};result=updated;mutations.push(statement(db,'UPDATE operational_users SET role=?,status=?,updated_at=? WHERE id=?',role,status,now,id));if(status==='disabled')mutations.push(statement(db,'DELETE FROM operational_sessions WHERE user_id=?',id));event=makeAudit(user,'USER_UPDATE','user',id,old,updated);
      } else if(body.action==='revoke_invite') {
        const id=field(body.id,'Liberação',200),old=await statement(db,'SELECT id,email,name,role,status FROM operational_invites WHERE id = ?',id).first<{id:string;status:string}>();if(!old) reject('NOT_FOUND','Liberação não encontrada.',404);if(old.status!=='pending') reject('INVALID_TRANSITION','Somente uma liberação pendente pode ser revogada.',409);
        result={...old,status:'revoked'};mutations.push(statement(db,"UPDATE operational_invites SET status='revoked' WHERE id=?",id));event=makeAudit(user,'USER_INVITE_REVOKE','invite',id,old,result);
      } else reject('VALIDATION','Ação de usuário inválida.');
      mutations.push(appendAudit(db,event));
      const committed=await commit(db,user,current.revision,mutations,id,hash,result);
      return response({...await userList(db),revision:committed.saved?.revision??current.revision+1,result:committed.saved?JSON.parse(committed.saved.result):result});
    }
    if(path==='/api/backup'&&request.method==='GET') {
      requireAdmin(user);const current=await readSnapshot(db);
      // A restauração conserva a auditoria protegida da base atual. Seu arquivo de
      // evidência é exportado separadamente, para não inflar o backup operacional.
      const backup={format:'porto-gestao-backup',version:2,exportedAt:new Date().toISOString(),...current,state:{...current.state,audit:[]},auditIncluded:false};
      if(new TextEncoder().encode(JSON.stringify(backup)).byteLength>MAX_BACKUP) reject('BACKUP_TOO_LARGE','O backup operacional excede o limite de restauração de aproximadamente 5 MB. Use o procedimento de cópia da infraestrutura para esta base.',413);
      return response(backup,200,{'Content-Disposition':`attachment; filename="porto-gestao-backup-${new Date().toISOString().slice(0,10)}.json"`});
    }
    if(path==='/api/audit-export'&&request.method==='GET') {
      requireAdmin(user);const current=await readSnapshot(db);
      return response({format:'porto-gestao-audit',version:2,exportedAt:new Date().toISOString(),revision:current.revision,audit:current.state.audit},200,{'Content-Disposition':`attachment; filename="porto-auditoria-${new Date().toISOString().slice(0,10)}.json"`});
    }
    if(path==='/api/restore'&&request.method==='POST') {
      requireAdmin(user);const body=await readBody(request,MAX_RESTORE),revision=expectedRevision(body.revision),reason=field(body.reason,'Justificativa da restauração',1000),id=commandId(user,body.idempotencyKey);
      const backup=body.backup as Record<string,unknown>|null;if(!backup||backup.format!=='porto-gestao-backup'||backup.version!==2) reject('INVALID_BACKUP','Formato ou versão de backup incompatível.');
      const hash=await sha({backup,reason}),previous=await previousCommand(db,id,hash);if(previous) return replay(db,previous,user);
      const current=await readSnapshot(db);if(current.revision!==revision) reject('REVISION_CONFLICT','A base mudou. Atualize antes de restaurar.',409);
      const restored=validateState(backup.state);await assertRestoreAttachments(db,resources.bucket,restored as State);restored.audit=current.state.audit;
      for(const assigned of [...restored.visitors,...restored.accessAreas])await validateAssignments(db,assigned,true);
      for(const requirement of restored.personRequirements??[])if(requirement.reviewedByUserId&&!await statement(db,'SELECT id FROM operational_users WHERE id=?',requirement.reviewedByUserId).first())reject('INVALID_BACKUP','O conferente de um requisito não existe nesta instalação.');
      const summarize=(state:State)=>Object.fromEntries(COLLECTIONS.map(collection=>[collection,(state as unknown as Record<string,unknown[]>)[collection].length]));
      const event=makeAudit(user,'BACKUP_RESTORE','backup',uuid('restore'),{revision,counts:summarize(current.state)},{sourceRevision:backup.revision,exportedAt:backup.exportedAt,sha256:await sha(backup.state),counts:summarize(restored)},reason);
      restored.audit=[event,...current.state.audit];const result={restored:true,sourceRevision:backup.revision,counts:summarize(restored)};
      const committed=await commit(db,user,revision,[...recordStatements(db,current.state,restored),statement(db,'DELETE FROM operational_passes'),appendAudit(db,event)],id,hash,result);if(committed.saved) return replay(db,committed.saved,user);
      return response({...operationalVisible({state:restored,revision:revision+1},user),result});
    }
    if(['/api/auth/login','/api/auth/logout','/api/session','/api/state','/api/sync','/api/records','/api/approvers','/api/monthly-preview','/api/commands','/api/users','/api/backup','/api/audit-export','/api/restore'].includes(path)) reject('METHOD_NOT_ALLOWED','Método não permitido.',405);
    reject('NOT_FOUND','Recurso não encontrado.',404);
  } catch(error) {
    if(error instanceof ApiError) return response({error:{code:error.code,message:error.message}},error.status);
    const domainError=error as Error & {code?:string};
    if(domainError.message?.startsWith('A senha deve')||domainError.message?.startsWith('Usuário inválido'))return response({error:{code:'VALIDATION',message:domainError.message}},400);
    if(domainError.code) {const status=domainError.code==='FORBIDDEN'?403:domainError.code==='NOT_FOUND'?404:domainError.code==='INVALID_BACKUP'?422:400;return response({error:{code:domainError.code,message:domainError.message}},status);}
    console.error('Porto API failure',error instanceof Error?error.message:'Unknown database failure');
    return response({error:{code:'INTERNAL_ERROR',message:'Não foi possível concluir a operação. Tente novamente ou procure o administrador.'}},500);
  }
}
