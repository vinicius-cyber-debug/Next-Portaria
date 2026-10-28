/**
 * Initializes the local Cloudflare D1 database without touching a remote database.
 * Run after `npm run build`, before `npm run dev`.
 * This script never uses --remote and does not reset a database.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const configPath = resolve(root, 'dist/server/wrangler.json');

function fail(message) {
  console.error(`ERRO: ${message}`);
  process.exit(1);
}
if (!existsSync(wrangler)) fail('Wrangler indisponível. Execute npm ci.');
if (!existsSync(configPath)) fail('Compilação ausente. Execute npm run build.');

let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch { fail('Não foi possível ler dist/server/wrangler.json. Refaça npm run build.'); }
if (!config.d1_databases?.some(entry => entry.binding === 'DB')) {
  fail('A compilação não contém o banco D1 com binding DB.');
}

const wranglerArgs = [
  '--import', './scripts/runtime-env.mjs', './node_modules/wrangler/bin/wrangler.js',
  'd1', 'execute', 'DB', '--local', '--config', 'dist/server/wrangler.json',
  '--persist-to', '.wrangler/state',
];
function executeDb(extra, silent = false) {
  const done = spawnSync(process.execPath, [...wranglerArgs, ...extra], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: false,
  });
  if (done.error) fail(`Falha ao executar Wrangler: ${done.error.message}`);
  if (done.status !== 0) {
    console.error(done.stdout?.trim() || '');
    console.error(done.stderr?.trim() || '');
    fail(`A operação no banco LOCAL falhou (código ${done.status}). Nenhuma base remota foi acessada.`);
  }
  if (!silent) console.log(done.stdout?.trim() || 'Comando concluído.');
  return done.stdout?.trim() || '';
}
function queryRows(sql) {
  const stdout = executeDb([
    '--command', sql,
    '--json',
  ], true);
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch {
    // Some versions of Wrangler print introductory lines before JSON.
    const start = stdout.indexOf('[{');
    if (start >= 0) {
      try { parsed = JSON.parse(stdout.slice(start)); } catch { /* handled below */ }
    }
  }
  if (!parsed) fail('Wrangler não retornou JSON válido ao consultar o esquema. Não é seguro aplicar migrações automaticamente.');
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  if (!batches.length || batches.some(batch => batch.success === false || !Array.isArray(batch.results))) {
    fail('A consulta do D1 não retornou um conjunto de resultados válido.');
  }
  return batches.flatMap(batch => batch.results);
}
function queryNames() {
  return new Set(queryRows("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index') AND name LIKE 'operational_%' ORDER BY name;").map(row => row.name).filter(name => typeof name === 'string'));
}
function queryRecordColumns() {
  return new Set(queryRows("PRAGMA table_xinfo('operational_records');").map(row => row.name).filter(name => typeof name === 'string'));
}
const initial = [
  'operational_audit', 'operational_commands', 'operational_invites',
  'operational_meta', 'operational_mutation_guard', 'operational_records',
  'operational_settings', 'operational_users',
  'operational_revision_guard', 'operational_last_admin_update',
];
const second = [
  'operational_access', 'operational_attachments', 'operational_backup_runs',
  'operational_continuity_config', 'operational_job_locks',
  'operational_notification_reads', 'operational_notifications',
  'operational_passes',
];
function status(names, expected) {
  const present = expected.filter(n => names.has(n));
  if (present.length > 0 && present.length < expected.length) {
    fail(`Esquema local aparentemente incompleto: ${present.length}/${expected.length} objetos encontrados. Nenhuma migração automática aplicada. Faça backup da pasta .wrangler/state antes de reparar.`);
  }
  return present.length === expected.length;
}
console.log('Conferindo banco Cloudflare D1 LOCAL (.wrangler/state)...');
let names = queryNames();
const hasInitial = status(names, initial);
const hasSecond = status(names, second);
if (hasSecond && !hasInitial) fail('Esquema inconsistente: migração 0001 encontrada sem a 0000.');
if (!hasInitial) {
  console.log('Aplicando migração local 0000...');
  executeDb(['--file', 'drizzle/0000_jazzy_scarecrow.sql']);
  names = queryNames();
  if (!status(names, initial)) fail('Migração 0000 não criou todos os objetos esperados.');
}
if (!hasSecond) {
  console.log('Aplicando migração local 0001...');
  executeDb(['--file', 'drizzle/0001_tiny_ego.sql']);
  names = queryNames();
  if (!status(names, second)) fail('Migração 0001 não criou todos os objetos esperados.');
}
// Confere tabelas, índices e proteções de autenticação antes de aplicar 0002 uma só vez.
const authTables = ['operational_credentials', 'operational_sessions','operational_sessions_user_idx','operational_sessions_expiry_idx','operational_last_local_admin_update','operational_last_local_admin_delete'];
if (!status(names, authTables)) {
  console.log('Aplicando migração local 0002 (usuários e sessões)...');
  executeDb(['--file', 'drizzle/0002_local_users.sql']);
  names = queryNames();
  if (!status(names, authTables)) fail('Migração 0002 não criou as tabelas de autenticação.');
}
const physicalAccessIndexes = ['operational_visit_person_inside_unique', 'operational_visitors_destination_idx', 'operational_people_category_idx', 'operational_manifest_stay_idx'];
const physicalAccessColumns = ['record_person_id', 'record_status', 'record_area_id', 'record_expected_at', 'record_category', 'record_active', 'record_stay_id'];
const hasPhysicalAccess = status(names, physicalAccessIndexes);
const columns = queryRecordColumns();
if (physicalAccessColumns.some(name => columns.has(name)) && !hasPhysicalAccess) {
  fail('Migração 0003 aparentemente incompleta: existem colunas de acesso sem todos os índices. Não é seguro repetir ALTER TABLE. Faça backup de .wrangler/state e solicite conferência/reparo do esquema antes de tentar novamente.');
}
if (hasPhysicalAccess && physicalAccessColumns.some(name => !columns.has(name))) fail('Esquema de acesso inconsistente: índices 0003 encontrados sem todas as colunas esperadas. Faça backup antes de reparar.');
if (!hasPhysicalAccess) {
  console.log('Aplicando migração local 0003 (integridade do controle de acesso)...');
  executeDb(['--file', 'drizzle/0003_physical_access.sql']);
  names = queryNames();
  const migratedColumns = queryRecordColumns();
  if (!status(names, physicalAccessIndexes) || physicalAccessColumns.some(name => !migratedColumns.has(name))) fail('Migração 0003 não criou todos os objetos de controle de acesso. Faça backup antes de reparar.');
}
// A rotina de abertura não aplica migrações: esta etapa roda somente na atualização manual.
const v5Objects=['operational_changes','operational_changes_created_idx','operational_visitors_responsible_idx','operational_requirements_validity_idx','operational_records_updated_idx'];
const v5RecordColumns=['record_responsible_user_id','record_valid_until','record_updated_at'];
const v5CredentialColumns=new Set(queryRows("PRAGMA table_xinfo('operational_credentials');").map(row=>row.name));
const v5Columns=queryRecordColumns();
const v5Ready=status(names,v5Objects);
const anyV5Column=v5CredentialColumns.has('must_change_password')||v5RecordColumns.some(name=>v5Columns.has(name));
const allV5Columns=v5CredentialColumns.has('must_change_password')&&v5RecordColumns.every(name=>v5Columns.has(name));
if((anyV5Column&&!v5Ready)||(v5Ready&&!allV5Columns))fail('Migração 0004 parcialmente aplicada. Preserve o backup completo e solicite conferência do esquema; não repita ALTER TABLE.');
if(!v5Ready){
  console.log('Aplicando migração local 0004 (aprovações, validade, senhas e sincronização)...');
  executeDb(['--file','drizzle/0004_v5.sql']);
  names=queryNames();
  const finalRecordColumns=queryRecordColumns();
  const finalCredentialColumns=new Set(queryRows("PRAGMA table_xinfo('operational_credentials');").map(row=>row.name));
  if(!status(names,v5Objects)||!finalCredentialColumns.has('must_change_password')||v5RecordColumns.some(name=>!finalRecordColumns.has(name)))fail('Migração 0004 não criou todos os objetos esperados. Preserve o backup completo antes de reparar.');
}
console.log('Banco D1 local pronto. Dados existentes preservados.');
