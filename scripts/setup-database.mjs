import {spawnSync} from 'node:child_process';
import {loadApplicationEnvironment,projectRoot} from './postgres-config.mjs';
const postgres=loadApplicationEnvironment()==='postgres';
const result=spawnSync(process.execPath,['--experimental-strip-types',postgres?'scripts/postgres-local.mjs':'scripts/setup-local.mjs',...(postgres?['migrate']:[])],{cwd:projectRoot,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;
