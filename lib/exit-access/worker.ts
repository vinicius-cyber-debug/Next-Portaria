import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PostgresDatabase } from '../persistence/postgres.ts';
import { effectiveCapabilities } from '../access.mjs';
import type {
  ExitBinding,
  ExitGateway,
  ExitPerson,
  ExitUser,
  PendingExit,
  Permit,
  Sector,
} from './types.ts';
import { requireEmployee, requireSector, ExitAccessError } from './policy.mjs';
import { exitAudit } from './service.ts';
import { IntegrationError } from '../integrations/contracts.ts';

const workerActor = { name: 'Serviço de liberação de saída' };
function failureCode(error: unknown) {
  return error instanceof IntegrationError
    ? error.kind
    : error instanceof ExitAccessError
      ? error.code
      : 'unavailable';
}
export class ExitAccessWorker {
  readonly db: PostgresDatabase;
  readonly gateway: ExitGateway;
  readonly generation = randomUUID();
  #running = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;
  #loop: Promise<void> | undefined;
  constructor(db: PostgresDatabase, gateway: ExitGateway) {
    this.db = db;
    this.gateway = gateway;
  }
  private async actor(client: PoolClient, id: string): Promise<ExitUser> {
    const actor = (
      await client.query<ExitUser & { body: string | null; must_change_password: number }>(
        `SELECT u.*,a.body,c.must_change_password FROM operational_users u LEFT JOIN operational_access a ON a.user_id=u.id LEFT JOIN operational_credentials c ON c.user_id=u.id WHERE u.id=$1`,
        [id],
      )
    ).rows[0];
    if (!actor || actor.status !== 'active' || actor.must_change_password !== 0)
      throw new ExitAccessError('ACCESS_REVOKED', 'Responsável indisponível.', 403);
    return {
      ...actor,
      capabilities: effectiveCapabilities(actor, actor.body ? JSON.parse(actor.body) : {}),
    };
  }
  private async now(client: PoolClient) {
    return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  }
  private async heartbeat(status: string, errorCode: string | null = null) {
    await this.db.pool.query(
      `INSERT INTO exit_worker_state(id,generation,mode,status,heartbeat_at,last_success_at,error_code,target_hash) VALUES(1,$1,$2,$3,clock_timestamp(),CASE WHEN $3='ready' THEN clock_timestamp() END,$4,$5) ON CONFLICT(id) DO UPDATE SET generation=EXCLUDED.generation,mode=EXCLUDED.mode,status=EXCLUDED.status,heartbeat_at=EXCLUDED.heartbeat_at,last_success_at=COALESCE(EXCLUDED.last_success_at,exit_worker_state.last_success_at),error_code=EXCLUDED.error_code,target_hash=EXCLUDED.target_hash`,
      [this.generation, this.gateway.mode, status, errorCode, this.gateway.targetHash],
    );
  }
  private async recover() {
    await this.db.transaction(async (client) => {
      await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
      const orphaned = (
        await client.query<{
          event_id: string;
          permit_id: string;
          person_id: string;
          sector_id: string;
        }>(
          "UPDATE exit_dispatches d SET status='uncertain' FROM exit_permits p WHERE d.permit_id=p.id AND d.status='dispatching' RETURNING d.event_id,d.permit_id,d.person_id,p.sector_id",
        )
      ).rows;
      for (const dispatch of orphaned)
        await exitAudit(
          client,
          workerActor,
          'DISPATCH_UNCERTAIN',
          {
            eventId: dispatch.event_id,
            reason: 'Reinício após início do envio; não reenviar automaticamente.',
          },
          dispatch.sector_id,
          dispatch.person_id,
          dispatch.permit_id,
        );
    });
  }
  private async expire() {
    await this.db.transaction(async (client) => {
      await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
      const expired = (
        await client.query<{ id: string; sector_id: string; person_id: string }>(
          "UPDATE exit_permits SET status='expired' WHERE expires_at<=clock_timestamp() AND status IN ('pending','active','applied','error') AND revoked_at IS NULL RETURNING id,sector_id,person_id",
        )
      ).rows;
      for (const permit of expired)
        await exitAudit(
          client,
          workerActor,
          'EXPIRED',
          { reason: 'Prazo de 15 minutos encerrado; não há regra semanal de liberação.' },
          permit.sector_id,
          permit.person_id,
          permit.id,
        );
    });
  }
  private async provisioning() {
    const candidate = (
      await this.db.pool.query<{ person_id: string }>(
        "SELECT person_id FROM exit_bindings WHERE provisioning_status IN ('pending','removing','error') AND (provisioning_status<>'error' OR requested_at<clock_timestamp()-interval '10 seconds') ORDER BY requested_at,person_id LIMIT 1",
      )
    ).rows[0];
    if (!candidate) return;
    try {
      await this.db.transaction(async (client) => {
        await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
        const binding = (
          await client.query<ExitBinding>(
            'SELECT * FROM exit_bindings WHERE person_id=$1 FOR UPDATE',
            [candidate.person_id],
          )
        ).rows[0];
        if (!binding || binding.target_hash !== this.gateway.targetHash) return;
        const actor = await this.actor(client, binding.requested_by);
        if (actor.role !== 'admin')
          throw new ExitAccessError('ACCESS_REVOKED', 'Administrador indisponível.', 403);
        const member = (
          await client.query<{ body: string; sector_id: string }>(
            "SELECT r.body,m.sector_id FROM exit_members m JOIN operational_records r ON r.collection='people' AND r.id=m.person_id WHERE m.person_id=$1",
            [binding.person_id],
          )
        ).rows[0];
        if (!member) throw new ExitAccessError('BINDING_CHANGED', 'Vínculo indisponível.', 409);
        const person = JSON.parse(member.body) as ExitPerson;
        if (
          person.directory?.sourceId !== binding.source_id ||
          person.directory?.nativeId !== binding.native_user_id
        )
          throw new ExitAccessError('BINDING_CHANGED', 'Identidade alterada.', 409);
        if (binding.desired_control) {
          requireEmployee(person);
          const ruleId = await this.gateway.provision(binding);
          await client.query(
            "UPDATE exit_bindings SET manual_rule_id=$2,provisioning_status='prepared',last_error=NULL WHERE person_id=$1",
            [binding.person_id, ruleId],
          );
          await exitAudit(
            client,
            workerActor,
            'CONTROL_PREPARED',
            { manualRuleId: ruleId, requiresManualHomologation: true },
            member.sector_id,
            binding.person_id,
          );
        } else {
          await this.gateway.remove(binding);
          await client.query(
            "UPDATE exit_bindings SET manual_rule_id=NULL,provisioning_status='removed',enabled=FALSE,last_error=NULL WHERE person_id=$1",
            [binding.person_id],
          );
          await exitAudit(
            client,
            workerActor,
            'CONTROL_REMOVED',
            {},
            member.sector_id,
            binding.person_id,
          );
        }
      });
    } catch (error) {
      await this.db.pool.query(
        "UPDATE exit_bindings SET provisioning_status='error',last_error=$2,requested_at=clock_timestamp() WHERE person_id=$1",
        [candidate.person_id, failureCode(error)],
      );
    }
  }
  private async eligible(client: PoolClient, event: PendingExit) {
    try {
      return await this.eligiblePerson(client, event);
    } catch (error) {
      if (error instanceof ExitAccessError) return null;
      throw error;
    }
  }
  private async eligiblePerson(client: PoolClient, event: PendingExit) {
    const binding = (
      await client.query<ExitBinding>(
        'SELECT * FROM exit_bindings WHERE source_id=$1 AND native_user_id=$2 FOR UPDATE',
        [this.gateway.sourceId, event.nativeUserId],
      )
    ).rows[0];
    if (
      !binding?.enabled ||
      !binding.desired_control ||
      binding.provisioning_status !== 'prepared' ||
      binding.target_hash !== this.gateway.targetHash
    )
      return null;
    const permit = (
      await client.query<Permit>(
        "SELECT * FROM exit_permits WHERE person_id=$1 AND revoked_at IS NULL AND status IN ('pending','active','applied') AND expires_at>clock_timestamp()+interval '5 seconds' ORDER BY issued_at DESC LIMIT 1 FOR UPDATE",
        [binding.person_id],
      )
    ).rows[0];
    if (!permit) return null;
    const joined = (
      await client.query<Sector & { sector_id: string; body: string }>(
        "SELECT s.*,m.sector_id,r.body FROM exit_members m JOIN exit_sectors s ON s.id=m.sector_id JOIN operational_records r ON r.collection='people' AND r.id=m.person_id WHERE m.person_id=$1",
        [binding.person_id],
      )
    ).rows[0];
    if (!joined || joined.sector_id !== permit.sector_id) return null;
    const person = JSON.parse(joined.body) as ExitPerson;
    requireEmployee(person);
    if (
      person.directory.sourceId !== binding.source_id ||
      person.directory.nativeId !== binding.native_user_id
    )
      return null;
    requireSector(await this.actor(client, permit.issued_by), joined);
    const now = await this.now(client),
      age = now.getTime() - Date.parse(event.occurredAt);
    if (
      age < 0 ||
      age > 10000 ||
      Date.parse(event.occurredAt) < permit.issued_at.getTime() ||
      event.deviceId !== this.gateway.deviceId ||
      event.state !== 'pending'
    )
      return null;
    return { binding, permit, person, now };
  }
  private async attempt(event: PendingExit) {
    // Commit the claim BEFORE the network. A crash can cause a missed attempt, never a replayed opening.
    const claim = await this.db.transaction(async (client) => {
      await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
      const candidate = await this.eligible(client, event);
      if (!candidate) return null;
      const inserted = await client.query(
        "INSERT INTO exit_dispatches(source_id,event_id,permit_id,person_id,device_id,status,started_at) VALUES($1,$2,$3,$4,$5,'dispatching',$6) ON CONFLICT DO NOTHING",
        [
          this.gateway.sourceId,
          event.eventId,
          candidate.permit.id,
          candidate.binding.person_id,
          this.gateway.deviceId,
          candidate.now,
        ],
      );
      return inserted.rowCount ? candidate.permit.id : null;
    });
    if (!claim) return;
    let sent = false;
    try {
      await this.db.transaction(async (client) => {
        await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
        const candidate = await this.eligible(client, event);
        if (!candidate || candidate.permit.id !== claim)
          throw new ExitAccessError('AUTHORIZATION_EXPIRED', 'Liberação não vigente.', 409);
        await this.gateway.verifyBinding(candidate.binding);
        const now = await this.now(client);
        if (now.getTime() + 5000 >= candidate.permit.expires_at.getTime())
          throw new ExitAccessError('AUTHORIZATION_EXPIRED', 'Liberação encerrada.', 409);
        sent = true;
        await this.gateway.authorize(event, candidate.permit.expires_at.toISOString());
        const confirmed = await this.gateway.confirm(event);
        await client.query(
          "UPDATE exit_dispatches SET status=$3,confirmed_at=CASE WHEN $3='confirmed' THEN clock_timestamp() END WHERE source_id=$1 AND event_id=$2",
          [this.gateway.sourceId, event.eventId, confirmed ? 'confirmed' : 'uncertain'],
        );
        await client.query(
          "UPDATE exit_permits SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' WHEN $2=TRUE THEN 'applied' ELSE 'active' END,last_applied_at=CASE WHEN $2 THEN clock_timestamp() ELSE last_applied_at END,last_error=CASE WHEN $2 THEN NULL ELSE 'confirmation_pending' END WHERE id=$1 AND revoked_at IS NULL",
          [claim, confirmed],
        );
        await exitAudit(
          client,
          workerActor,
          confirmed ? 'DEVICE_AUTHORIZED' : 'DISPATCH_UNCERTAIN',
          { eventId: event.eventId, deviceId: event.deviceId, passageConfirmed: false },
          candidate.permit.sector_id,
          candidate.person.id,
          claim,
        );
      });
    } catch (error) {
      await this.db.transaction(async (client) => {
        await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
        await client.query(
          'UPDATE exit_dispatches SET status=$3 WHERE source_id=$1 AND event_id=$2',
          [this.gateway.sourceId, event.eventId, sent ? 'uncertain' : 'rejected'],
        );
        const permit = (
          await client.query<{ sector_id: string; person_id: string }>(
            'SELECT sector_id,person_id FROM exit_permits WHERE id=$1',
            [claim],
          )
        ).rows[0];
        await exitAudit(
          client,
          workerActor,
          sent ? 'DISPATCH_UNCERTAIN' : 'DISPATCH_REJECTED',
          { eventId: event.eventId, code: failureCode(error), neverAutoRetry: true },
          permit.sector_id,
          permit.person_id,
          claim,
        );
      });
    }
  }
  async tick() {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.expire();
      if (this.gateway.mode === 'disabled') {
        await this.heartbeat('disabled');
        return;
      }
      await this.heartbeat('checking');
      await this.gateway.inspect();
      await this.provisioning();
      const events = await this.gateway.readEvents();
      for (const event of events) if (event.state === 'pending') await this.attempt(event);
      // Read-back only for ambiguous requests; never resend the command.
      for (const event of events)
        if (event.state === 'authorized' && event.deviceId === this.gateway.deviceId)
          await this.db.transaction(async (client) => {
            await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
            const confirmed = (
              await client.query<{ permit_id: string; person_id: string; sector_id: string }>(
                `UPDATE exit_dispatches d SET status='confirmed',confirmed_at=clock_timestamp()
               FROM exit_bindings b,exit_permits p WHERE d.source_id=$1 AND d.event_id=$2 AND d.device_id=$3 AND d.status='uncertain'
               AND b.person_id=d.person_id AND b.source_id=d.source_id AND b.native_user_id=$4 AND b.target_hash=$5 AND p.id=d.permit_id
               RETURNING d.permit_id,d.person_id,p.sector_id`,
                [
                  this.gateway.sourceId,
                  event.eventId,
                  event.deviceId,
                  event.nativeUserId,
                  this.gateway.targetHash,
                ],
              )
            ).rows[0];
            if (!confirmed) return;
            await client.query(
              'UPDATE exit_permits SET last_applied_at=clock_timestamp(),last_error=NULL WHERE id=$1',
              [confirmed.permit_id],
            );
            await exitAudit(
              client,
              workerActor,
              'CONFIRMATION_RECEIVED',
              { eventId: event.eventId, passageConfirmed: false },
              confirmed.sector_id,
              confirmed.person_id,
              confirmed.permit_id,
            );
          });
      await this.heartbeat('ready');
    } catch (error) {
      await this.heartbeat('unavailable', failureCode(error));
    } finally {
      this.#running = false;
    }
  }
  async start() {
    if (this.#loop) throw Error('O serviço de saída já está iniciado.');
    if (this.gateway.mode === 'disabled') return async () => {};
    const present = await this.db
      .prepare("SELECT to_regclass('public.exit_worker_state') AS present")
      .first<{ present: string | null }>();
    if (!present?.present) return async () => {};
    const lock = await this.db.pool.connect();
    const acquired = (
      await lock.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('next-portaria-exit-worker')) AS locked",
      )
    ).rows[0].locked;
    if (!acquired) {
      lock.release();
      return async () => {};
    }
    lock.on('error', () => {
      this.#stopped = true;
      this.#wake?.();
    });
    await this.recover();
    this.#stopped = false;
    this.#loop = (async () => {
      try {
        while (!this.#stopped) {
          await this.tick();
          if (!this.#stopped)
            await new Promise<void>((resolve) => {
              this.#timer = setTimeout(resolve, 1000);
              this.#wake = resolve;
            });
        }
      } finally {
        await this.heartbeat('stopped').catch(() => {});
        await lock
          .query("SELECT pg_advisory_unlock(hashtext('next-portaria-exit-worker'))")
          .catch(() => {});
        lock.release();
      }
    })();
    return () => this.stop();
  }
  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#wake?.();
    await this.#loop;
    this.#loop = undefined;
  }
}
