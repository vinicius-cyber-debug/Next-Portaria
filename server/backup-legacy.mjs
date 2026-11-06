import {resolve} from 'node:path';
import {createFullBackup} from '../lib/full-backup.mjs';
const [root,destination,keyFile]=process.argv.slice(2);
if(!root||!destination||!keyFile)throw Error('Informe raiz legada, destino novo e chave separada. Encerre todos os escritores antes.');
console.log(JSON.stringify(await createFullBackup({root:resolve(root),destination:resolve(destination),keyFile:resolve(keyFile),quiesced:true})));
