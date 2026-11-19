'use client';
import { useEffect, useMemo, useState } from 'react';
import { Clock3, ShieldCheck, Users } from 'lucide-react';
import type { SessionUser } from '../lib/operational-types';
import { request } from '../lib/http-client';
import { clientRequestId } from '../lib/client-id';
import { useClock } from './use-clock';
import { exitPermissions } from '../lib/exit-access/policy.mjs';
import { Button, EmptyState, FormField, ModalFrame, LoadingState } from './ui';

type Sector = {
  id: string;
  name: string;
  active: boolean;
  leader_id: string | null;
  substitute_id: string | null;
  version: number;
};
type Person = {
  id: string;
  name: string;
  company: string | null;
  sector_id: string | null;
  member_version: number;
  security_status: string | null;
  active: string | null;
  control_enabled: boolean | null;
  provisioning_status: string | null;
  binding_error: string | null;
};
type Permit = {
  id: string;
  person_id: string;
  person_name: string;
  sector_name: string;
  issued_by_name: string;
  reason: string;
  issued_at: string;
  expires_at: string;
  effective_status: string;
  confirmation_pending: boolean;
  last_applied_at: string | null;
};
type ExitState = {
  permissions: { manage: boolean; approve: boolean; view: boolean };
  sectors: Sector[];
  people: Person[];
  permits: Permit[];
  events: {
    id: string;
    action: string;
    actor_name: string;
    at: string;
    person_id: string | null;
    data: Record<string, unknown>;
  }[];
  users: { id: string; name: string; role: string }[];
  page: number;
  total: number;
  totalPages: number;
  serverNow: string;
  integration: {
    mode: string;
    configured: boolean;
    errorCode?: string | null;
    healthy: boolean;
    worker: { status: string; error_code: string | null } | null;
  };
};
type ApiResult = { error?: { message?: string; code?: string } };
type Dialog = {
  type:
    'GRANT' | 'REVOKE' | 'ASSIGN_SECTOR' | 'PREPARE_CONTROL' | 'CONFIRM_CONTROL' | 'REMOVE_CONTROL';
  person?: Person;
  permit?: Permit;
  key: string;
};
const labels: Record<string, string> = {
  pending: 'Vigente · aguardando identificação',
  active: 'Vigente · aguardando identificação',
  applied: 'Autorização atendida',
  expired: 'Expirada',
  revoked: 'Revogada',
  error: 'Verificação necessária',
};
const actions: Record<string, string> = {
  GRANT: 'Liberação concedida',
  REVOKE: 'Liberação revogada',
  EXPIRED: 'Prazo encerrado',
  DEVICE_AUTHORIZED: 'Autorização confirmada pela central',
  DISPATCH_UNCERTAIN: 'Confirmação da central pendente',
  DISPATCH_REJECTED: 'Tentativa não autorizada',
  ASSIGN_SECTOR: 'Setor atualizado',
  SET_LEADERS: 'Responsáveis atualizados',
  CONTROL_PREPARED: 'Controle preparado para homologação',
  CONFIRM_CONTROL: 'Homologação confirmada',
  PREPARE_CONTROL: 'Preparo do controle solicitado',
  REMOVE_CONTROL: 'Remoção do controle solicitada',
  CONTROL_REMOVED: 'Controle físico removido',
  CONFIRMATION_RECEIVED: 'Confirmação da central recebida',
};
const date = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Manaus',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
function useExitState(q: string, page: number, revision: number) {
  const key = JSON.stringify([q, page, revision]);
  const [result, setResult] = useState<{
    key: string;
    data: ExitState | null;
    error: string;
    receivedAt: number;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await request(
            '/api/exit-access/state?' + new URLSearchParams({ q, page: String(page) }),
            { cache: 'no-store', signal: abort.signal },
          ),
          data = (await response.json()) as ExitState & ApiResult;
        if (!response.ok) throw Error(data.error?.message || 'Consulta indisponível.');
        if (!abort.signal.aborted) setResult({ key, data, error: '', receivedAt: Date.now() });
      } catch (error) {
        if (!abort.signal.aborted)
          setResult((previous) => ({
            key,
            data: previous?.key === key ? previous.data : null,
            error: error instanceof Error ? error.message : 'Consulta indisponível.',
            receivedAt: previous?.receivedAt ?? Date.now(),
          }));
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void load(), 3000);
      }
    }
    timer = setTimeout(() => void load(), 0);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [q, page, key]);
  return result?.key === key ? result : null;
}
export function ExitAccessPanel({
  user,
  administration = false,
  disabled = false,
}: {
  user: SessionUser;
  administration?: boolean;
  disabled?: boolean;
}) {
  const [q, setQ] = useState(''),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [reason, setReason] = useState(''),
    [sectorId, setSectorId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const result = useExitState(q, page, revision),
    data = result?.data,
    clock = useClock(1000);
  const now = data && result ? Date.parse(data.serverNow) + (clock - result.receivedAt) : clock;
  const [leaderSector, setLeaderSector] = useState(''),
    [leader, setLeader] = useState(''),
    [substitute, setSubstitute] = useState('');
  const [checks, setChecks] = useState({
    entryNormal: false,
    exitPending: false,
    offlineDenied: false,
  });
  const active = new Map(
    (data?.permits ?? [])
      .filter(
        (permit) =>
          !['revoked', 'expired'].includes(permit.effective_status) &&
          Date.parse(permit.expires_at) > now,
      )
      .map((permit) => [permit.person_id, permit]),
  );
  const sectorNames = useMemo(
    () => new Map((data?.sectors ?? []).map((sector) => [sector.id, sector.name])),
    [data?.sectors],
  );
  const refresh = () => setRevision((value) => value + 1);
  function open(type: Dialog['type'], person?: Person, permit?: Permit) {
    setDialog({ type, person, permit, key: clientRequestId() });
    setReason('');
    setSectorId(person?.sector_id ?? '');
    setError('');
    setChecks({ entryNormal: false, exitPending: false, offlineDenied: false });
  }
  async function send(type: string, payload: Record<string, unknown>, key: string) {
    const response = await request('/api/exit-access/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, payload, idempotencyKey: key }),
      }),
      value = (await response.json()) as ApiResult;
    if (!response.ok) throw Error(value.error?.message || 'Não foi possível salvar.');
    return value;
  }
  async function submit() {
    if (!dialog) return;
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> =
        dialog.type === 'REVOKE'
          ? { id: dialog.permit?.id, reason }
          : dialog.type === 'ASSIGN_SECTOR'
            ? { personId: dialog.person?.id, sectorId, version: dialog.person?.member_version }
            : dialog.type === 'GRANT'
              ? { personId: dialog.person?.id, sectorId: dialog.person?.sector_id, reason }
              : dialog.type === 'CONFIRM_CONTROL'
                ? { personId: dialog.person?.id, ...checks, reason }
                : { personId: dialog.person?.id, reason };
      await send(dialog.type, payload, dialog.key);
      setDialog(null);
      setNotice(
        dialog.type === 'GRANT'
          ? 'Liberação registrada por 15 minutos. O funcionário deve fazer uma nova identificação na saída.'
          : dialog.type === 'ASSIGN_SECTOR'
            ? 'Setor atualizado. As permissões físicas não foram alteradas.'
            : 'Solicitação registrada. Confira o estado atualizado abaixo.',
      );
      refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }
  async function saveLeaders() {
    const sector = data?.sectors.find((item) => item.id === leaderSector);
    if (!sector) return;
    setBusy(true);
    setError('');
    try {
      await send(
        'SET_LEADERS',
        {
          sectorId: sector.id,
          leaderId: leader || null,
          substituteId: substitute || null,
          version: sector.version,
        },
        clientRequestId(),
      );
      setNotice('Líder e substituto atualizados. Nenhuma permissão física foi alterada.');
      refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }
  const titles = {
    GRANT: 'Liberar saída por 15 minutos',
    REVOKE: 'Revogar liberação',
    ASSIGN_SECTOR: 'Vincular funcionário ao setor',
    PREPARE_CONTROL: 'Preparar controle de saída',
    CONFIRM_CONTROL: 'Confirmar homologação do controle',
    REMOVE_CONTROL: 'Remover controle de saída',
  };
  if (!exitPermissions(user).view) return null;
  return (
    <section className="exit-access-panel">
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              {administration ? <Users size={19} /> : <ShieldCheck size={19} />}{' '}
              {administration ? 'Setores e líderes' : 'Liberações de saída'}
            </h2>
            <p className="card-subtitle">
              {administration
                ? 'Organize a equipe e os responsáveis. O vínculo ao setor não ativa bloqueios.'
                : 'O líder ou substituto autoriza individualmente a saída da portaria por 15 minutos.'}
            </p>
          </div>
          <Button disabled={busy} onClick={refresh}>
            Atualizar
          </Button>
        </div>
        <div className="card-body">
          {notice && (
            <div className="notice success" role="status">
              {notice}
            </div>
          )}
          {(result?.error || (error && !dialog)) && (
            <div className="notice error" role="alert">
              {result?.error || error}
            </div>
          )}
          {!result && <LoadingState />}
          {data && (
            <>
              <div
                className={'notice ' + (data.integration.healthy ? 'success' : 'warning')}
                role="status"
              >
                {data.integration.errorCode
                  ? 'Integração de saída desativada por configuração inválida. Revise a configuração e o certificado no servidor.'
                  : !data.integration.configured
                    ? 'Integração física não configurada. É possível organizar setores e responsáveis sem alterar as catracas.'
                    : data.integration.healthy
                      ? 'Serviço de saída conectado. As liberações exigem identificação do funcionário.'
                      : 'Serviço de saída indisponível ou em verificação. Uma solicitação pendente não significa acesso liberado.'}
                {data.integration.mode === 'simulation' &&
                  ' Ambiente de teste: nenhum equipamento real é acionado.'}
              </div>
              {administration && data.permissions.manage && (
                <form
                  className="form-grid exit-sector-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveLeaders();
                  }}
                >
                  <FormField label="Setor da equipe">
                    <select
                      className="select"
                      value={leaderSector}
                      required
                      onChange={(event) => {
                        setLeaderSector(event.target.value);
                        const sector = data.sectors.find((item) => item.id === event.target.value);
                        setLeader(sector?.leader_id ?? '');
                        setSubstitute(sector?.substitute_id ?? '');
                      }}
                    >
                      <option value="">Selecione um setor</option>
                      {data.sectors.map((sector) => (
                        <option key={sector.id} value={sector.id}>
                          {sector.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Líder do setor">
                    <select
                      className="select"
                      value={leader}
                      onChange={(event) => {
                        setLeader(event.target.value);
                        if (event.target.value === substitute) setSubstitute('');
                      }}
                    >
                      <option value="">Sem líder definido</option>
                      {data.users.map((actor) => (
                        <option key={actor.id} value={actor.id}>
                          {actor.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Substituto">
                    <select
                      className="select"
                      value={substitute}
                      disabled={!leader}
                      onChange={(event) => setSubstitute(event.target.value)}
                    >
                      <option value="">Sem substituto</option>
                      {data.users
                        .filter((actor) => actor.id !== leader)
                        .map((actor) => (
                          <option key={actor.id} value={actor.id}>
                            {actor.name}
                          </option>
                        ))}
                    </select>
                  </FormField>
                  <div className="exit-form-action">
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={!leaderSector || busy || disabled}
                    >
                      Salvar responsáveis
                    </Button>
                  </div>
                </form>
              )}
              <FormField label="Buscar funcionário">
                <input
                  className="input"
                  value={q}
                  onChange={(event) => {
                    setQ(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Nome ou empresa…"
                />
              </FormField>
            </>
          )}
        </div>
        {data && (
          <>
            <div className="exit-person-list">
              {data.people.map((person) => (
                <div className="exit-person-row" key={person.id}>
                  <div className="grow">
                    <strong>{person.name}</strong>
                    <small>
                      {person.company || 'Empresa não informada'} ·{' '}
                      {person.sector_id
                        ? sectorNames.get(person.sector_id) || 'Setor vinculado'
                        : 'Sem setor vinculado'}
                    </small>
                    <small>
                      {person.control_enabled
                        ? 'Controle de saída homologado'
                        : person.provisioning_status === 'prepared'
                          ? 'Controle preparado · homologação pendente'
                          : person.provisioning_status === 'pending'
                            ? 'Preparando controle físico'
                            : person.provisioning_status === 'removing'
                              ? 'Remoção do controle pendente'
                              : person.provisioning_status === 'error'
                                ? 'Verificação da integração necessária'
                                : 'Permissões físicas atuais preservadas'}
                    </small>
                  </div>
                  <div className="row-actions">
                    {administration && data.permissions.manage && (
                      <>
                        <Button
                          disabled={busy || disabled}
                          onClick={() => open('ASSIGN_SECTOR', person)}
                        >
                          Vincular setor
                        </Button>
                        {person.sector_id &&
                          data.integration.configured &&
                          !person.provisioning_status && (
                            <Button
                              disabled={busy || disabled}
                              onClick={() => open('PREPARE_CONTROL', person)}
                            >
                              Preparar controle
                            </Button>
                          )}
                        {person.provisioning_status === 'removed' && (
                          <Button
                            disabled={busy || disabled}
                            onClick={() => open('PREPARE_CONTROL', person)}
                          >
                            Preparar controle
                          </Button>
                        )}
                        {person.provisioning_status === 'prepared' && !person.control_enabled && (
                          <Button
                            disabled={busy || disabled}
                            onClick={() => open('CONFIRM_CONTROL', person)}
                          >
                            Confirmar homologação
                          </Button>
                        )}
                        {person.provisioning_status && person.provisioning_status !== 'removed' && (
                          <Button
                            disabled={busy || disabled}
                            onClick={() => open('REMOVE_CONTROL', person)}
                          >
                            Remover controle
                          </Button>
                        )}
                      </>
                    )}
                    {!administration && data.permissions.approve && (
                      <Button
                        variant="primary"
                        disabled={
                          busy ||
                          disabled ||
                          !person.control_enabled ||
                          person.active !== 'true' ||
                          person.security_status !== 'cleared' ||
                          active.has(person.id) ||
                          !data.integration.configured
                        }
                        onClick={() => open('GRANT', person)}
                      >
                        <Clock3 size={16} /> Liberar saída por 15 minutos
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {!data.people.length && (
                <EmptyState
                  title="Nenhum funcionário encontrado"
                  text={
                    data.permissions.manage
                      ? 'Cadastre ou importe funcionários e vincule-os aos setores.'
                      : 'Somente funcionários dos seus setores são exibidos.'
                  }
                />
              )}
            </div>
            <div className="pagination">
              <span>
                {data.total} funcionário(s) · Página {data.page} de {data.totalPages}
              </span>
              <div className="actions">
                <Button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
                  Anterior
                </Button>
                <Button
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage(data.page + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
      {data && !administration && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Liberações e prazos</h2>
              <p className="card-subtitle">
                A validade começa na autorização e não é prorrogada por indisponibilidade. A entrada
                mantém suas regras.
              </p>
            </div>
          </div>
          <div className="exit-person-list">
            {data.permits.map((permit) => {
              const seconds = Math.max(0, Math.ceil((Date.parse(permit.expires_at) - now) / 1000)),
                status =
                  permit.effective_status === 'revoked'
                    ? 'revoked'
                    : seconds === 0
                      ? 'expired'
                      : permit.effective_status;
              return (
                <article className="exit-permit-row" key={permit.id}>
                  <div className="grow">
                    <strong>{permit.person_name}</strong>
                    <small>
                      {permit.sector_name} · {labels[status] || status}
                    </small>
                    <small>
                      Autorizado por {permit.issued_by_name} · {date(permit.issued_at)}
                    </small>
                    <p>{permit.reason}</p>
                    <small>
                      Válida até {date(permit.expires_at)}
                      {!['revoked', 'expired'].includes(status) &&
                        ` · ${Math.floor(seconds / 60)}min ${String(seconds % 60).padStart(2, '0')}s restantes`}
                    </small>
                    {permit.confirmation_pending && (
                      <small className="exit-confirmation-warning">
                        Há uma tentativa com confirmação pendente. Não considere uma passagem
                        confirmada.
                      </small>
                    )}
                  </div>
                  {data.permissions.approve && !['expired', 'revoked'].includes(status) && (
                    <Button
                      disabled={busy || disabled}
                      onClick={() => open('REVOKE', undefined, permit)}
                    >
                      Revogar
                    </Button>
                  )}
                </article>
              );
            })}
            {!data.permits.length && (
              <EmptyState
                title="Nenhuma liberação registrada"
                text="As autorizações deste setor aparecerão aqui com responsável e vencimento."
              />
            )}
          </div>
        </div>
      )}
      {data && data.permissions.approve && (
        <details className="card exit-history">
          <summary>Histórico de autorizações e configurações</summary>
          <div className="exit-person-list">
            {data.events.map((event) => (
              <div className="exit-event-row" key={event.id}>
                <strong>{actions[event.action] || event.action}</strong>
                <small>
                  {date(event.at)} · {event.actor_name}
                </small>
                {typeof event.data.reason === 'string' && <p>{event.data.reason}</p>}
              </div>
            ))}
            {!data.events.length && <p>Nenhuma alteração registrada.</p>}
          </div>
        </details>
      )}
      {dialog && (
        <ModalFrame
          title={titles[dialog.type]}
          onClose={() => {
            if (!busy) setDialog(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="modal-body">
              <h3>{dialog.person?.name ?? dialog.permit?.person_name}</h3>
              {dialog.type === 'GRANT' && (
                <div className="notice info">
                  Liberação individual de saída por 15 minutos, contados após salvar. O funcionário
                  deve se identificar novamente na catraca. A entrada permanece normal.
                </div>
              )}
              {dialog.type === 'ASSIGN_SECTOR' ? (
                <>
                  <FormField label="Setor do funcionário">
                    <select
                      className="select"
                      required
                      value={sectorId}
                      onChange={(event) => setSectorId(event.target.value)}
                    >
                      <option value="">Selecione</option>
                      {data?.sectors.map((sector) => (
                        <option key={sector.id} value={sector.id}>
                          {sector.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <p className="field-hint">
                    O vínculo não modifica permissões físicas. Uma mudança de setor revoga
                    liberações temporárias anteriores.
                  </p>
                </>
              ) : (
                <>
                  {dialog.type === 'PREPARE_CONTROL' && (
                    <div className="notice warning">
                      Esta é uma configuração física individual. A saída deste funcionário passará a
                      exigir autorização. Faça o preparo com operador presente e liberação manual
                      disponível. Vincular o setor, sozinho, não faz esta alteração.
                    </div>
                  )}
                  {dialog.type === 'REMOVE_CONTROL' && (
                    <div className="notice warning">
                      As liberações vigentes serão revogadas. O serviço removerá apenas a regra
                      criada por esta integração e preservará as permissões anteriores da central.
                    </div>
                  )}
                  {dialog.type === 'CONFIRM_CONTROL' && (
                    <fieldset className="exit-test-checks">
                      <legend>Resultados dos testes com operador presente</legend>
                      {(['entryNormal', 'exitPending', 'offlineDenied'] as const).map((key) => (
                        <label key={key}>
                          <input
                            type="checkbox"
                            required
                            checked={checks[key]}
                            onChange={(event) =>
                              setChecks((current) => ({ ...current, [key]: event.target.checked }))
                            }
                          />
                          {key === 'entryNormal'
                            ? 'Entrada continuou normal'
                            : key === 'exitPending'
                              ? 'Saída aguardou autorização individual'
                              : 'Sem comunicação, a saída não liberou automaticamente'}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <FormField
                    label={
                      dialog.type === 'CONFIRM_CONTROL'
                        ? 'Evidência da homologação'
                        : 'Justificativa'
                    }
                  >
                    <textarea
                      className="textarea"
                      required
                      minLength={5}
                      maxLength={1000}
                      rows={3}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </FormField>
                </>
              )}
              {error && (
                <div role="alert" className="notice error">
                  {error}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <Button type="button" disabled={busy} onClick={() => setDialog(null)}>
                Cancelar
              </Button>
              <Button variant="primary" type="submit" disabled={busy || disabled}>
                {busy
                  ? 'Salvando…'
                  : dialog.type === 'GRANT'
                    ? 'Autorizar por 15 minutos'
                    : 'Confirmar'}
              </Button>
            </div>
          </form>
        </ModalFrame>
      )}
    </section>
  );
}
