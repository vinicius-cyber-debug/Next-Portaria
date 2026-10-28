import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, check, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Entidades separadas permitem evolução e busca sem um documento operacional único. */
export const records = sqliteTable('operational_records', {
  collection: text('collection').notNull(),
  id: text('id').notNull(),
  body: text('body').notNull(),
  personId: text('record_person_id').generatedAlwaysAs(sql`json_extract(body, '$.personId')`, {mode:'virtual'}),
  status: text('record_status').generatedAlwaysAs(sql`json_extract(body, '$.status')`, {mode:'virtual'}),
  areaId: text('record_area_id').generatedAlwaysAs(sql`json_extract(body, '$.areaId')`, {mode:'virtual'}),
  expectedAt: text('record_expected_at').generatedAlwaysAs(sql`json_extract(body, '$.expectedAt')`, {mode:'virtual'}),
  category: text('record_category').generatedAlwaysAs(sql`json_extract(body, '$.category')`, {mode:'virtual'}),
  active: integer('record_active').generatedAlwaysAs(sql`json_extract(body, '$.active')`, {mode:'virtual'}),
  stayId: text('record_stay_id').generatedAlwaysAs(sql`json_extract(body, '$.stayId')`, {mode:'virtual'}),
  responsibleUserId: text('record_responsible_user_id').generatedAlwaysAs(sql`json_extract(body, '$.responsibleUserId')`, {mode:'virtual'}),
  validUntil: text('record_valid_until').generatedAlwaysAs(sql`json_extract(body, '$.validUntil')`, {mode:'virtual'}),
  updatedAt: text('record_updated_at').generatedAlwaysAs(sql`json_extract(body, '$.updatedAt')`, {mode:'virtual'}),
}, t => [
  primaryKey({ columns: [t.collection, t.id] }), check('record_json', sql`json_valid(${t.body})`),
  // A mesma pessoa nunca possui duas presenças abertas, inclusive em gravações concorrentes.
  uniqueIndex('operational_visit_person_inside_unique').on(t.personId).where(sql`${t.collection} = 'visitors' AND ${t.status} = 'inside' AND ${t.personId} IS NOT NULL AND ${t.personId} <> ''`),
  index('operational_visitors_destination_idx').on(t.areaId,t.status,t.expectedAt).where(sql`${t.collection} = 'visitors'`),
  index('operational_people_category_idx').on(t.category,t.active).where(sql`${t.collection} = 'people'`),
  index('operational_manifest_stay_idx').on(t.stayId,t.active).where(sql`${t.collection} = 'crewManifests'`),
  index('operational_visitors_responsible_idx').on(t.responsibleUserId,t.status,t.expectedAt).where(sql`${t.collection} = 'visitors'`),
  index('operational_requirements_validity_idx').on(t.personId,t.status,t.validUntil).where(sql`${t.collection} = 'personRequirements'`),
  index('operational_records_updated_idx').on(t.collection,t.updatedAt),
]);

export const settings = sqliteTable('operational_settings', {
  id: text('id').primaryKey(), body: text('body').notNull(),
}, t => [check('settings_json', sql`json_valid(${t.body})`)]);

export const meta = sqliteTable('operational_meta', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull().default(0),
}, t => [check('singleton_meta', sql`${t.id} = 1`)]);

/** Cada revisão mantém apenas as mudanças necessárias à sincronização dos clientes. */
export const changes = sqliteTable('operational_changes', {
  revision:integer('revision').primaryKey(),createdAt:text('created_at').notNull(),body:text('body').notNull(),
}, t=>[check('change_json',sql`json_valid(${t.body})`),index('operational_changes_created_idx').on(t.createdAt)]);

export const users = sqliteTable('operational_users', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), name: text('name').notNull(),
  role: text('role').notNull(), status: text('status').notNull(),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, t => [check('user_role', sql`${t.role} IN ('admin','director','gate','operations','finance','reader')`), check('user_status', sql`${t.status} IN ('active','pending','disabled')`)]);

