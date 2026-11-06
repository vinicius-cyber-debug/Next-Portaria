import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readFile,stat,rename,rm,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import type {ObjectStore,StoredObject} from '../persistence/contracts.ts';

/** Private objects live outside the web root. No directory is publicly served. */
export class FileObjectStore implements ObjectStore {
  readonly root:string;
  constructor(root:string){this.root=resolve(root);}
  private path(key:string){
    if(typeof key!=='string'||!key||key.length>500||!key.split('/').every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'))throw Error('Chave de arquivo invalida.');
    const target=resolve(this.root,...key.split('/'));
    if(!target.startsWith(this.root+sep))throw Error('Arquivo fora do armazenamento.');return target;
  }
  private async safe(target:string,create=false){
    if(create)await mkdir(dirname(target),{recursive:true,mode:0o700});
    const root=await realpath(this.root),parent=await realpath(dirname(target));
    if(parent!==root&&!parent.startsWith(root+sep))throw Error('Link fora do armazenamento.');
    const info=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(info?.isSymbolicLink())throw Error('Links nao sao aceitos no armazenamento.');
  }
  async put(key:string,value:string|ArrayBuffer|Uint8Array|ReadableStream){
    const target=this.path(key);await this.safe(target,true);
    const temporary=target+'.'+randomUUID()+'.upload';
    try{
      const stream=value instanceof ReadableStream?Readable.fromWeb(value as import('node:stream/web').ReadableStream):Readable.from([typeof value==='string'?Buffer.from(value):Buffer.from(value as ArrayBuffer)]);
      await pipeline(stream,createWriteStream(temporary,{flags:'wx',mode:0o600}));
      await rename(temporary,target);
    }catch(error){await rm(temporary,{force:true});throw error;}
    return {key};
  }
  /** Stream a bounded request without retaining the file in application memory. */
  async putStream(key:string,source:ReadableStream,limit:number){
    let size=0;const hash=createHash('sha256');const counter=new Transform({transform(chunk,_encoding,done){size+=chunk.length;hash.update(chunk);done(size>limit?Object.assign(Error('Arquivo excede o limite.'),{code:'BODY_TOO_LARGE'}):null,chunk);}});
    const target=this.path(key);await this.safe(target,true);const temporary=target+'.'+randomUUID()+'.upload';
    try{await pipeline(Readable.fromWeb(source as import('node:stream/web').ReadableStream),counter,createWriteStream(temporary,{flags:'wx',mode:0o600}));await rename(temporary,target);return {size,sha256:hash.digest('hex')};}
    catch(error){await rm(temporary,{force:true});throw error;}
  }
  async get(key:string):Promise<StoredObject|null>{
    const path=this.path(key);
    try{await this.safe(path);const info=await stat(path);if(!info.isFile())return null;
      return {size:info.size,body:Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,text:()=>readFile(path,'utf8')};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  async head(key:string){const path=this.path(key);try{await this.safe(path);const info=await stat(path);return info.isFile()?{size:info.size}:null;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  async delete(key:string){const path=this.path(key);try{await this.safe(path);await rm(path,{force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
