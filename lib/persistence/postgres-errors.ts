const triggerMessages=new Set(['REVISION_CONFLICT','ACCESS_REVOKED','LAST_ADMIN','AUDIT_IMMUTABLE','PORTO_FULL_RESTORE_REQUIRED']);
const connectionCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOTFOUND']);
type Failure={code?:string;severity?:string;message?:string};

/** SQLSTATE is internal metadata; `code` is an application code safe for the API. */
export class PostgresError extends Error {
  readonly sqlState?:string;
  readonly code?:'REVISION_CONFLICT'|'DUPLICATE';
  readonly retryable:boolean;
  constructor(source:unknown){
    const failure=(source??{}) as Failure;
    const sqlState=typeof failure.code==='string'&&/^[0-9A-Z]{5}$/.test(failure.code)&&!connectionCodes.has(failure.code)?failure.code:undefined;
    const conflict=sqlState==='40001'||sqlState==='40P01';
    const trigger=sqlState==='P0001'&&triggerMessages.has(failure.message??'')?failure.message:undefined;
    super(conflict?'REVISION_CONFLICT':sqlState==='23505'?'Já existe um registro com estes identificadores.':trigger??'Falha na operação PostgreSQL.',{cause:source});
    this.name='PostgresError';this.sqlState=sqlState;this.retryable=conflict;
    this.code=conflict||trigger==='REVISION_CONFLICT'?'REVISION_CONFLICT':sqlState==='23505'?'DUPLICATE':undefined;
  }
}
export function postgresError(error:unknown):PostgresError{return error instanceof PostgresError?error:new PostgresError(error);}
export function isPostgresFailure(error:unknown):boolean{
  const failure=(error??{}) as Failure;
  return error instanceof PostgresError||(typeof failure.code==='string'&&(
    (typeof failure.severity==='string'&&/^[0-9A-Z]{5}$/.test(failure.code))||connectionCodes.has(failure.code)));
}
