import {readFile} from 'node:fs/promises';
import {postgresConfig} from './postgres-config.mjs';
import {PostgresDatabase} from '../lib/persistence/postgres.ts';
import {readSnapshot} from '../lib/server.ts';
import {IdSecureReader} from '../lib/integrations/idsecure.ts';
import {visitorFacePlan} from '../lib/integrations/visitor-face-plan.mjs';
const config=JSON.parse(await readFile('.porto-runtime/visitor-face.json','utf8')),reader=await IdSecureReader.fromFile('.porto-runtime/idsecure.json'),db=new PostgresDatabase(postgresConfig().database);
try{const {state}=await readSnapshot(db),plan=visitorFacePlan(state,config,await reader.readDevices());console.log(JSON.stringify({target:plan.target,hardwareWritesEnabled:plan.hardwareWritesEnabled,requests:plan.requests.length,byStatus:Object.fromEntries(['awaiting_integration_validation','scheduled','inactive','blocked'].map(status=>[status,plan.requests.filter(request=>request.status===status).length]))},null,2));}finally{await db.close();}
