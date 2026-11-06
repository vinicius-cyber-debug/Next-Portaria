import vinext from "vinext";
import { defineConfig, normalizePath } from "vite";
import { configureToolEnvironment } from "./scripts/tool-environment.mjs";
import {fileURLToPath} from 'node:url';

export default defineConfig(async () => {
  configureToolEnvironment(process.cwd());
  const postgres=process.env.PORTO_DB_PROVIDER==='postgres';
  const runtimePath=normalizePath(fileURLToPath(new URL(`./lib/runtime.${postgres?'node':'cloudflare'}.ts`,import.meta.url)));
  const cloudflarePlugins=postgres?[]:[(await import('@cloudflare/vite-plugin')).cloudflare({
    viteEnvironment:{name:'rsc',childEnvironments:['ssr']},inspectorPort:false,
    config:{main:'./worker/index.ts',compatibility_flags:['nodejs_compat'],
      d1_databases:[{binding:'DB',database_name:'porto-d1',database_id:'00000000-0000-4000-8000-000000000000'}],
      r2_buckets:[{binding:'BUCKET',bucket_name:'porto-r2'}]},
  })];

  return {
    cacheDir: postgres?'node_modules/.vite-postgres':'node_modules/.vite',
    ssr: postgres?{external:['pg']}:undefined,
    server: { strictPort: true },
    plugins: [
      vinext(),
      {name:'portaria-runtime',resolveId(id:string){return id==='virtual:portaria-resources'?runtimePath:undefined;}},
      ...cloudflarePlugins,
    ],
  };
});
