import {loadApplicationEnvironment} from './postgres-config.mjs';
import {getResources} from '../lib/runtime.node.ts';
import {defaultCapabilities} from '../lib/access.mjs';
loadApplicationEnvironment();
const resources=getResources(),user={id:'system-retention',name:'Rotina de retenção',role:'admin',status:'active',capabilities:defaultCapabilities('admin')};
try{console.log(JSON.stringify(await resources.media.runRetention({user,authorize:async()=>user})));}
catch(error){console.error('Retencao falhou:',error.message);process.exitCode=1;}
finally{await resources.db.close();}
