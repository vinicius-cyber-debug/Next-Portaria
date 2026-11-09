import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const configPath=resolve(projectRoot,'.porto-runtime/postgres.json');
export function postgresConfig(){if(!existsSync(configPath))throw Error('PostgreSQL nao configurado. Execute a preparacao primeiro.');const config=JSON.parse(readFileSync(configPath,'utf8'));if(config.version!==1||config.provider!=='postgres'||!config.database||!config.mediaRoot)throw Error('Configuracao PostgreSQL invalida.');return config;}
export function loadApplicationEnvironment(){
  if(process.env.PORTO_DB_PROVIDER==='sqlite')return 'sqlite';
  if(process.env.PORTO_DB_PROVIDER==='postgres'&&process.env.PORTO_PG_CONFIG&&process.env.PORTO_MEDIA_ROOT)return 'postgres';
  if(!existsSync(configPath)){if(process.env.PORTO_DB_PROVIDER==='postgres')throw Error('Configuracao PostgreSQL ausente.');return 'sqlite';}
  const config=postgresConfig();process.env.PORTO_DB_PROVIDER='postgres';process.env.PORTO_PG_CONFIG??=JSON.stringify(config.database);process.env.PORTO_MEDIA_ROOT??=config.mediaRoot;
  // Only the installed local profile opts into its own integration settings. Explicit
  // database environments (including isolated QA) must opt in separately.
  process.env.PORTO_IDSECURE_CONFIG??=resolve(projectRoot,'.porto-runtime/idsecure.json');return 'postgres';
}
