'use client';

import { Clock3, Eye, LogIn, LogOut, MoreHorizontal, ShieldCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { canDecide } from './access-support';
import { allowed } from './operations-panels';
import { dt, initials, match, Status, Table, Toolbar } from './portal-shared';
import type { Row, User } from './portal-shared';
import { Button } from './ui';

const visitorMetrics = [
  { status: 'inside', label: 'No local', icon: Users },
  { status: 'pending', label: 'Aguardando aprovação', icon: Clock3 },
  { status: 'authorized', label: 'Autorizados', icon: ShieldCheck },
];

const visitorStatuses = [
  'pending',
  'authorized',
  'inside',
  'unconfirmed',
  'temporarily_out',
  'unconfirmed_closed',
  'completed',
  'denied',
  'revoked',
  'cancelled',
];

type VisitorActionsProps = {
  user: User | null;
  disabled: boolean;
  open: (kind: string, row?: Partial<Row>, action?: string) => void;
};

function VisitorActions({ row, user, disabled, open }: VisitorActionsProps & { row: Row }) {
  const enter = row.status === 'authorized' && allowed(user, 'VISITOR_CHECKIN');
  const exit = row.status === 'inside' && allowed(user, 'VISITOR_CHECKOUT');
  const approve = row.status === 'pending' && canDecide(user, row);
  const reject = row.status === 'pending' && canDecide(user, row, 'VISITOR_REJECT');
  const revoke = row.status === 'authorized' && canDecide(user, row, 'VISITOR_REVOKE');
  const cancel = row.status === 'pending' && allowed(user, 'VISITOR_CANCEL');
  const MovementIcon = enter ? LogIn : LogOut;

  return (
    <div className="row-actions visitor-actions">
      {(enter || exit) && (
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => open('confirm', row, enter ? 'VISITOR_CHECKIN' : 'VISITOR_CHECKOUT')}
        >
          <MovementIcon size={16} aria-hidden="true" />
          {enter ? 'Registrar entrada' : 'Registrar saída'}
        </Button>
      )}
      {approve && (
        <Button disabled={disabled} onClick={() => open('confirm', row, 'VISITOR_APPROVE')}>
          Autorizar
        </Button>
      )}
      <Button aria-label="Detalhes do visitante" onClick={() => open('detail', row, 'visitors')}>
        <Eye size={16} aria-hidden="true" />
        Detalhes
      </Button>
      {(reject || revoke || cancel) && (
        <details className="visitor-options">
          <summary>
            <MoreHorizontal size={16} aria-hidden="true" />
            Mais opções
          </summary>
          <div className="visitor-option-buttons">
            {reject && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => open('reason', row, 'VISITOR_REJECT')}
              >
                Recusar solicitação
              </Button>
            )}
            {revoke && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => open('reason', row, 'VISITOR_REVOKE')}
              >
                Revogar autorização
              </Button>
            )}
            {cancel && (
              <Button
                variant="danger"
                disabled={disabled}
                onClick={() => open('reason', row, 'VISITOR_CANCEL')}
              >
                Cancelar solicitação
              </Button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export function VisitorsPanel({
  visitors,
  revision,
  tz,
  ...actions
}: VisitorActionsProps & { visitors: Row[]; revision: number; tz: string }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');

  return (
    <>
      <div
        className="stat-strip visitor-summary"
        role="group"
        aria-label="Filtrar visitantes por situação"
      >
        {visitorMetrics.map(({ status: value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            className="stat-item"
            aria-pressed={status === value}
            aria-controls="visitor-results"
            onClick={() => setStatus((current) => (current === value ? 'all' : value))}
          >
            <Icon size={19} aria-hidden="true" />
            <span>
              {label}
              <strong>{visitors.filter((row) => row.status === value).length}</strong>
            </span>
          </button>
        ))}
      </div>
      <div className="card visitor-results" id="visitor-results">
        <Toolbar
          query={query}
          onQuery={setQuery}
          status={status}
          onStatus={setStatus}
          options={visitorStatuses}
          placeholder="Nome, empresa ou final do documento"
        />
        <Table
          stackOnNarrow
          label="Lista de visitantes"
          server={{ collection: 'visitors', q: query, status, revision }}
          rows={visitors.filter(
            (row) => match(row, query) && (status === 'all' || row.status === status),
          )}
          emptyTitle="Nenhum visitante encontrado"
          emptyText={
            query || status !== 'all'
              ? 'Tente outro nome ou ajuste o filtro de situação.'
              : 'Use Nova solicitação para registrar uma visita.'
          }
          columns={[
            {
              title: 'Visitante',
              render: (row) => (
                <div className="avatar-cell">
                  <span className="initials">{initials(row.name)}</span>
                  <div className="cell-primary">
                    {row.name}
                    <span className="cell-subtle">
                      {row.company || 'Sem empresa'}
                      {row.documentLast4 ? ` · doc. final ${row.documentLast4}` : ''}
                    </span>
                  </div>
                </div>
              ),
            },
            {
              title: 'Motivo / responsável',
              render: (row) => (
                <div>
                  <span className="visitor-compact-label" aria-hidden="true">
                    Motivo / responsável
                  </span>
                  {row.purpose || '—'}
                  <span className="cell-subtle">{row.host}</span>
                </div>
              ),
            },
            {
              title: 'Previsão / validade',
              render: (row) => (
                <div>
                  <span className="visitor-compact-label" aria-hidden="true">
                    Previsão / validade
                  </span>
                  {dt(row.expectedAt, tz, true)}
                  <span className="cell-subtle">Até {dt(row.validUntil, tz, true)}</span>
                </div>
              ),
            },
            {
              title: 'Situação',
              render: (row) => (
                <Status
                  value={row.status}
                  facePending={
                    row.initialAccessScope === 'gate_only' && row.status === 'authorized'
                  }
                />
              ),
            },
            {
              title: 'Ações',
              render: (row) => <VisitorActions row={row} {...actions} />,
            },
          ]}
        />
      </div>
    </>
  );
}
