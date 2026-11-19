import {postgresConfig,configuredIdSecurePath} from './postgres-config.mjs';
import {PostgresDatabase} from '../lib/persistence/postgres.ts';
import {FileObjectStore} from '../lib/storage/filesystem.ts';
import {IdSecureReader} from '../lib/integrations/idsecure.ts';
import {importDirectory} from '../lib/integrations/directory-import.ts';
import {hasDatabaseEnvironmentOverride} from '../lib/integrations/config-paths.mjs';

// Private settings are configured on the server, never accepted as CLI passwords.
const args=process.argv.slice(2);
if(args.length!==1||!['--preview','--apply'].includes(args[0]))throw Error('Use --preview ou --apply. Faça backup completo antes de aplicar.');
if(hasDatabaseEnvironmentOverride(process.env))throw Error('Este importador exige o perfil PostgreSQL instalado e recusa banco ou mídia de ambiente explícito/QA. Use uma instalação isolada para homologação.');
const reader=await IdSecureReader.fromFile(configuredIdSecurePath());
if(args[0]==='--preview'){
 const {total}=await reader.readPage(0,1);console.log(JSON.stringify({mode:reader.mode,total}));
}else{
 const config=postgresConfig(),db=new PostgresDatabase(config.database);
 try{console.log(JSON.stringify(await importDirectory(db,new FileObjectStore(config.mediaRoot),reader,counts=>console.log(JSON.stringify(counts)))));}catch{console.error('Importação interrompida. Nenhuma alteração parcial de cadastros foi confirmada. Verifique a conexão/configuração e execute novamente.');process.exitCode=1;}finally{await db.close();}
}
