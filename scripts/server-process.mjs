import {readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {request as upstreamRequest} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {loadApplicationEnvironment,projectRoot} from './postgres-config.mjs';
import {registerNativeProcess,nativeProcessPath} from './native-process.mjs';
import {getResources} from '../lib/runtime.node.ts';
import {handleApi} from '../lib/server.ts';
import {validateServerConfig} from '../lib/server-network.mjs';

export async function startServer(config){
 const {allowed,cert,key,origin}=validateServerConfig(config);loadApplicationEnvironment();
 const resources=getResources();await resources.db.prepare('SELECT 1').first();
 registerNativeProcess('https',config.port);
 const child=spawn(process.execPath,['scripts/run-framework.mjs','start','--hostname','127.0.0.1','--port',String(config.uiPort)],{cwd:projectRoot,windowsHide:true,stdio:'inherit',env:{...process.env,PORTO_NATIVE_PROCESS_FILE:nativeProcessPath+'.ui'}});
 let stopping=false;
 const server=createServer({cert,key,minVersion:'TLSv1.2'},async(req,res)=>{
  const ip=req.socket.remoteAddress?.replace(/^::ffff:/,'');
  if(!ip||!allowed.check(ip,'ipv4')||req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
  try{
   const url=new URL(req.url,origin);if(url.origin!==origin)throw Error('Origem invalida.');
   if(url.pathname.startsWith('/api/')){
    const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined&&!['connection','transfer-encoding'].includes(name))headers.set(name,Array.isArray(value)?value.join(', '):value);
    const body=['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req);
    const request=new Request(url,{method:req.method,headers,body,duplex:'half'});
    const result=await handleApi(request,resources.db,resources);
    res.writeHead(result.status,Object.fromEntries(result.headers));
    if(result.body&&req.method!=='HEAD')await pipeline(Readable.fromWeb(result.body),res);else res.end();
   }else{
    // Only the public TLS listener constructs API requests. Forwarded headers cannot enable HTTP login.
    const headers={...req.headers,host:`127.0.0.1:${config.uiPort}`};delete headers['x-forwarded-proto'];delete headers['x-forwarded-host'];
    const upstream=upstreamRequest({hostname:'127.0.0.1',port:config.uiPort,path:url.pathname+url.search,method:req.method,headers},reply=>{res.writeHead(reply.statusCode??502,reply.headers);pipeline(reply,res).catch(()=>res.destroy());});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('Aplicacao iniciando.');});req.pipe(upstream);
   }
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 server.requestTimeout=120000;server.headersTimeout=15000;
 const shutdown=()=>{if(stopping)return;stopping=true;server.close();child.kill('SIGTERM');setTimeout(()=>process.exit(process.exitCode??0),5000).unref();};
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
 child.on('error',error=>{console.error(error.message);process.exitCode=1;shutdown();});
 child.on('exit',code=>{if(!stopping){console.error('Aplicacao encerrou:',code);process.exit(1);}});
 try{await new Promise((done,fail)=>{server.once('error',fail);server.listen(config.port,config.host,done);});}catch(error){process.exitCode=1;shutdown();await resources.db.close();throw error;}
 console.log(`Next Portaria HTTPS: ${origin}`);return {server,child,shutdown};
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/server-process.mjs')){
 try{await startServer(JSON.parse(readFileSync(process.env.PORTO_SERVER_CONFIG??join(projectRoot,'.porto-runtime/server.json'),'utf8')));}catch(error){console.error('ERRO:',error.message);process.exitCode=1;}
}
