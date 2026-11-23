'use client';

import { Activity, ChevronDown, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { request } from '../lib/http-client';
import { monitorConnectionFresh, relativeEventTime } from '../lib/monitor-freshness.mjs';
import { PrivateImage } from './private-image';
import { useClock } from './use-clock';
import './turnstile-monitor.css';

type Event = {
  id: string;
  device: string;
  area: string;
  name: string;
  occurredAt: string;
  eventName: string;
  kind: string;
  personId: string | null;
  photoUrl: string | null;
};
type Snapshot = {
  source: string;
  mode?: 'simulation';
  status: string;
  lastSuccessAt: string | null;
  events: Event[];
};
type Feed = { snapshot: Snapshot; arrivals: Set<string> };
const previewCount = 3;
const statusNames: Record<string, string> = {
  connected: 'iDSecure conectado',
  offline: 'Conexão indisponível',
  authentication: 'Credencial da integração recusada',
  invalid: 'Resposta da central inválida',
  unconfigured: 'Monitor não configurado',
};
function Photo({ event, spotlight = false }: { event: Event; spotlight?: boolean }) {
  const className = spotlight ? 'turnstile-photo' : 'turnstile-avatar';
  // Authenticated photos must bypass the public image optimizer and any third-party host.
  return event.photoUrl ? (
    <PrivateImage
      className={className}
      src={event.photoUrl}
      alt={'Foto de ' + event.name}
      loading="lazy"
    />
  ) : (
    <span className={className + ' placeholder'} aria-hidden="true">
      <UserRound size={spotlight ? 30 : 16} />
    </span>
  );
}

function EventStatus({ event }: { event: Event }) {
  return (
    <span className="turnstile-event" data-kind={event.kind}>
      {event.eventName}
    </span>
  );
}

export function TurnstileMonitor({ enabled, tz }: { enabled: boolean; tz: string }) {
  const now = useClock(10000);
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }),
    [tz],
  );
  const [feed, setFeed] = useState<Feed | null>(null),
    [error, setError] = useState(''),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false,
      loading = false,
      stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      controller: AbortController | undefined;
    const schedule = () => {
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    };
    async function refresh() {
      if (disposed || loading || stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      loading = true;
      controller = new AbortController();
      const active = controller,
        timeout = setTimeout(() => active.abort(), 15000);
      try {
        const response = await request('/api/integrations/idsecure/monitor', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          if (!disposed) {
            setFeed(null);
            setError('Sua sessão ou permissão de consulta mudou. Atualize a página.');
          }
          stopped = true;
          return;
        }
        if (!response.ok) throw Error('Consulta indisponível');
        const snapshot = (await response.json()) as Snapshot;
        if (!Array.isArray(snapshot.events) || snapshot.events.length > 50)
          throw Error('Resposta inválida');
        if (!disposed) {
          setFeed((previous) => {
            const arrivals = new Set<string>();
            if (
              previous &&
              previous.snapshot.source === snapshot.source &&
              previous.snapshot.mode === snapshot.mode
            ) {
              const known = new Set(previous.snapshot.events.map(({ id }) => id));
              const lastEvent = Date.parse(previous.snapshot.events[0]?.occurredAt ?? '');
              for (const event of snapshot.events) {
                const afterLastEvent =
                  Number.isNaN(lastEvent) || Date.parse(event.occurredAt) >= lastEvent;
                if (!known.has(event.id) && afterLastEvent) arrivals.add(event.id);
              }
            }
            return { snapshot, arrivals };
          });
          setError('');
        }
      } catch {
        if (!disposed)
          setError(
            'Não foi possível consultar a central. O histórico mostra os últimos registros recebidos.',
          );
      } finally {
        clearTimeout(timeout);
        loading = false;
        if (!stopped) schedule();
      }
    }
    const visible = () => {
      if (!document.hidden && !loading) {
        clearTimeout(timer);
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [enabled]);
  if (!enabled) return null;
  const data = feed?.snapshot;
  const connected = monitorConnectionFresh(data, now) && !error;
  const latest = data?.events[0];
  const history = data?.events.slice(1) ?? [];
  const events = expanded ? history : history.slice(0, previewCount);
  const simulation = data?.mode === 'simulation';
  const status = error
    ? 'Consulta indisponível'
    : simulation
      ? 'Simulação'
      : !data
        ? 'Consultando central…'
        : data.status === 'connected' && !connected
          ? 'Sem confirmação recente'
          : (statusNames[data.status] ?? 'Consulta indisponível');
  const tone = error
    ? 'offline'
    : simulation
      ? 'simulation'
      : connected
        ? 'online'
        : !data || data.status === 'connected' || data.status === 'unconfigured'
          ? 'paused'
          : 'offline';
  const issue =
    error ||
    (data?.status === 'unconfigured'
      ? 'Configure a central em Administração → Control iD.'
      : data?.status === 'authentication'
        ? 'Revise a credencial em Administração → Control iD.'
        : data && data.status !== 'connected'
          ? 'A consulta falhou. Os registros disponíveis são da última leitura.'
          : '');
  const formatTime = (value: string) => date.format(new Date(value));
  return (
    <section className="turnstile-monitor" aria-labelledby="turnstile-monitor-title">
      <header className="turnstile-header">
        <div className="turnstile-heading">
          <h2 id="turnstile-monitor-title">Movimentação das catracas</h2>
          {simulation && <p>Dados fictícios para apresentação</p>}
        </div>
        <span className="turnstile-connection" data-tone={tone} role="status">
          <span className="turnstile-dot" aria-hidden="true" />
          {status}
        </span>
      </header>
      <dl className="turnstile-freshness">
        <div>
          <dt>Última consulta confirmada</dt>
          <dd>
            {data?.lastSuccessAt ? (
              <time dateTime={data.lastSuccessAt}>{formatTime(data.lastSuccessAt)}</time>
            ) : (
              'Aguardando consulta'
            )}
          </dd>
        </div>
        <div
          className={
            latest && now - Date.parse(latest.occurredAt) > 86400000
              ? 'event-historical'
              : undefined
          }
        >
          <dt>Último evento</dt>
          <dd>{latest ? relativeEventTime(latest.occurredAt, now) : 'Nenhum evento recebido'}</dd>
        </div>
      </dl>
      {issue && (
        <p className="turnstile-error" role="status">
          {issue}
        </p>
      )}
      {latest ? (
        <div className="turnstile-content">
          <article
            className="turnstile-latest"
            aria-label="Último evento informado"
            data-new={feed?.arrivals.has(latest.id) || undefined}
            key={latest.id}
          >
            <small className="turnstile-caption">Registro mais recente</small>
            <div className="turnstile-identity">
              <Photo event={latest} spotlight />
              <div>
                <h3>{latest.name}</h3>
                <EventStatus event={latest} />
              </div>
            </div>
            <dl className="turnstile-event-meta">
              <div>
                <dt>Equipamento</dt>
                <dd>{latest.device}</dd>
              </div>
              <div>
                <dt>Área</dt>
                <dd>{latest.area}</dd>
              </div>
              <div>
                <dt>Horário</dt>
                <dd>
                  <time dateTime={latest.occurredAt}>{formatTime(latest.occurredAt)}</time>
                </dd>
              </div>
            </dl>
            {!latest.personId && <p className="turnstile-note">Cadastro ainda sem vínculo.</p>}
          </article>
          <section className="turnstile-history" aria-labelledby="turnstile-history-title">
            <h3 className="turnstile-history-title" id="turnstile-history-title">
              Eventos anteriores
            </h3>
            {events.length ? (
              <ol
                className="turnstile-list"
                id="turnstile-history"
                data-expanded={expanded}
                aria-labelledby="turnstile-history-title"
                tabIndex={expanded ? 0 : undefined}
              >
                {events.map((event) => (
                  <li
                    className="turnstile-row"
                    key={event.id}
                    data-new={feed?.arrivals.has(event.id) || undefined}
                  >
                    <Photo event={event} />
                    <div className="turnstile-person">
                      <strong>{event.name}</strong>
                      <small>
                        {event.device} · {event.area}
                      </small>
                    </div>
                    <div className="turnstile-row-detail">
                      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                      <EventStatus event={event} />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="turnstile-history-empty">Nenhum registro anterior nesta consulta.</p>
            )}
          </section>
        </div>
      ) : (
        <div className="turnstile-empty">
          <Activity size={23} aria-hidden="true" />
          <p>
            {data?.status === 'connected'
              ? 'A central não retornou eventos recentes.'
              : data
                ? 'Nenhum evento disponível nesta consulta.'
                : 'Consultando eventos da central…'}
          </p>
        </div>
      )}
      <footer className="turnstile-footer">
        <p className="turnstile-note">Giro e sentido exigem conferência no equipamento.</p>
        {history.length > previewCount && (
          <button
            type="button"
            className="turnstile-toggle"
            aria-expanded={expanded}
            aria-controls="turnstile-history"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Mostrar menos' : 'Ver todos os eventos'}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        )}
      </footer>
    </section>
  );
}
