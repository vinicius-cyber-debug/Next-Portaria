'use client';

import { canWithCapabilities as allowed, capability } from '../lib/access.mjs';
import type { SessionUser } from '../lib/operational-types';
import type { PortalRecord, PortalResponse, PortalState } from './portal-types';

export { canDecide } from '../lib/access.mjs';

import { Check, Clock3, LockKeyhole, LogOut, Plus, ShieldCheck } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { request as fetch } from '../lib/http-client';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy.mjs';

type Row = PortalRecord;

export { usePagedRecords } from './use-paged-records';

export function useApprovers() {
  const [users, setUsers] = useState<SessionUser[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/approvers', { cache: 'no-store', signal: abort.signal })
      .then(async (response) => {
        const data = (await response.json()) as PortalResponse;
        if (!response.ok)
          throw new Error(data.error?.message || 'Não foi possível consultar os responsáveis.');
        setUsers(data.users || []);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, []);
  return { users, error };
}
export function PasswordPanel({
  forced = false,
  onDone,
  onLogout,
}: {
  forced?: boolean;
  onDone: (data: PortalResponse) => void;
  onLogout: () => void;
}) {
  const [currentPassword, setCurrent] = useState(''),
    [newPassword, setNew] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmation) {
      setError('A confirmação deve ser igual à nova senha.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        }),
        data = (await response.json()) as PortalResponse;
      if (!response.ok)
        throw new Error(data.error?.message || 'Não foi possível alterar sua senha.');
      setCurrent('');
      setNew('');
      setConfirmation('');
      onDone(data);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível alterar sua senha.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card password-panel" onSubmit={submit}>
      <div className="card-header">
        <div>
          <h2 className="card-title">{forced ? 'Defina sua senha pessoal' : 'Minha senha'}</h2>
          <p className="card-subtitle">
            {forced
              ? 'Troque a senha inicial para começar a usar o sistema.'
              : `Use uma senha pessoal de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres.`}
          </p>
        </div>
        <LockKeyhole size={24} />
      </div>
      <div className="card-body">
        <div className="notice info">
          <ShieldCheck size={20} />
          <span>
            {forced
              ? 'Essa troca é obrigatória após a criação ou redefinição do acesso.'
              : 'A alteração encerra as outras sessões da sua conta.'}
          </span>
        </div>
        <div className="login-fields">
          <label className="field-label" htmlFor="password-current">
            Senha atual
          </label>
          <input
            id="password-current"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            maxLength={PASSWORD_MAX_LENGTH}
            value={currentPassword}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <label className="field-label" htmlFor="password-new">
            Nova senha
          </label>
          <input
            id="password-new"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={newPassword}
            onChange={(event) => setNew(event.target.value)}
          />
          <label className="field-label" htmlFor="password-confirm">
            Confirme a nova senha
          </label>
          <input
            id="password-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="settings-form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onLogout}>
            <LogOut size={17} />
            Sair do sistema
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            <Check size={17} />
            {busy ? 'Alterando…' : 'Salvar nova senha'}
          </button>
        </div>
      </div>
    </form>
  );
}

function date(value: string | null | undefined | undefined, tz: string) {
  return value
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: tz,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'Sem validade';
}
function local(value: string | null | undefined | undefined, tz: string) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(value ? new Date(value) : new Date())
    .replace(' ', 'T');
}
function iso(value: string, tz: string) {
  if (!value) return null;
  const desired = new Date(value + ':00Z'),
    zoned = new Date(local(desired.toISOString(), tz) + ':00Z');
  return new Date(+desired + (+desired - +zoned)).toISOString();
}
export function requirementStatus(row: Row) {
  return row.status === 'revoked'
    ? 'Revogado'
    : row.status !== 'approved'
      ? 'Pendente'
      : !row.validUntil || Date.parse(row.validUntil) <= Date.now()
        ? 'Vencido'
        : Date.parse(row.validUntil) - Date.now() <= 30 * 86400000
          ? 'Vence em até 30 dias'
          : 'Válido';
}
export function RequirementsPanel({
  state,
  user,
  disabled,
  tz,
  command,
  personId: fixedPerson,
}: {
  state: PortalState;
  user: SessionUser;
  disabled: boolean;
  tz: string;
  command: (type: string, payload: Record<string, unknown>) => Promise<boolean>;
  personId?: string;
}) {
  const [personId, setPerson] = useState(fixedPerson || ''),
    [filter, setFilter] = useState(fixedPerson ? 'all' : 'attention'),
    [form, setForm] = useState<{
      id?: string;
      name: string;
      status: string;
      personId: string;
      validUntil: string;
      areaIds: string[];
      notes: string;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requirements: Row[] = state.personRequirements || [],
    areas: Row[] = state.accessAreas || [],
    people: Row[] = state.people || [],
    canSave = allowed(user, 'PERSON_REQUIREMENT_SAVE') && capability(user, 'accessManage');
  const rows = requirements.filter(
    (row) =>
      (!personId || row.personId === personId) &&
      (filter === 'all' || requirementStatus(row) !== 'Válido'),
  );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      if (
        await command('PERSON_REQUIREMENT_SAVE', {
          ...form,
          validUntil: iso(form.validUntil, tz),
        })
      )
        setForm(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Não foi possível salvar o requisito.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={'card requirements-panel ' + (fixedPerson ? 'embedded' : '')}>
      <div className="card-header">
        <div>
          <h3 className="card-title">Requisitos de segurança e validade</h3>
          <p className="card-subtitle">
            Pendências, revogações e vencimentos impedem novas autorizações e entradas.
          </p>
        </div>
        {canSave && (
          <button
            className="button secondary"
            type="button"
            disabled={disabled}
            onClick={() => {
              setError('');
              setForm({
                personId: personId || '',
                name: '',
                status: 'pending',
                validUntil: '',
                areaIds: [],
                notes: '',
              });
            }}
          >
            <Plus size={17} />
            Novo requisito
          </button>
        )}
      </div>
      <div className="card-body">
        {!fixedPerson && (
          <div className="grid-two">
            <label className="form-field">
              <span className="field-label">Pessoa</span>
              <select
                className="select"
                value={personId}
                onChange={(event) => setPerson(event.target.value)}
              >
                <option value="">Todas as pessoas</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span className="field-label">Situação</span>
              <select
                className="select"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="attention">Pendências e vencimentos próximos</option>
                <option value="all">Todos os requisitos</option>
              </select>
            </label>
          </div>
        )}
        <div className="requirement-list">
          {rows.map((row) => {
            const status = requirementStatus(row),
              attention = status !== 'Válido';
            return (
              <article
                className={'requirement-item ' + (attention ? 'attention' : '')}
                key={row.id}
              >
                <div>
                  <strong>{row.name}</strong>
                  {!fixedPerson && (
                    <small>
                      {people.find((person) => person.id === row.personId)?.name ||
                        'Pessoa cadastrada'}
                    </small>
                  )}
                  <small>
                    {row.areaIds?.length
                      ? row.areaIds
                          .map(
                            (id: string) =>
                              areas.find((area) => area.id === id)?.name || 'Setor desativado',
                          )
                          .join(', ')
                      : 'Todos os setores'}
                  </small>
                  <small>
                    <Clock3 size={13} />
                    Validade: {date(row.validUntil, tz)}
                  </small>
                  <small>
                    Conferido por {row.reviewedBy || 'Conferência pendente'}
                    {row.reviewedAt ? ' · ' + date(row.reviewedAt, tz) : ''}
                  </small>
                  {row.notes && !state.documentRestricted && <p>{row.notes}</p>}
                </div>
                <div className="requirement-actions">
                  <span className={'status status-' + (attention ? 'pending' : 'active')}>
                    {status}
                  </span>
                  {canSave && (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setError('');
                        setForm({
                          ...row,
                          personId: row.personId ?? '',
                          notes: row.notes ?? '',
                          validUntil: row.validUntil ? local(row.validUntil, tz) : '',
                          areaIds: row.areaIds || [],
                        });
                      }}
                    >
                      Conferir / editar
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!rows.length && (
            <p className="field-hint">
              {fixedPerson
                ? 'Nenhum requisito específico cadastrado. A conferência geral de segurança continua válida.'
                : 'Nenhum requisito neste filtro.'}
            </p>
          )}
        </div>
        {form && (
          <form className="requirement-form" onSubmit={save}>
            <h4>{form.id ? 'Conferir requisito' : 'Cadastrar requisito'}</h4>
            <div className="form-grid">
              {!fixedPerson && (
                <label className="form-field">
                  <span className="field-label">Pessoa *</span>
                  <select
                    className="select"
                    required
                    value={form.personId}
                    onChange={(event) => setForm({ ...form, personId: event.target.value })}
                  >
                    <option value="">Selecione a pessoa</option>
                    {people
                      .filter((person) => person.active !== false || person.id === form.personId)
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="form-field">
                <span className="field-label">Requisito *</span>
                <input
                  className="input"
                  required
                  maxLength={160}
                  placeholder="Ex.: integração de segurança"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span className="field-label">Resultado da conferência *</span>
                <select
                  className="select"
                  required
                  value={form.status}
                  onChange={(event) => setForm({ ...form, status: event.target.value })}
                >
                  <option value="pending">Pendente</option>
                  <option value="approved">Aprovado</option>
                  <option value="revoked">Revogado</option>
                </select>
              </label>
              <label className="form-field">
                <span className="field-label">
                  Validade{form.status === 'approved' ? ' *' : ''}
                </span>
                <input
                  className="input"
                  type="datetime-local"
                  required={form.status === 'approved'}
                  value={form.validUntil}
                  onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
                />
              </label>
              <label className="form-field full">
                <span className="field-label">Observações da conferência</span>
                <textarea
                  className="textarea"
                  rows={2}
                  maxLength={2000}
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                />
              </label>
            </div>
            <fieldset className="requirement-areas">
              <legend className="field-label">
                Aplicável aos setores selecionados (nenhum = todos)
              </legend>
              <div className="access-person-checks">
                {areas.map((area) => (
                  <label key={area.id}>
                    <input
                      type="checkbox"
                      checked={form.areaIds.includes(area.id)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          areaIds: event.target.checked
                            ? [...form.areaIds, area.id]
                            : form.areaIds.filter((id: string) => id !== area.id),
                        })
                      }
                    />
                    <span>{area.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="field-hint">
              O usuário e o horário da conferência são registrados pelo servidor. Horário local:{' '}
              {tz}.
            </p>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                Cancelar
              </button>
              <button className="button primary" type="submit" disabled={disabled || busy}>
                <Check size={17} />
                {busy ? 'Salvando…' : 'Salvar conferência'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
