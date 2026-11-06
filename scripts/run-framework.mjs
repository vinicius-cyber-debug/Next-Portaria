import { fileURLToPath } from "node:url";
import {loadApplicationEnvironment,postgresConfig,configPath} from './postgres-config.mjs';
import {existsSync} from 'node:fs';
const provider=loadApplicationEnvironment();

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Expected dev, build or start.");
if(provider==='postgres'&&command!=='build'){
  if(existsSync(configPath)){
    const config=postgresConfig();
    if(config.manageCluster!==false){const {startPostgres}=await import('./postgres-local.mjs');startPostgres(config);}
  }
  const {registerNativeProcess}=await import('./native-process.mjs');
  const portIndex=args.lastIndexOf('--port');registerNativeProcess(command,portIndex<0?(command==='dev'?5173:3000):Number(args[portIndex+1]));
}

const cli = new URL(command==='start'?"../node_modules/vinext/dist/cli.js":"../node_modules/vite/bin/vite.js", import.meta.url);
const forwarded=command==='dev'?args.map(arg=>arg==='--hostname'?'--host':arg):args;
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(command === "dev" ? ["--port", "5173"] : []), ...forwarded];
await import(cli.href);
