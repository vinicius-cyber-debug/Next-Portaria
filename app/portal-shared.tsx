'use client';

import type { PortalRecord, PortalState } from './portal-types';
import type { Role, SessionUser } from '../lib/operational-types';

export type { Role } from '../lib/operational-types';

export { canMaintainMaster as canMaster } from '../lib/access-policy.mjs';

import {
  Anchor,
  Bell,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Contact,
  FileText,
  LayoutDashboard,
  LockKeyhole,
  LogIn,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  Users,
  X,
} from 'lucide-react';
import React, { useState } from 'react';
import { clientRequestId } from '../lib/client-id';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy.mjs';
import { usePagedRecords } from './access-support';
import {
  Button,
  DataTable,
  EmptyState,
  FormField,
  LoadingState,
  ModalFrame,
  SearchField,
  StatCard,
  StatusBadge,
} from './ui';

export type Row = PortalRecord;

export type Page =
  | 'porto'
  | 'password'
  | 'dashboard'
  | 'quickgate'
  | 'incidents'
  | 'notifications'
  | 'visitors'
  | 'vehicles'
  | 'masters'
  | 'reports'
  | 'audit'
  | 'settings';

export type User = SessionUser;

export type PortState = PortalState;

export type Dialog = {
  kind: string;
  row?: Partial<Row>;
  action?: string;
  masterKind?: string;
};

export type FieldDef = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  list?: string;
  min?: string;
  max?: string;
  step?: string;
  full?: boolean;
};

export const roleNames: Record<Role, string> = {
  admin: 'Administrador',
  director: 'Diretoria',
  gate: 'Portaria',
  operations: 'Operação',
  finance: 'Perfil histórico',
  reader: 'Consulta',
};

export const statusNames: Record<string, string> = {
  pending: 'Pendente',
  authorized: 'Autorizado',
  inside: 'No local',
  completed: 'Finalizado',
  denied: 'Recusado',
  revoked: 'Revogado',
  cancelled: 'Cancelado',
  unconfirmed: 'Saída não confirmada',
  unconfirmed_closed: 'Reconciliado · saída desconhecida',
  temporarily_out: 'Saída produtiva',
  active: 'Ativo',
  disabled: 'Desativado',
  paid: 'Pago',
  partial: 'Parcial',
};

export const names: Record<Page, { title: string; sub: string; icon: typeof Anchor }> = {
  porto: {
    title: 'Gestão do Porto',
    sub: 'Solicitações de descida e permanência de veículos no porto.',
    icon: Anchor,
  },
  password: {
    title: 'Minha senha',
    sub: 'Altere a senha pessoal da sua conta.',
    icon: LockKeyhole,
  },
  quickgate: {
    title: 'Central de Acesso',
    sub: 'Pessoas, autorizações e presença física na instalação.',
    icon: LogIn,
  },
  incidents: {
    title: 'Ocorrências e turnos',
    sub: 'Incidentes, evidências e continuidade entre equipes.',
    icon: FileText,
  },
  notifications: {
    title: 'Notificações',
    sub: 'Pendências e vencimentos para sua equipe.',
    icon: Bell,
  },
  dashboard: {
    title: 'Visão geral',
    sub: 'Pendências, movimentações e informações da central de acesso.',
    icon: LayoutDashboard,
  },
  visitors: {
    title: 'Visitantes',
    sub: 'Da pré-autorização à saída, cada acesso acompanhado.',
    icon: Users,
  },
  vehicles: {
    title: 'Veículos',
    sub: 'Entradas, saídas e permanência na unidade.',
    icon: Truck,
  },
  masters: {
    title: 'Cadastros',
    sub: 'Informações organizadas para agilizar sua rotina.',
    icon: Contact,
  },
  reports: {
    title: 'Relatórios',
    sub: 'Consulte, filtre e exporte os dados da operação.',
    icon: ChartNoAxesCombined,
  },
  audit: {
    title: 'Auditoria',
    sub: 'Rastreabilidade das ações e alterações do sistema.',
    icon: ShieldCheck,
  },
  settings: {
    title: 'Administração',
    sub: 'Configure sua unidade, acessos e operação.',
    icon: Settings,
  },
};

export function dt(v?: string | null, tz = 'America/Manaus', short = false) {
  if (!v || Number.isNaN(+new Date(v))) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    ...(short ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(v));
}

