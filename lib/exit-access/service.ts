import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PostgresDatabase } from '../persistence/postgres.ts';
import type { MediaContext } from '../persistence/contracts.ts';
import type { ExitUser, Sector, ExitBinding, ExitPerson, ExitGateway } from './types.ts';
import {
  ExitAccessError,
  exitFail,
  exitPermissions,
  requireSector,
  requireEmployee,
} from './policy.mjs';

type Body = Record<string, unknown>;
const headers = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const id = (prefix: string) => prefix + '_' + randomUUID();
function text(value: unknown, label: string, min = 1, max = 150) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    exitFail('VALIDATION', label + ' inválido.');
  return (value as string).trim();
}
function nullable(value: unknown) {
  return value === null || value === '' ? null : text(value, 'Identificador');
}
function fields(body: Body, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    exitFail('VALIDATION', 'O comando contém campos não permitidos.');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function exitAudit(
  client: PoolClient,
  actor: { id?: string; name: string },
  action: string,
  data: Body,
  sectorId: string | null = null,
  personId: string | null = null,
  permitId: string | null = null,
) {
  await client.query(
    'INSERT INTO exit_events(id,permit_id,sector_id,person_id,action,actor_id,actor_name,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      id('ee'),
      permitId,
      sectorId,
      personId,
      action,
      actor.id ?? null,
      actor.name,
      JSON.stringify(data),
    ],
  );
}
export class ExitAccessService {
  readonly db: PostgresDatabase;
  readonly gateway: ExitGateway;
  constructor(db: PostgresDatabase, gateway: ExitGateway) {
    this.db = db;
    this.gateway = gateway;
  }
  async restoreGuard() {
    const present = await this.db
      .prepare("SELECT to_regclass('public.exit_members') AS present")
      .first<{ present: string | null }>();
    return present?.present ? [this.db.prepare('SELECT exit_assert_json_restore()')] : [];
  }
  async handle(request: Request, context: MediaContext, body?: Body): Promise<Response> {
    try {
      const exists = await this.db
        .prepare("SELECT to_regclass('public.exit_sectors') AS present")
        .first<{ present: string | null }>();
      if (!exists?.present)
        exitFail(
          'EXIT_MIGRATION_REQUIRED',
          'Atualize o banco antes de configurar os setores.',
          503,
        );
      return await this.db.transaction(async (client, scoped) => {
        await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
        const user = (await context.authorize(scoped)) as ExitUser,
          permissions = exitPermissions(user);
        if (!permissions.view)
          exitFail('FORBIDDEN', 'Seu perfil não pode consultar liberações de saída.', 403);
        const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]
          .now;
        const path = new URL(request.url).pathname.replace(/\/$/, '');
        if (request.method === 'GET' && path === '/api/exit-access/state')
          return json(await this.state(client, user, new URL(request.url).searchParams, now));
        if (request.method !== 'POST' || path !== '/api/exit-access/commands')
          exitFail('METHOD_NOT_ALLOWED', 'Operação não disponível.', 405);
        const input = body ?? {};
        fields(input, ['type', 'payload', 'idempotencyKey']);
        const type = text(input.type, 'Operação'),
          key = text(input.idempotencyKey, 'Identificador da operação', 16, 100);
        if (
          !/^[a-zA-Z0-9_-]+$/.test(key) ||
          !input.payload ||
          typeof input.payload !== 'object' ||
          Array.isArray(input.payload)
        )
          exitFail('VALIDATION', 'Dados da operação inválidos.');
        const payload = input.payload as Body;
        const hash = createHash('sha256').update(canonical({ type, payload })).digest('hex');
        const previous = (
          await client.query<{ hash: string; result: unknown }>(
            'SELECT hash,result FROM exit_commands WHERE actor_id=$1 AND key=$2',
            [user.id, key],
          )
        ).rows[0];
        // Permission is checked again before replay: a revoked leader never regains access.
        if (previous) {
          if (previous.hash !== hash)
            exitFail('IDEMPOTENCY_CONFLICT', 'O identificador foi usado para outra operação.', 409);
          await this.replayPermission(client, user, type, payload);
          return json({ result: previous.result, replayed: true });
        }
        const result = await this.command(client, user, type, payload, now);
        await client.query(
          'INSERT INTO exit_commands(actor_id,key,hash,result) VALUES($1,$2,$3,$4)',
          [user.id, key, hash, JSON.stringify(result)],
        );
        return json({ result });
      });
    } catch (error) {
      if (error instanceof ExitAccessError)
        return json({ error: { code: error.code, message: error.message } }, error.status);
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        return json(
          {
            error: {
              code: 'CONFLICT',
              message:
                'Já existe um registro vigente ou uma alteração concorrente. Atualize a consulta.',
            },
          },
          409,
        );
      throw error;
    }
  }
  private async member(client: PoolClient, personId: string) {
    const row = (
      await client.query<{ body: string; sector_id: string; member_version: number } & Sector>(
        `SELECT r.body,m.sector_id,m.version AS member_version,s.id,s.name,s.active,s.leader_id,s.substitute_id,s.version FROM exit_members m JOIN exit_sectors s ON s.id=m.sector_id JOIN operational_records r ON r.collection='people' AND r.id=m.person_id WHERE m.person_id=$1 FOR UPDATE OF m,s,r`,
        [personId],
      )
    ).rows[0];
    if (!row)
      exitFail(
        'SECTOR_REQUIRED',
        'Vincule o funcionário a um setor antes de liberar a saída.',
        409,
      );
    return { ...row, person: JSON.parse(row.body) as ExitPerson };
  }
  private async replayPermission(client: PoolClient, user: ExitUser, type: string, payload: Body) {
    if (type === 'GRANT' || type === 'REVOKE') {
      const personId =
        type === 'GRANT'
          ? text(payload.personId, 'Funcionário')
          : (
              await client.query<{ person_id: string }>(
                'SELECT person_id FROM exit_permits WHERE id=$1',
                [text(payload.id, 'Liberação')],
              )
            ).rows[0]?.person_id;
      if (!personId) exitFail('NOT_FOUND', 'Liberação não encontrada.', 404);
      requireSector(user, await this.member(client, personId));
    } else if (!exitPermissions(user).manage)
      exitFail('FORBIDDEN', 'Somente o administrador pode configurar os setores.', 403);
  }
  private async command(
    client: PoolClient,
    user: ExitUser,
    type: string,
    payload: Body,
    now: Date,
  ): Promise<unknown> {
    const admin = exitPermissions(user).manage;
    if (!['GRANT', 'REVOKE'].includes(type) && !admin)
      exitFail('FORBIDDEN', 'Somente o administrador pode configurar setores e vínculos.', 403);
    if (type === 'SET_LEADERS') {
      fields(payload, ['sectorId', 'leaderId', 'substituteId', 'version']);
      const sectorId = text(payload.sectorId, 'Setor'),
        leader = nullable(payload.leaderId),
        substitute = nullable(payload.substituteId);
      if (substitute && (!leader || substitute === leader))
        exitFail('VALIDATION', 'Líder e substituto devem ser pessoas diferentes.');
      for (const actorId of [leader, substitute].filter(Boolean)) {
        const selected = (
          await client.query<{ role: string; status: string }>(
            'SELECT role,status FROM operational_users WHERE id=$1',
            [actorId],
          )
        ).rows[0];
        if (
          !selected ||
          selected.status !== 'active' ||
          !['admin', 'director', 'operations'].includes(selected.role)
        )
          exitFail(
            'VALIDATION',
            'Selecione um usuário ativo de administração, diretoria ou operação.',
          );
      }
      const result = (
        await client.query(
          'UPDATE exit_sectors SET leader_id=$2,substitute_id=$3,version=version+1,updated_at=$4,updated_by=$5 WHERE id=$1 AND version=$6 RETURNING id,name,version',
          [sectorId, leader, substitute, now, user.id, payload.version],
        )
      ).rows[0];
      if (!result) exitFail('CONFLICT', 'O setor mudou. Atualize antes de salvar.', 409);
      await exitAudit(client, user, type, { leaderId: leader, substituteId: substitute }, sectorId);
      return result;
    }
    if (type === 'ASSIGN_SECTOR') {
      fields(payload, ['personId', 'sectorId', 'version']);
      const personId = text(payload.personId, 'Funcionário'),
        sectorId = text(payload.sectorId, 'Setor');
      const person = (
        await client.query<{ body: string }>(
          "SELECT body FROM operational_records WHERE collection='people' AND id=$1",
          [personId],
        )
      ).rows[0];
      if (!person || JSON.parse(person.body).category !== 'employee')
        exitFail('VALIDATION', 'Selecione um funcionário cadastrado.');
      if (
        !(await client.query('SELECT id FROM exit_sectors WHERE id=$1 AND active=TRUE', [sectorId]))
          .rowCount
      )
        exitFail('VALIDATION', 'Setor não disponível.');
      const old = (
        await client.query<{ version: number; sector_id: string }>(
          'SELECT version,sector_id FROM exit_members WHERE person_id=$1 FOR UPDATE',
          [personId],
        )
      ).rows[0];
      if ((old?.version ?? 0) !== payload.version)
        exitFail('CONFLICT', 'O vínculo do funcionário mudou. Atualize a consulta.', 409);
      await client.query(
        'INSERT INTO exit_members(person_id,sector_id,updated_by) VALUES($1,$2,$3) ON CONFLICT(person_id) DO UPDATE SET sector_id=EXCLUDED.sector_id,version=exit_members.version+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()',
        [personId, sectorId, user.id],
      );
      if (old && old.sector_id !== sectorId)
        await this.revokePerson(client, user, personId, 'Mudança de setor.', now);
      await exitAudit(
        client,
        user,
        type,
        { from: old?.sector_id ?? null, to: sectorId },
        sectorId,
        personId,
      );
      return { personId, sectorId };
    }
    if (type === 'PREPARE_CONTROL') {
      fields(payload, ['personId', 'reason']);
      const personId = text(payload.personId, 'Funcionário'),
        reason = text(payload.reason, 'Justificativa', 5, 1000),
        member = await this.member(client, personId);
      requireEmployee(member.person);
      if (this.gateway.mode === 'disabled')
        exitFail(
          'INTEGRATION_DISABLED',
          'Configure a integração antes de preparar o controle físico.',
          503,
        );
      if (member.person.directory.sourceId !== this.gateway.sourceId)
        exitFail('BINDING_CHANGED', 'O funcionário pertence a outra central.', 409);
      const binding = (
        await client.query<ExitBinding>(
          'SELECT * FROM exit_bindings WHERE person_id=$1 FOR UPDATE',
          [personId],
        )
      ).rows[0];
      if (
        binding &&
        (binding.native_user_id !== member.person.directory.nativeId ||
          binding.source_id !== member.person.directory.sourceId ||
          binding.target_hash !== this.gateway.targetHash)
      )
        exitFail(
          'BINDING_CHANGED',
          'O equipamento ou a identidade mudou. Revise o vínculo existente.',
          409,
        );
      await client.query(
        `INSERT INTO exit_bindings(person_id,source_id,native_user_id,target_hash,requested_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(person_id) DO UPDATE SET desired_control=TRUE,provisioning_status=CASE WHEN exit_bindings.manual_rule_id IS NULL THEN 'pending' ELSE 'prepared' END,last_error=NULL,requested_by=EXCLUDED.requested_by`,
        [
          personId,
          member.person.directory.sourceId,
          member.person.directory.nativeId,
          this.gateway.targetHash,
          user.id,
        ],
      );
      await exitAudit(
        client,
        user,
        type,
        { reason, hardwareWrites: 'queued' },
        member.sector_id,
        personId,
      );
      return { personId, status: 'pending' };
    }
    if (type === 'CONFIRM_CONTROL') {
      fields(payload, ['personId', 'entryNormal', 'exitPending', 'offlineDenied', 'reason']);
      const personId = text(payload.personId, 'Funcionário'),
        reason = text(payload.reason, 'Evidência da homologação', 5, 1000),
        member = await this.member(client, personId);
      requireEmployee(member.person);
      if (
        payload.entryNormal !== true ||
        payload.exitPending !== true ||
        payload.offlineDenied !== true
      )
        exitFail(
          'VALIDATION',
          'Confirme os testes de entrada, saída pendente e recusa sem conexão.',
        );
      const binding = (
        await client.query<ExitBinding>(
          'SELECT * FROM exit_bindings WHERE person_id=$1 FOR UPDATE',
          [personId],
        )
      ).rows[0];
      if (
        !binding ||
        binding.provisioning_status !== 'prepared' ||
        !binding.desired_control ||
        binding.source_id !== member.person.directory.sourceId ||
        binding.native_user_id !== member.person.directory.nativeId ||
        binding.target_hash !== this.gateway.targetHash
      )
        exitFail('BINDING_NOT_READY', 'A configuração física ainda não foi confirmada.', 409);
      await this.gateway.verifyBinding(binding);
      await client.query(
        'UPDATE exit_bindings SET enabled=TRUE,verified_at=$2,verified_by=$3,evidence=$4 WHERE person_id=$1',
        [personId, now, user.id, reason],
      );
      await exitAudit(
        client,
        user,
        type,
        {
          reason,
          entryNormal: true,
          exitPending: true,
          offlineDenied: true,
          confirmation: 'manual',
        },
        member.sector_id,
        personId,
      );
      return { personId, status: 'enabled' };
    }
    if (type === 'REMOVE_CONTROL') {
      fields(payload, ['personId', 'reason']);
      const personId = text(payload.personId, 'Funcionário'),
        reason = text(payload.reason, 'Justificativa', 5, 1000),
        member = await this.member(client, personId);
      await this.revokePerson(
        client,
        user,
        personId,
        'Controle de saída desativado: ' + reason,
        now,
      );
      await client.query(
        "UPDATE exit_bindings SET enabled=FALSE,desired_control=FALSE,provisioning_status='removing',requested_by=$2,requested_at=clock_timestamp() WHERE person_id=$1",
        [personId, user.id],
      );
      await exitAudit(client, user, type, { reason }, member.sector_id, personId);
      return { personId, status: 'removing' };
    }
    if (type === 'GRANT') {
      fields(payload, ['personId', 'sectorId', 'reason']);
      const personId = text(payload.personId, 'Funcionário'),
        reason = text(payload.reason, 'Justificativa', 5, 1000),
        member = await this.member(client, personId);
      requireSector(user, member);
      requireEmployee(member.person);
      if (payload.sectorId !== member.sector_id)
        exitFail('SECTOR_CHANGED', 'O funcionário mudou de setor. Atualize a consulta.', 409);
      const binding = (
        await client.query<ExitBinding>(
          'SELECT * FROM exit_bindings WHERE person_id=$1 FOR UPDATE',
          [personId],
        )
      ).rows[0];
      if (
        this.gateway.mode === 'disabled' ||
        !binding?.enabled ||
        !binding.desired_control ||
        binding.provisioning_status !== 'prepared' ||
        binding.target_hash !== this.gateway.targetHash ||
        binding.source_id !== this.gateway.sourceId ||
        binding.source_id !== member.person.directory.sourceId ||
        binding.native_user_id !== member.person.directory.nativeId
      )
        exitFail(
          'CONTROL_NOT_READY',
          'O controle de saída deste funcionário ainda não foi homologado.',
          409,
        );
      await client.query(
        "UPDATE exit_permits SET status='expired' WHERE person_id=$1 AND expires_at<=$2 AND status IN ('pending','active','applied')",
        [personId, now],
      );
      if (
        (
          await client.query(
            "SELECT id FROM exit_permits WHERE person_id=$1 AND expires_at>$2 AND status IN ('pending','active','applied')",
            [personId, now],
          )
        ).rowCount
      )
        exitFail('ALREADY_GRANTED', 'Já existe uma liberação vigente para este funcionário.', 409);
      const permit = (
        await client.query(
          `INSERT INTO exit_permits(id,person_id,sector_id,issued_by,issued_by_name,reason,issued_at,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '15 minutes','pending') RETURNING *`,
          [id('xp'), personId, member.sector_id, user.id, user.name, reason, now],
        )
      ).rows[0];
      await exitAudit(
        client,
        user,
        type,
        { reason, expiresAt: permit.expires_at, durationSeconds: 900 },
        member.sector_id,
        personId,
        permit.id,
      );
      return permit;
    }
    if (type === 'REVOKE') {
      fields(payload, ['id', 'reason']);
      const permitId = text(payload.id, 'Liberação'),
        reason = text(payload.reason, 'Justificativa', 5, 1000);
      const permit = (
        await client.query<{ person_id: string; sector_id: string; revoked_at: Date | null }>(
          'SELECT person_id,sector_id,revoked_at FROM exit_permits WHERE id=$1 FOR UPDATE',
          [permitId],
        )
      ).rows[0];
      if (!permit) exitFail('NOT_FOUND', 'Liberação não encontrada.', 404);
      const member = await this.member(client, permit.person_id);
      requireSector(user, member);
      if (!admin && permit.sector_id !== member.sector_id)
        exitFail('FORBIDDEN', 'A liberação pertence ao setor anterior.', 403);
      if (!permit.revoked_at) {
        await client.query(
          "UPDATE exit_permits SET status='revoked',revoked_at=$2,revoked_by=$3,revoke_reason=$4 WHERE id=$1",
          [permitId, now, user.id, reason],
        );
        await exitAudit(
          client,
          user,
          type,
          { reason },
          permit.sector_id,
          permit.person_id,
          permitId,
        );
      }
      return { id: permitId, status: 'revoked' };
    }
    exitFail('UNKNOWN_COMMAND', 'Operação não reconhecida.');
  }
  private async revokePerson(
    client: PoolClient,
    user: ExitUser,
    personId: string,
    reason: string,
    now: Date,
  ) {
    const permits = (
      await client.query<{ id: string; sector_id: string }>(
        "UPDATE exit_permits SET status='revoked',revoked_at=$2,revoked_by=$3,revoke_reason=$4 WHERE person_id=$1 AND status IN ('pending','active','applied') RETURNING id,sector_id",
        [personId, now, user.id, reason],
      )
    ).rows;
    for (const permit of permits)
      await exitAudit(client, user, 'REVOKE', { reason }, permit.sector_id, personId, permit.id);
  }
  private async state(client: PoolClient, user: ExitUser, query: URLSearchParams, now: Date) {
    const permissions = exitPermissions(user),
      scope = permissions.all ? 'TRUE' : '(s.leader_id=$1 OR s.substitute_id=$1)',
      args = permissions.all ? [] : [user.id];
    const sectors = (
      await client.query(`SELECT s.* FROM exit_sectors s WHERE ${scope} ORDER BY s.name`, args)
    ).rows;
    const q = (query.get('q') ?? '').trim().slice(0, 150),
      page = Number(query.get('page') ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      exitFail('VALIDATION', 'Página inválida.');
    const baseArgs: unknown[] = [...args, q],
      searchIndex = baseArgs.length,
      personScope = permissions.manage ? 'TRUE' : scope;
    const where = `r.collection='people' AND r.body::jsonb->>'category'='employee' AND (${personScope}) AND ($${searchIndex}='' OR strpos(lower(COALESCE(r.body::jsonb->>'name','')||' '||COALESCE(r.body::jsonb->>'company','')),lower($${searchIndex}))>0)`;
    const from =
      'FROM operational_records r LEFT JOIN exit_members m ON m.person_id=r.id LEFT JOIN exit_sectors s ON s.id=m.sector_id LEFT JOIN exit_bindings b ON b.person_id=r.id';
    const total = Number(
      (await client.query(`SELECT count(*) AS n ${from} WHERE ${where}`, baseArgs)).rows[0].n,
    );
    const people = (
      await client.query(
        `SELECT r.id,r.body::jsonb->>'name' AS name,r.body::jsonb->>'company' AS company,r.body::jsonb->>'securityStatus' AS security_status,r.body::jsonb->>'active' AS active,m.sector_id,COALESCE(m.version,0) AS member_version,b.enabled AS control_enabled,b.provisioning_status,b.last_error AS binding_error FROM ${from.slice(5)} WHERE ${where} ORDER BY lower(r.body::jsonb->>'name'),r.id LIMIT 50 OFFSET $${baseArgs.length + 1}`,
        [...baseArgs, (page - 1) * 50],
      )
    ).rows;
    const permits = (
      await client.query(
        `SELECT p.*,r.body::jsonb->>'name' AS person_name,s.name AS sector_name,CASE WHEN p.revoked_at IS NOT NULL THEN 'revoked' WHEN p.expires_at<=$${args.length + 1} THEN 'expired' ELSE p.status END AS effective_status,EXISTS(SELECT 1 FROM exit_dispatches d WHERE d.permit_id=p.id AND d.status IN ('dispatching','uncertain')) AS confirmation_pending FROM exit_permits p JOIN exit_sectors s ON s.id=p.sector_id JOIN operational_records r ON r.collection='people' AND r.id=p.person_id WHERE ${scope} ORDER BY p.issued_at DESC,p.id LIMIT 100`,
        [...args, now],
      )
    ).rows;
    const events = permissions.approve
      ? (
          await client.query(
            `SELECT e.* FROM exit_events e LEFT JOIN exit_sectors s ON s.id=e.sector_id WHERE ${permissions.manage ? 'TRUE' : scope} ORDER BY e.at DESC,e.id LIMIT 100`,
            args,
          )
        ).rows
      : [];
    const users = permissions.manage
      ? (
          await client.query(
            "SELECT id,name,role FROM operational_users WHERE status='active' AND role IN ('admin','director','operations') ORDER BY name,id",
          )
        ).rows
      : [];
    const worker = (
      await client.query(
        'SELECT mode,status,heartbeat_at,last_success_at,error_code,target_hash FROM exit_worker_state WHERE id=1',
      )
    ).rows[0];
    return {
      permissions,
      sectors,
      people,
      permits,
      events,
      users,
      page,
      total,
      totalPages: Math.max(1, Math.ceil(total / 50)),
      serverNow: now,
      integration: {
        mode: this.gateway.mode,
        configured: this.gateway.mode !== 'disabled',
        errorCode: this.gateway.configurationError ?? null,
        worker: worker ?? null,
        healthy: Boolean(
          this.gateway.mode !== 'disabled' &&
          worker &&
          worker.mode === this.gateway.mode &&
          worker.target_hash === this.gateway.targetHash &&
          now.getTime() >= new Date(worker.heartbeat_at).getTime() &&
          now.getTime() - new Date(worker.heartbeat_at).getTime() < 15000 &&
          worker.last_success_at &&
          now.getTime() - new Date(worker.last_success_at).getTime() < 15000 &&
          ['ready', 'checking'].includes(worker.status),
        ),
        authorizationIsPassage: false,
      },
    };
  }
}
