import { fileURLToPath } from "node:url";
import {loadApplicationEnvironment,postgresConfig} from './postgres-config.mjs';
const provider=loadApplicationEnvironment();

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(command)) throw new Error("Expected dev, build or start.");
if(provider==='postgres'&&command!=='build'){
  const {startPostgres}=await import('./postgres-local.mjs');startPostgres(postgresConfig());
  const {registerNativeProcess}=await import('./native-process.mjs');
  const portIndex=args.lastIndexOf('--port');registerNativeProcess(command,portIndex<0?(command==='dev'?5173:3000):Number(args[portIndex+1]));
}

const cli = new URL("../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
