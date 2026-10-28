import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { COLLECTIONS, createInitialState, execute, validateState } from '../lib/domain.mjs';

// Ferramenta explícita de teste. O argumento --local é fixo e não pode ser substituído.
if (process.argv.length !== 2) throw new Error('A carga de demonstração não aceita argumentos.');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = resolve(project, 'dist/server/wrangler.json');
if (!existsSync(config)) throw new Error('Execute npm run build e aplique a migração local antes da carga de demonstração.');
const now = Date.now();
const at = hours => new Date(now + hours * 3600000).toISOString();
const actor = {id:'fixture_local',name:'Equipe fictícia · teste local',role:'admin'};
let state = createInitialState();
function command(type,payload,hours=0) {const outcome=execute(state,{type,payload,at:at(hours)},actor);state=outcome.state;return outcome.result;}
command('SETTINGS_UPDATE',{unitName:'Portaria · Demonstração'},-6);
for (const [name,company,host,purpose,entered] of [
  ['Paulo Nascimento (fictício)','Inspeciona (fictícia)','Márcia · Engenharia','Inspeção de equipamento',true],
  ['Carla Martins (fictícia)','Redes Norte (fictícia)','André · TI','Manutenção de rede',true],
  ['Luiza Ferreira (fictícia)','Suprimentos Tapajós (fictícia)','Daniel · Compras','Reunião de suprimentos',false],
]) {
  const person=command('MASTER_SAVE',{kind:'people',record:{name,company,host}},-5);
  const visit=command('VISITOR_REQUEST',{name,company,host,purpose,personId:person.id,expectedAt:at(-3),validUntil:at(entered?6:0.5)},-4);
  command('VISITOR_APPROVE',{id:visit.id},-3.5);
  if(entered) command('VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true},-1.5);
}
for (const [plate,driver,company] of [
  ['ABC1D23','João Almeida (fictício)','Transportes Rota Norte (fictícia)'],
  ['DEF4G56','Fernanda Souza (fictícia)','Cargas Solimões (fictícia)'],
  ['HIJ7K89','Roberto Lima (fictício)','Serviços Porto (fictícia)'],
]) {
  const fleet=command('MASTER_SAVE',{kind:'fleet',record:{plate,driver,company,name:'Caminhão de apoio'}},-5);
  command('VEHICLE_ENTER',{plate,driver,company,fleetId:fleet.id,purpose:'Apoio à operação · teste local',host:'Carlos · Operação'},-1);
}
command('MASTER_SAVE',{kind:'companies',record:{name:'Serviços Porto (fictícia)',contact:'Contato demonstrativo'}},-5);
const safe=validateState(state);
safe.audit=state.audit;
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const sql=[
  // Falha antes de gravar se já houver operações locais. Não limpa um banco utilizado.
  'INSERT INTO operational_meta (id,revision) SELECT 2,0 WHERE EXISTS (SELECT 1 FROM operational_records);',
  'INSERT OR IGNORE INTO operational_meta (id,revision) VALUES (1,0);',
  ...['settings','berths'].map(key=>`INSERT INTO operational_settings (id,body) VALUES (${quote(key)},${quote(JSON.stringify(safe[key]))}) ON CONFLICT(id) DO UPDATE SET body=excluded.body;`),
  ...COLLECTIONS.flatMap(collection=>safe[collection].map(record=>`INSERT INTO operational_records (collection,id,body) VALUES (${quote(collection)},${quote(record.id)},${quote(JSON.stringify(record))});`)),
  ...safe.audit.map(event=>`INSERT INTO operational_audit (id,at,body) VALUES (${quote(event.id)},${quote(event.at)},${quote(JSON.stringify(event))});`),
  'UPDATE operational_meta SET revision=revision+1 WHERE id=1;',
].join('\n');
const runtime=resolve(project,'.porto-tooling');mkdirSync(runtime,{recursive:true});
const fixture=resolve(runtime,'demo-fixture.sql');writeFileSync(fixture,sql);
const run=spawnSync(process.execPath,['--import','./scripts/runtime-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config',config,'--persist-to','.wrangler/state','--file',fixture],{cwd:project,stdio:'inherit'});
if(run.error)throw run.error;
if(run.status!==0)process.exit(run.status??1);
console.log('Dados fictícios adicionados somente ao banco local. A hospedagem não foi alterada.');