export const invites = sqliteTable('operational_invites', {
  id: text('id').primaryKey(), email: text('email').notNull().unique(), name: text('name').notNull(),
  role: text('role').notNull(), status: text('status').notNull(), createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(), acceptedAt: text('accepted_at'), acceptedBy: text('accepted_by'),
}, t => [check('invite_role', sql`${t.role} IN ('admin','director','gate','operations','finance','reader')`), check('invite_status', sql`${t.status} IN ('pending','accepted','revoked')`)]);

export const audit = sqliteTable('operational_audit', {
  id: text('id').primaryKey(), at: text('at').notNull(), body: text('body').notNull(),
}, t => [check('audit_json', sql`json_valid(${t.body})`)]);

/** Idempotência é vinculada ao operador e ao conteúdo, nunca ao perfil escolhido no navegador. */
export const commands = sqliteTable('operational_commands', {
  id: text('id').primaryKey(), actorId: text('actor_id').notNull(), hash: text('hash').notNull(),
  result: text('result').notNull(), revision: integer('revision').notNull(), createdAt: text('created_at').notNull(),
}, t => [check('command_json', sql`json_valid(${t.result})`)]);

/** A trigger de db/guards.sql verifica revisão e permissão dentro da mesma transação D1. */
export const mutationGuard = sqliteTable('operational_mutation_guard', {
  token: text('token').primaryKey(), expectedRevision: integer('expected_revision').notNull(),
  actorId: text('actor_id').notNull(), actorRole: text('actor_role').notNull(),
});

export const access = sqliteTable('operational_access', {
  userId: text('user_id').primaryKey(), body: text('body').notNull(),
}, t => [check('access_json', sql`json_valid(${t.body})`)]);

export const passes = sqliteTable('operational_passes', {
  id: text('id').primaryKey(), visitorId: text('visitor_id').notNull().unique(),
  tokenHash: text('token_hash').notNull().unique(), expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(), createdBy: text('created_by').notNull(),
});

export const attachments = sqliteTable('operational_attachments', {
  id: text('id').primaryKey(), objectKey: text('object_key').notNull().unique(),
  name: text('name').notNull(), type: text('type').notNull(), size: integer('size').notNull(),
  createdAt: text('created_at').notNull(), createdBy: text('created_by').notNull(),
});

export const continuityConfig = sqliteTable('operational_continuity_config', {
  id: text('id').primaryKey(), body: text('body').notNull(),
}, t => [check('continuity_json', sql`json_valid(${t.body})`)]);

export const backupRuns = sqliteTable('operational_backup_runs', {
  id: text('id').primaryKey(), createdAt: text('created_at').notNull(),
  status: text('status').notNull(), body: text('body').notNull(),
}, t => [check('backup_run_json', sql`json_valid(${t.body})`)]);

export const notifications = sqliteTable('operational_notifications', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), entityId: text('entity_id').notNull(),
  createdAt: text('created_at').notNull(), body: text('body').notNull(),
}, t => [check('notification_json', sql`json_valid(${t.body})`)]);

export const notificationReads = sqliteTable('operational_notification_reads', {
  notificationId: text('notification_id').notNull(), userId: text('user_id').notNull(), readAt: text('read_at').notNull(),
}, t => [primaryKey({columns:[t.notificationId,t.userId]})]);

export const jobLocks = sqliteTable('operational_job_locks', {
  id: text('id').primaryKey(), leaseUntil: text('lease_until').notNull(), token: text('token').notNull(),
});

export const credentials = sqliteTable('operational_credentials', {
  userId: text('user_id').primaryKey(), username:text('username').notNull().unique(),
  passwordSalt:text('password_salt').notNull(), passwordHash:text('password_hash').notNull(),
  passwordIterations:integer('password_iterations').notNull().default(310000),
  failedAttempts:integer('failed_attempts').notNull().default(0),lockedUntil:text('locked_until'),
  passwordChangedAt:text('password_changed_at').notNull(),
  mustChangePassword:integer('must_change_password',{mode:'boolean'}).notNull().default(true),
});
export const sessions = sqliteTable('operational_sessions', {
  tokenHash:text('token_hash').primaryKey(),userId:text('user_id').notNull(),
  createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),
});
