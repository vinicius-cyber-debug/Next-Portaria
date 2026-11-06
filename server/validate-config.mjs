import {readFileSync} from 'node:fs';
import {validateServerConfig} from '../lib/server-network.mjs';
const [cert,key,host,subnet,port,uiPort]=process.argv.slice(2);
validateServerConfig(cert?{cert,key,host,subnet,port:Number(port),uiPort:Number(uiPort)}:JSON.parse(readFileSync('.porto-runtime/server.json','utf8')));
console.log('Certificado, chave, IP, portas e rede conferidos.');
