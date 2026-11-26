'use client';

import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Truck,
  Users,
} from 'lucide-react';
import { capability } from './operations-panels';
import {
  initials,
  localDate,
  Metric,
  Page,
  PortState,
  Role,
  Row,
  Status,
  User,
} from './portal-shared';
import type { OperationAlert } from './portal-types';
import { TurnstileMonitor } from './turnstile-monitor';

export function Dashboard({
  user,
  state,
  inside,
  vehiclesInside,
  pending,
  alerts,
  role,
  navigate,
  open,
  tz,
}: {
  user: User | null;
  state: PortState;
  inside: Row[];
  vehiclesInside: Row[];
  pending: Row[];
  alerts: OperationAlert[];
  role: Role;
  navigate: (p: Page) => void;
  open: (kind: string, row?: Partial<Row>, action?: string) => void;
  tz: string;
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - 6 + i);
      const day = localDate(date.toISOString(), tz).slice(0, 10),
        entries =
          state.visitors.filter(
            (r) => r.enteredAt && localDate(r.enteredAt, tz).slice(0, 10) === day,
          ).length +
          state.vehicles.filter((r) => r.entryAt && localDate(r.entryAt, tz).slice(0, 10) === day)
            .length,
        exits =
          state.visitors.filter((r) => r.leftAt && localDate(r.leftAt, tz).slice(0, 10) === day)
            .length +
          state.vehicles.filter((r) => r.exitAt && localDate(r.exitAt, tz).slice(0, 10) === day)
            .length;
      return {
        day,
        label: new Intl.DateTimeFormat('pt-BR', {
          weekday: 'short',
          timeZone: tz,
        })
          .format(date)
          .replace('.', ''),
        entries,
        exits,
      };
    }),
    totalMovement = days.reduce((sum, day) => sum + day.entries + day.exits, 0),
    max = Math.max(4, ...days.flatMap((d) => [d.entries, d.exits]));
  return (
    <div className="dashboard-layout">
      {role === 'admin' &&
        (!state.settings.unitName || state.settings.unitName === 'Minha unidade portuária') && (
          <div className="dashboard-setup">
            <Building2 size={17} aria-hidden="true" />
            <span>Defina o nome da unidade, as portarias e os horários.</span>
            <button type="button" className="section-link" onClick={() => navigate('settings')}>
              Configurar unidade
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      <div className="kpi-grid">
        <Metric
          title="Pessoas no local"
          value={inside.length}
          detail="Presenças em aberto"
          icon={Users}
        />
        <Metric
          title="Veículos na unidade"
          value={vehiclesInside.length}
          detail="Entradas sem saída registrada"
          icon={Truck}
        />
        <Metric
          title="Aguardando aprovação"
          value={pending.length}
          detail="Solicitações em análise"
          icon={Clock3}
        />
        <Metric
          title="Ocorrências abertas"
          value={state.incidents.filter((r) => r.status !== 'resolved').length}
          detail="Registros por resolver"
          icon={FileText}
        />
      </div>
      <TurnstileMonitor enabled={capability(user, 'documentView')} tz={tz} />
      <div className="grid-two">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Aguardando autorização</h2>
            <button className="section-link" onClick={() => navigate('visitors')}>
              Ver visitantes
              <ArrowUpRight size={16} />
            </button>
          </div>
          {pending.length ? (
            <div className="detail-list">
              {pending.slice(0, 4).map((r) => (
                <button
                  className="detail-row"
                  key={r.id}
                  onClick={() => open('detail', r, 'visitors')}
                >
                  <span className="initials">{initials(r.name)}</span>
                  <span className="grow">
                    <strong>{r.name}</strong>
                    <small>
                      {r.purpose} · {r.host}
                    </small>
                  </span>
                  <Status
                    value={r.status}
                    facePending={r.initialAccessScope === 'gate_only' && r.status === 'authorized'}
                  />
                </button>
              ))}
            </div>
          ) : (
            <p className="compact-empty">Nenhuma solicitação pendente.</p>
          )}
        </div>
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Acesso rápido</h2>
          </div>
          <div className="quick-actions">
            {[
              {
                page: 'visitors' as Page,
                label: 'Visitantes e autorizações',
                icon: Users,
              },
              {
                page: 'vehicles' as Page,
                label: 'Movimentação de veículos',
                icon: Truck,
              },
              {
                page: 'reports' as Page,
                label: 'Relatórios da operação',
                icon: ChartNoAxesCombined,
              },
            ].map((a) => (
              <button key={a.page} type="button" onClick={() => navigate(a.page)}>
                <span className="quick-icon">
                  <a.icon size={17} aria-hidden="true" />
                </span>
                <span>
                  <strong>{a.label}</strong>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid-main">
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Movimento da portaria</h2>
              <p className="card-subtitle">Entradas e saídas de pessoas e veículos</p>
            </div>
            <span className="chip">Últimos 7 dias</span>
          </div>
          {totalMovement ? (
            <div className="chart-body">
              <div className="chart-legend">
                <span>
                  <i className="chart-key-entry" />
                  Entradas
                </span>
                <span>
                  <i className="chart-key-exit" />
                  Saídas
                </span>
              </div>
              <div className="chart-wrap">
                <div className="chart-axis">
                  {[
                    max,
                    Math.round(max * 0.75),
                    Math.round(max * 0.5),
                    Math.round(max * 0.25),
                    0,
                  ].map((n, i) => (
                    <span key={i}>{n}</span>
                  ))}
                </div>
                <div className="chart-bars">
                  {days.map((d, i) => (
                    <div className="chart-column" key={d.day}>
                      <div
                        className="chart-bar-group"
                        title={`${d.label}: ${d.entries} entradas e ${d.exits} saídas`}
                      >
                        <span
                          className="chart-bar"
                          style={{
                            height: `${Math.max(d.entries ? 3 : 0, (d.entries / max) * 100)}%`,
                          }}
                        />
                        <span
                          className="chart-bar secondary"
                          style={{
                            height: `${Math.max(d.exits ? 3 : 0, (d.exits / max) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className={`chart-label ${i === 6 ? 'today' : ''}`}>{d.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="chart-summary">
                <strong>{totalMovement}</strong>
                movimentações no período
              </div>
            </div>
          ) : (
            <p className="compact-empty">Nenhuma movimentação registrada nos últimos 7 dias.</p>
          )}
        </div>
        <div className="card" id="operation-alerts">
          <div className="card-header">
            <h2 className="card-title">Alertas</h2>
            {alerts.length > 0 && (
              <span className="dashboard-alert-count">{alerts.length} em aberto</span>
            )}
          </div>
          {alerts.length ? (
            <div className="alert-list">
              {alerts.slice(0, 6).map((a, i) => (
                <button
                  key={i}
                  className={`alert-item ${a.high ? 'severity-high' : ''}`}
                  onClick={() => navigate(a.page)}
                >
                  <span className="alert-icon">
                    <CircleAlert size={18} />
                  </span>
                  <span className="alert-content">
                    <strong>{a.title}</strong>
                    <small>{a.text}</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <p className="compact-empty">Nenhum alerta em aberto.</p>
          )}
        </div>
      </div>
    </div>
  );
}