export function localDate(v?: string, tz = 'America/Manaus') {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(v ? new Date(v) : new Date())
    .replace(' ', 'T');
}

export function asIso(v: string, tz: string) {
  if (!v) return '';
  const desired = new Date(`${v}:00Z`),
    zoned = new Date(localDate(desired.toISOString(), tz) + ':00Z');
  return new Date(+desired + (+desired - +zoned)).toISOString();
}

export function duration(start?: string | null, end?: string | null) {
  if (!start) return '—';
  const ms = Math.max(0, +(end ? new Date(end) : new Date()) - +new Date(start)),
    h = Math.floor(ms / 3600000);
  return h >= 24
    ? `${Math.floor(h / 24)}d ${h % 24}h`
    : `${h}h ${Math.floor((ms % 3600000) / 60000)}min`;
}

export function initials(s = '') {
  return (
    s
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join('')
      .toUpperCase() || 'NP'
  );
}

export function normalize(v: unknown) {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function match(r: Row, q: string) {
  return (
    !q ||
    normalize(
      Object.values(r)
        .filter((v) => typeof v !== 'object')
        .join(' '),
    ).includes(normalize(q))
  );
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function attemptKey(pending: Map<string, string>, signature: string) {
  const existing = pending.get(signature);
  if (existing) return existing;
  const key = clientRequestId();
  pending.set(signature, key);
  return key;
}

export function actionLabel(t: string) {
  const labels: Record<string, string> = {
    VISITOR_GATE_REGISTER: 'Autorização inicial na portaria',
    VISITOR_GATE_REVOKE: 'Liberação inicial cancelada',
    PERSON_REQUIREMENT_SAVE: 'Requisito de segurança conferido',
    ACCESS_AREA_SAVE: 'Setor de acesso alterado',
    PASSWORD_CHANGE: 'Troca de senha',
    VISITOR_REQUEST: 'Solicitação de visita',
    VISITOR_APPROVE: 'Acesso autorizado',
    VISITOR_REJECT: 'Solicitação recusada',
    VISITOR_REVOKE: 'Autorização revogada',
    VISITOR_CANCEL: 'Solicitação cancelada',
    VISITOR_CHECKIN: 'Entrada de visitante',
    VISITOR_CHECKOUT: 'Saída de visitante',
    VEHICLE_ENTER: 'Entrada de veículo',
    VEHICLE_EXIT: 'Saída de veículo',
    STAY_OPEN: 'Abertura de atracação',
    STAY_CLOSE: 'Encerramento de atracação',
    SETTINGS_UPDATE: 'Configuração alterada',
    CHARGE_PAYMENT: 'Recebimento registrado',
    CHARGE_CANCEL: 'Cobrança cancelada',
    PAYMENT_REVERSE: 'Recebimento estornado',
    MASTER_SAVE: 'Cadastro atualizado',
    RECORD_CORRECT: 'Registro corrigido',
    BERTH_ADD: 'Berço cadastrado',
    BERTH_REMOVE: 'Berço removido',
    BACKUP_RESTORE: 'Backup restaurado',
  };
  return labels[t] || t.replaceAll('_', ' ');
}

export function Status({ value, facePending = false }: { value: string; facePending?: boolean }) {
  return (
    <>
      <StatusBadge value={value}>{statusNames[value] || value}</StatusBadge>
      {facePending && <small className="cell-subtle">Face: envio pendente</small>}
    </>
  );
}

export function Empty({
  title = 'Nenhum registro encontrado',
  text = 'Os registros da sua operação aparecerão aqui.',
  icon: Icon = FileText,
}: {
  title?: string;
  text?: string;
  icon?: typeof Anchor;
}) {
  return <EmptyState title={title} text={text} icon={Icon} />;
}

export function Action({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger = false,
}: {
  icon: typeof Anchor;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${danger ? 'danger' : ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} />
    </button>
  );
}

export function Field({
  field: f,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: string) => void;
}) {
  const props = {
    id: 'field-' + f.name,
    name: f.name,
    required: f.required,
    disabled: f.disabled,
    value: String(value ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(f.name, e.target.value),
  };
  return (
    <FormField
      full={f.full}
      label={
        <>
          {f.label}
          {f.required && <span aria-hidden="true"> *</span>}
        </>
      }
      hint={f.hint}
    >
      {f.type === 'select' ? (
        <select className="select" {...props}>
          {f.options?.map((o) => (
            <option value={o.value} key={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.type === 'textarea' ? (
        <textarea className="textarea" rows={3} {...props} />
      ) : (
        <input
          className="input"
          type={f.type || 'text'}
          minLength={f.type === 'password' ? PASSWORD_MIN_LENGTH : undefined}
          maxLength={f.type === 'password' ? PASSWORD_MAX_LENGTH : undefined}
          list={f.list}
          min={f.min}
          max={f.max}
          step={f.step}
          {...props}
        />
      )}
    </FormField>
  );
}

export function Table<T extends { id: string } = Row>({
  rows,
  columns,
  emptyTitle,
  emptyText,
  server,
}: {
  rows: T[];
  columns: { title: string; render: (r: T) => React.ReactNode }[];
  emptyTitle?: string;
  emptyText?: string;
  server?: {
    collection: string;
    q?: string;
    status?: string;
    revision?: number;
    params?: Record<string, unknown>;
  };
}) {
  const scope = JSON.stringify([server?.collection, server?.q, server?.status, server?.params]);
  const [pagination, setPagination] = useState({ scope, page: 0 });
  const page = pagination.scope === scope ? pagination.page : 0;
  const setPage = (next: number) => setPagination({ scope, page: next });
  const remote = usePagedRecords<T>(
      server?.collection || '',
      { q: server?.q, status: server?.status, ...server?.params },
      page + 1,
      12,
      server?.revision || 0,
    ),
    total = server ? Number(remote.total || 0) : rows.length,
    count = Math.max(1, server ? Number(remote.totalPages || 1) : Math.ceil(total / 12)),
    active = Math.min(page, count - 1),
    visible: T[] = server ? remote.rows || [] : rows.slice(active * 12, active * 12 + 12);

  return (
    <>
      {server && remote.error && (
        <div className="notice error record-load-error" role="alert">
          {remote.error}
          <Button onClick={remote.retry}>Tentar novamente</Button>
        </div>
      )}
      <DataTable busy={!!(server && remote.loading)}>
        {server && remote.loading && !visible.length ? (
          <LoadingState />
        ) : !visible.length && !remote.error ? (
          <Empty title={emptyTitle} text={emptyText} />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i}>{c.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.id || i}>
                  {columns.map((c, j) => (
                    <td key={j}>{c.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DataTable>
      {!!total && (
        <div className="pagination">
          <span>
            {active * 12 + 1}–{Math.min((active + 1) * 12, total)} de {total} registros
            {server && remote.loading ? ' · atualizando…' : ''}
          </span>
          <div className="actions">
            <button
              className="icon-button"
              disabled={!active || (server && remote.loading)}
              onClick={() => setPage(active - 1)}
              aria-label="Página anterior"
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {active + 1} / {count}
            </span>
            <button
              className="icon-button"
              disabled={active + 1 >= count || (server && remote.loading)}
              onClick={() => setPage(active + 1)}
              aria-label="Próxima página"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <ModalFrame title={title} onClose={onClose} wide={wide}>
      {children}
    </ModalFrame>
  );
}

export function Toolbar({
  query,
  onQuery,
  status,
  onStatus,
  options = [],
  placeholder = 'Buscar…',
}: {
  query: string;
  onQuery: (s: string) => void;
  status?: string;
  onStatus?: (s: string) => void;
  options?: string[];
  placeholder?: string;
}) {
  return (
    <div className="toolbar">
      <SearchField label={placeholder}>
        <Search size={17} />
        <input
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {query && (
          <button aria-label="Limpar filtro" onClick={() => onQuery('')}>
            <X size={14} />
          </button>
        )}
      </SearchField>
      {onStatus && (
        <div className="filter-group">
          <select
            className="select"
            aria-label="Filtrar por situação"
            value={status}
            onChange={(e) => onStatus(e.target.value)}
          >
            <option value="all">Todas as situações</option>
            {options.map((s) => (
              <option key={s} value={s}>
                {statusNames[s] || s}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export function Metric({
  title,
  value,
  detail,
  icon: Icon,
  color = 'blue',
}: {
  title: string;
  value: React.ReactNode;
  detail: string;
  icon: typeof Anchor;
  color?: string;
}) {
  return <StatCard title={title} value={value} detail={detail} icon={Icon} tone={color} />;
}
