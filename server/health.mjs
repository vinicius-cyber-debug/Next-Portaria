import {readFileSync} from 'node:fs';
import {get} from 'node:https';
import {validateServerConfig} from '../lib/server-network.mjs';
const config=JSON.parse(readFileSync('.porto-runtime/server.json','utf8')),validated=validateServerConfig(config);
function status(path){return new Promise((done,fail)=>{const req=get(validated.origin+path,{ca:validated.cert,timeout:5000},res=>{res.resume();done(res.statusCode);});req.on('timeout',()=>req.destroy(Error('Timeout HTTPS.')));req.on('error',fail);});}
const deadline=Date.now()+90000;
while(true){
 try{if(await status('/')===200&&await status('/api/session')===401&&await status('/api/media/policy')===401)break;}catch{/* boot can take a moment */}
 if(Date.now()>deadline)throw Error('HTTPS ou API nao passou no teste local. Consulte logs/application.log e o certificado.');
 await new Promise(done=>setTimeout(done,1000));
}
console.log('HTTPS local respondeu 200; sessao e midia sem autenticacao responderam 401.');
