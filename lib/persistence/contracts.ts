/** Ports used by the application; providers own connections and storage. */
export type QueryResult<T = Record<string, unknown>> = {results:T[];success:boolean;meta?:{changes:number}};
export interface PreparedStatement {
  bind(...values:unknown[]):PreparedStatement;
  first<T=Record<string,unknown>>():Promise<T|null>;
  all<T=Record<string,unknown>>():Promise<QueryResult<T>>;
  run<T=Record<string,unknown>>():Promise<QueryResult<T>>;
}
export interface Database {
  prepare(sql:string):PreparedStatement;
  batch<T=Record<string,unknown>>(statements:PreparedStatement[]):Promise<QueryResult<T>[]>;
}
export interface StoredObject {
  size:number;
  body:ReadableStream<Uint8Array>;
  text():Promise<string>;
}
export interface ObjectStore {
  put(key:string,value:string|ArrayBuffer|Uint8Array|ReadableStream,options?:unknown):Promise<unknown>;
  get(key:string):Promise<StoredObject|null>;
  head(key:string):Promise<{size:number}|null>;
  delete(key:string):Promise<unknown>;
}
export type MediaUser={id:string;name:string;role:string;status:string;capabilities?:Record<string,boolean>};
export type MediaContext={user:MediaUser;authorize:(database?:Database)=>Promise<MediaUser>};
export type MediaHandler={handle:(request:Request,context:MediaContext)=>Promise<Response>};
export type PortoHandler={enabled:boolean;handle:(request:Request,context:MediaContext,body?:Record<string,unknown>)=>Promise<Response>;restoreGuard:()=>Promise<PreparedStatement[]>};
export type RuntimeResources={db:Database;bucket:ObjectStore;media?:MediaHandler;porto?:PortoHandler;jobToken?:string;allowHttpLan?:boolean};
