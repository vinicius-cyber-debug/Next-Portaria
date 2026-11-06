import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,sep,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {projectRoot} from './postgres-config.mjs';
if(process.platform!=='win32')throw Error('Este empacotador usa o ZIP nativo do Windows.');
const ref=process.argv[2];if(!/^v\d+\.\d+\.\d+$/.test(ref??''))throw Error('Informe uma tag de release.');
function git(args){const r=spawnSync('git',args,{cwd:projectRoot,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('Git falhou. Confira a tag local.');return r.stdout.trim();}
const commit=git(['rev-parse',ref+'^{commit}']),version=JSON.parse(git(['show',`${commit}:package.json`])).version;
if(ref!=='v'+version)throw Error('Versao da tag e do pacote divergem.');
const output=resolve(process.argv[3]??join(projectRoot,'..',`NextPortaria-Servidor-${ref}.zip`));if(existsSync(output))throw Error('O pacote ja existe. Nao sera sobrescrito.');
await mkdir(dirname(output),{recursive:true});await mkdir(join(projectRoot,'.porto-tooling'),{recursive:true});
const stage=await mkdtemp(join(projectRoot,'.porto-tooling/package-')),source=join(stage,'source'),archive=join(stage,'source.zip');
git(['archive','--format=zip','--output='+archive,commit]);
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function powershell(code){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Empacotamento ZIP falhou: '+result.stderr);}
powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)},${quote(source)})`);
const files=[];
async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const path=join(folder,entry.name),relative=path.slice(source.length+1).split(sep).join('/');if(entry.isSymbolicLink()||/^\.env|\.pem$|\.key$|\.sqlite$|^\.porto-|^node_modules\//.test(relative))throw Error('Arquivo privado inesperado na tag.');if(entry.isDirectory())await walk(path);else files.push({path:relative,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}}
await walk(source);await writeFile(join(source,'release-manifest.json'),JSON.stringify({version,commit,tag:ref,createdAt:new Date().toISOString(),files},null,2));
powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)},${quote(output)},[IO.Compression.CompressionLevel]::Optimal,$false)`);
const sha256=createHash('sha256').update(await readFile(output)).digest('hex');await writeFile(output+'.sha256',sha256+'  '+output.split(sep).at(-1)+'\n');
console.log(JSON.stringify({output,version,commit,sha256,files:files.length}));
