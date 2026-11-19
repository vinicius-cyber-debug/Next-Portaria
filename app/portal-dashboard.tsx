'use client';

import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Building2,
  ChartNoAxesCombined,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  ShieldCheck,
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
          <div className="notice info">
            <Building2 size={20} />
            <div>
              Configure o nome da unidade, as portarias e os horários de funcionamento.
              <button className="content-link" onClick={() => navigate('settings')}>
                Configurar unidade
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}
      <div className="kpi-grid">
        <Metric
          title="Pessoas no local"
          value={inside.length}
          detail={`${pending.length} solicitações aguardando aprovação`}
          icon={Users}
        />
        <Metric
          title="Veículos na unidade"
          value={vehiclesInside.length}
          detail="Entradas sem saída registrada"
          icon={Truck}
          color="cyan"
        />
        <Metric
          title="Aguardando aprovação"
          value={pending.length}
          detail="Solicitações para os responsáveis"
          icon={Clock3}
          color="purple"
        />
        <Metric
          title="Ocorrências abertas"
          value={state.incidents.filter((r) => r.status !== 'resolved').length}
          detail="Acompanhamento entre as equipes"
          icon={FileText}
          color="teal"
        />
      </div>
      <TurnstileMonitor enabled={capability(user, 'documentView')} tz={tz} />
      <div className="grid-two">
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Aguardando autorização</h2>
              <p className="card-subtitle">Próximos acessos à unidade</p>
            </div>
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
            <div>
              <h2 className="card-title">Acesso rápido</h2>
              <p className="card-subtitle">Sua próxima ação, a um clique</p>
            </div>
            <ArrowUpRight size={18} />
          </div>
          <div className="quick-actions">
            {[
              {
                page: 'visitors' as Page,
                label: 'Visitantes e autorizações',
                sub: 'Controle de acesso de pessoas',
                icon: Users,
              },
              {
                page: 'vehicles' as Page,
                label: 'Movimentação de veículos',
                sub: 'Entradas e saídas da unidade',
                icon: Truck,
              },
              {
                page: 'reports' as Page,
                label: 'Relatórios da operação',
                sub: 'Dados para acompanhar e decidir',
                icon: ChartNoAxesCombined,
              },
            ].map((a) => (
              <button key={a.page} onClick={() => navigate(a.page)}>
                <span className="quick-icon">
                  <a.icon size={21} />
                </span>
                <span>
                  <strong>{a.label}</strong>
                  <small>{a.sub}</small>
                </span>
                <ChevronRight size={17} />
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
                  <i style={{ background: '#2563eb' }} />
                  Entradas
                </span>
                <span>
                  <i style={{ background: '#a5c7fc' }} />
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
                <Activity size={15} />
                <strong>{days.reduce((s, d) => s + d.entries + d.exits, 0)}</strong>
                movimentações no período
              </div>
            </div>
          ) : (
            <p className="compact-empty">Nenhuma movimentação registrada nos últimos 7 dias.</p>
          )}
        </div>
        <div className="card" id="operation-alerts">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                Atenção à operação <span className="tab-count">{alerts.length}</span>
              </h2>
              <p className="card-subtitle">Pontos que precisam de acompanhamento</p>
            </div>
            <Bell size={19} />
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
            <div className="alerts-clear">
              <div>
                <ShieldCheck size={30} />
              </div>
              <strong>Tudo em ordem por aqui</strong>
              <p>As pendências e os alertas da sua operação aparecerão neste espaço.</p>
              <span>
                <span className="live-dot" />
                Monitoramento ativo
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
