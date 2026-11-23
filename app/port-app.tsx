'use client';

import {
  Activity,
  Ban,
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleCheck,
  Eye,
  LoaderCircle,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Truck,
  UserRound,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientRequestId } from '../lib/client-id';
import { mergeSyncState } from '../lib/client-sync.mjs';
import { request as fetch } from '../lib/http-client';
import { accessOverview } from '../lib/physical-access.mjs';
import { portoPermissions } from '../lib/porto/domain.mjs';
import { CentralAccess } from './access-panels';
import { PasswordPanel } from './access-support';
import { AppShell } from './app-shell';
import { BrandMark } from './brand-mark';
import { LogisticsPanel } from './logistics-panel';
import { allowed, capability, IncidentsAndShifts, NotificationsPanel } from './operations-panels';
import { Administration } from './portal-administration';
import { Dashboard } from './portal-dashboard';
import { OperationDialog } from './portal-dialog';
import { Reports } from './portal-reports';
import {
  Action,
  actionLabel,
  attemptKey,
  canMaster,
  Dialog,
  dt,
  duration,
  initials,
  match,
  names,
  normalize,
  Page,
  PortState,
  Role,
  roleNames,
  Row,
  Status,
  statusNames,
  Table,
  Toolbar,
  User,
} from './portal-shared';
import type { OperationAlert, PortalResponse } from './portal-types';
import { PortoPanel } from './porto-panel';
import { HttpsRequiredScreen } from './transport-notice';
import { Button, FormField, PageHeader } from './ui';
import { VisitorsPanel } from './visitors-panel';

export default function PortApp() {
  const [portoEnabled, setPortoEnabled] = useState(false);
  const [deploymentStage, setDeploymentStage] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null),
    [auth, setAuth] = useState('loading'),
    [environment, setEnvironment] = useState('hosted');
  const [loginUsername, setLoginUsername] = useState(''),
    [loginPassword, setLoginPassword] = useState(''),
    [loginError, setLoginError] = useState(''),
    [loggingIn, setLoggingIn] = useState(false);
  const [state, setState] = useState<PortState | null>(null),
    [revision, setRevision] = useState(0),
    [online, setOnline] = useState(true),
    [syncAt, setSyncAt] = useState(''),
    [loading, setLoading] = useState(false),
    [syncError, setSyncError] = useState('');
  const [page, setPageState] = useState<Page>('dashboard'),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [toast, setToast] = useState(''),
    [globalQuery, setGlobalQuery] = useState(''),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [busy, setBusy] = useState(false);
  const [masterKind, setMasterKind] = useState('people'),
    [settingsTab, setSettingsTab] = useState('unit'),
    [users, setUsers] = useState<User[]>([]),
    [invites, setInvites] = useState<Row[]>([]),
    [usersError, setUsersError] = useState('');
  const [vehiclePeriod, setVehiclePeriod] = useState({ from: '', to: '' });
  const [report, setReport] = useState({
      kind: 'visitors',
      from: '',
      to: '',
      company: '',
      status: 'all',
    }),
    [now, setNow] = useState(() => Date.now());
  const revisionRef = useRef(0),
    tz = state?.settings.timezone || 'America/Manaus',
    role = user?.role || 'reader';
  const commandKeys = useRef(new Map<string, string>()),
    userKeys = useRef(new Map<string, string>()),
    capabilitiesRef = useRef(''),
    stateRef = useRef<PortState | null>(null),
    loadingRef = useRef(false);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const setPage = useCallback((next: React.SetStateAction<Page>) => {
    setPageState(next);
    setQuery('');
    setStatus('all');
  }, []);
  const notify = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(''), 5500);
  }, []);
  const loadState = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const r = await fetch(
        stateRef.current
          ? '/api/sync?since=' +
              revisionRef.current +
              '&windowSince=' +
              encodeURIComponent(stateRef.current.historyWindow?.since || '')
          : '/api/state',
        { cache: 'no-store' },
      );
      let d = (await r.json()) as PortalResponse;
      if (r.status === 401) {
        setAuth('login');
        setUser(null);
        setState(null);
        stateRef.current = null;
        revisionRef.current = 0;
        return;
      }
      if (d.error?.code === 'PASSWORD_CHANGE_REQUIRED' || d.user?.mustChangePassword) {
        if (d.user) setUser(d.user);
        setAuth('password');
        setState(null);
        stateRef.current = null;
        return;
      }
      if (d.error?.code === 'HTTPS_REQUIRED') {
        setAuth('https-required');
        setState(null);
        setUser(null);
        setOnline(false);
        setSyncError(d.error.message ?? 'Não foi possível verificar o acesso.');
        return;
      }
      if (r.status === 403) {
        setAuth('pending');
        setState(null);
        return;
      }
      if (!r.ok) throw new Error(d.error?.message || 'Não foi possível atualizar os dados.');
      const incomingCaps = d.capabilities || d.user?.capabilities,
        changed =
          !!capabilitiesRef.current &&
          !!incomingCaps &&
          JSON.stringify(incomingCaps) !== capabilitiesRef.current;
      if (changed) {
        setDialog(null);
        setGlobalQuery('');
        setState(null);
        stateRef.current = null;
        const fresh = await fetch('/api/state', { cache: 'no-store' });
        d = (await fresh.json()) as PortalResponse;
        if (!fresh.ok)
          throw new Error(d.error?.message || 'Não foi possível atualizar as permissões.');
        setPage((current) =>
          !incomingCaps.auditView && current === 'audit' ? 'dashboard' : current,
        );
      }
      if (incomingCaps) capabilitiesRef.current = JSON.stringify(incomingCaps);
      if (d.user) {
        setUser({
          ...d.user,
          capabilities: d.capabilities || d.user.capabilities,
        });
      } else if (d.capabilities) setUser((u) => (u ? { ...u, capabilities: d.capabilities } : u));
      if (d.revision < revisionRef.current) return;
      if (!d.unchanged) {
        const incoming =
          d.state ||
          (d.delta && stateRef.current ? mergeSyncState(stateRef.current, d.delta) : null);
        if (!incoming) throw new Error('A sincronização precisa ser reiniciada.');
        stateRef.current = incoming;
        setState(incoming);
        setRevision(d.revision);
        revisionRef.current = d.revision;
      }
      setOnline(true);
      setSyncAt(new Date().toISOString());
      setSyncError('');
    } catch (e) {
      setOnline(false);
      setSyncError(e instanceof Error ? e.message : 'Conexão indisponível.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [setPage]);
  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch('/api/users', { cache: 'no-store' });
      const d = (await r.json()) as PortalResponse;
      if (!r.ok) throw new Error(d.error?.message || 'Erro ao consultar usuários.');
      setUsers(d.users || []);
      setInvites((d.invites || []).filter((invite: Row) => invite.status === 'pending'));
      setUsersError('');
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : 'Não foi possível consultar usuários.');
    }
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch('/api/session', { cache: 'no-store' }),
          d = (await r.json()) as PortalResponse;
        if (!active) return;
        if (d.error?.code === 'HTTPS_REQUIRED') {
          setAuth('https-required');
          setSyncError(d.error.message ?? 'Não foi possível verificar o acesso.');
          return;
        }
        if (r.status === 401) {
          setAuth('login');
          return;
        }
        if (!r.ok) throw new Error(d.error?.message || 'Não foi possível verificar seu acesso.');
        if (!d.user) throw Error('Sessão inválida.');
        setUser({
          ...d.user,
          capabilities: d.capabilities || d.user.capabilities,
        });
        setEnvironment(d.environment || 'hosted');
        setDeploymentStage(d.deploymentStage ?? null);
        setPortoEnabled(d.features?.porto === true);
        if (d.user.status !== 'active') {
          setAuth(d.user.status === 'pending' ? 'pending' : 'disabled');
          return;
        }
        if (d.user.mustChangePassword) {
          setAuth('password');
          return;
        }
        setAuth('ready');
        if (d.user.role === 'gate') setPage('quickgate');
        await loadState();
      } catch (e) {
        setAuth('error');
        setSyncError(e instanceof Error ? e.message : 'Serviço indisponível.');
      }
    })();
    return () => {
      active = false;
    };
  }, [loadState, setPage]);
  useEffect(() => {
    if (auth !== 'ready') return;
    const t = setInterval(() => {
        void loadState();
        setNow(Date.now());
      }, 20000),
      focus = () => void loadState();
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
    };
  }, [auth, loadState]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (page !== 'settings' || role !== 'admin') return;
    const timer = setTimeout(() => void loadUsers(), 0);
    return () => clearTimeout(timer);
  }, [page, role, loadUsers]);

  async function command(
    type: string,
    payload: Record<string, unknown>,
    expectedRevision = revisionRef.current,
  ): Promise<boolean> {
    if (!online) throw new Error('Reconecte o sistema para registrar alterações.');
    const signature = JSON.stringify({ type, payload }),
      idempotencyKey = attemptKey(commandKeys.current, signature);
    setBusy(true);
    try {
      const r = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          payload,
          revision: expectedRevision,
          idempotencyKey,
        }),
      });
      const d = (await r.json()) as PortalResponse;
      if (r.status === 409) {
        await loadState();
        throw Object.assign(
          new Error(
            d.error?.message ||
              'Os dados foram atualizados por outra pessoa. Revise e tente novamente.',
          ),
          { code: 'CONFLICT' },
        );
      }
      if (d.error?.code === 'PASSWORD_CHANGE_REQUIRED') {
        setAuth('password');
        throw new Error(d.error.message);
      }
      if (!r.ok) throw new Error(d.error?.message || 'Não foi possível concluir a ação.');
      commandKeys.current.delete(signature);
      if (d.user)
        setUser({
          ...d.user,
          capabilities: d.capabilities || d.user.capabilities,
        });
      if (!d.state) throw Error('Estado operacional ausente.');
      stateRef.current = d.state;
      setState(d.state);
      setRevision(d.revision);
      revisionRef.current = d.revision;
      setSyncAt(new Date().toISOString());
      notify(
        type === 'VISITOR_GATE_REGISTER'
          ? 'Autorização inicial registrada. Foto salva; envio facial ainda pendente.'
          : 'Registro salvo com sucesso.',
      );
      return true;
    } catch (err) {
      if (err instanceof TypeError) {
        setOnline(false);
        setSyncError('A conexão foi interrompida.');
        throw new Error('A conexão foi interrompida. Reconecte antes de tentar novamente.');
      }
      throw err;
    } finally {
      setBusy(false);
    }
  }
  async function userCommand(payload: Record<string, unknown>) {
    const signature = payload.password ? clientRequestId() : JSON.stringify(payload),
      idempotencyKey = attemptKey(userKeys.current, signature),
      r = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, idempotencyKey }),
      }),
      d = (await r.json()) as PortalResponse;
    if (!r.ok) throw new Error(d.error?.message || 'Não foi possível salvar o usuário.');
    userKeys.current.delete(signature);
    await loadUsers();
    await loadState();
    notify('Acesso atualizado.');
    return true;
  }
  const navigate = (p: Page) => {
      if (p !== page) window.scrollTo({ top: 0, behavior: 'instant' });
      setPage(p);
      setGlobalQuery('');
    },
    open = (kind: string, row?: Partial<Row>, action?: string) => {
      if (['contingency', 'print-report'].includes(kind) && !capability(user, 'dataExport')) {
        notify('Seu acesso não permite imprimir ou exportar dados.');
        return;
      }
      setDialog({ kind, row, action });
    },
    disabled = !online || busy;
  const visitors = state?.visitors || [],
    vehicles = state?.vehicles || [];
  const physical = state ? accessOverview(state) : null;
  const inside: Row[] = physical?.inside || [],
    vehiclesInside = vehicles.filter((r) => r.status === 'inside'),
    pending: Row[] = physical?.pending || [];
  const alerts = useMemo(() => {
    if (!state) return [];
    const a: OperationAlert[] = [],
      physical = accessOverview(state);
    state.visitors.forEach((r) => {
      if (
        r.status === 'authorized' &&
        r.validUntil &&
        +new Date(r.validUntil) >= now &&
        +new Date(r.validUntil) - now <= 3600000
      )
        a.push({
          title: 'Autorização a vencer',
          text: `${r.name} · validade ${dt(r.validUntil, tz, true)}`,
          page: 'visitors',
        });
    });
    physical.expired.forEach((r: Row) =>
      a.push({
        title: 'Autorização vencida',
        text: `${r.name} · validade ${dt(r.validUntil, tz, true)}`,
        page: 'quickgate',
      }),
    );
    physical.overstayed.forEach((r: Row) =>
      a.push({
        title: 'Permanência excedida',
        text: `${r.name} · ${duration(r.enteredAt)} no local`,
        page: 'quickgate',
      }),
    );
    if (physical.afterHours.length)
      a.push({
        title: 'Pessoas fora do funcionamento',
        text: `${physical.afterHours.length} pessoa(s) com entrada aberta`,
        page: 'quickgate',
        high: true,
      });
    return a;
  }, [state, now, tz]);
  const nav: Page[] = [
    'dashboard',
    'quickgate',
    'visitors',
    'vehicles',
    'fleet',
    'materials',
    'incidents',
    'notifications',
    'masters',
    'reports',
    ...(portoEnabled && portoPermissions(user).view ? ['porto' as Page] : []),
    ...(capability(user, 'auditView') ? ['audit' as Page] : []),
    ...(role === 'admin' ? ['settings' as Page] : []),
  ];
  const searchResults =
    globalQuery.trim().length > 1
      ? [
          ...visitors
            .filter((r) => match(r, globalQuery))
            .slice(0, 3)
            .map((r) => ({
              row: r,
              page: 'visitors' as Page,
              title: r.name,
              sub: 'Visitante · ' + statusNames[r.status],
            })),
          ...vehicles
            .filter((r) => match(r, globalQuery))
            .slice(0, 3)
            .map((r) => ({
              row: r,
              page: 'vehicles' as Page,
              title: r.plate,
              sub: 'Veículo · ' + r.driver,
            })),
        ]
      : [];
  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setLoggingIn(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername,
          password: loginPassword,
        }),
      });
      const data = (await response.json()) as PortalResponse;
      if (!response.ok) throw new Error(data.error?.message || 'Credenciais inválidas.');
      window.location.replace('/');
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Não foi possível entrar.');
      setLoginPassword('');
    } finally {
      setLoggingIn(false);
    }
  }
  async function submitLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } finally {
      window.location.replace('/');
    }
  }
  if (auth === 'loading' || (auth === 'ready' && !state && loading))
    return (
      <div className="loading-screen">
        <div className="auth-mark">
          <BrandMark size={30} />
        </div>
        <h1>Next Portaria</h1>
        <LoaderCircle className="spinning" size={24} />
        <p>Preparando sua operação…</p>
      </div>
    );
  if (auth === 'password')
    return (
      <div className="auth-screen">
        <div className="password-required">
          <div className="auth-mark">
            <BrandMark size={30} />
          </div>
          <PasswordPanel
            forced
            onLogout={() => void submitLogout()}
            onDone={() => window.location.replace('/')}
          />
        </div>
      </div>
    );
  if (auth === 'https-required') return <HttpsRequiredScreen message={syncError} />;
  if (auth !== 'ready')
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-mark">
            <BrandMark size={32} />
          </div>
          <span className="auth-brand">Next Portaria</span>
          <h1>
            {auth === 'login'
              ? 'Acessar o portal'
              : auth === 'pending'
                ? 'Seu acesso está em análise.'
                : auth === 'disabled'
                  ? 'Acesso desativado.'
                  : 'Conexão indisponível.'}
          </h1>
          <p>
            {auth === 'login'
              ? 'Entre com sua conta da unidade.'
              : auth === 'pending'
                ? 'Sua conta foi identificada. Peça ao administrador da unidade para ativar seu perfil na Administração.'
                : auth === 'disabled'
                  ? 'Consulte o administrador da unidade para revisar seu acesso.'
                  : syncError}
          </p>
          {user && (
            <div className="notice info">
              <UserRound size={18} />
              <div>
                {user.name}
                <br />
                <small>{user.email}</small>
              </div>
            </div>
          )}
          {auth === 'login' ? (
            <form className="login-fields" onSubmit={submitLogin}>
              <label htmlFor="porto-username" className="field-label">
                Usuário
              </label>
              <input
                className="input"
                id="porto-username"
                type="text"
                autoComplete="username"
                maxLength={40}
                required
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                placeholder="seu.usuario"
              />
              <label htmlFor="porto-password" className="field-label">
                Senha
              </label>
              <input
                className="input"
                id="porto-password"
                type="password"
                autoComplete="current-password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Sua senha"
              />
              {loginError && (
                <div className="notice error" role="alert">
                  {loginError}
                </div>
              )}
              <button className="button primary" type="submit" disabled={loggingIn}>
                <LogIn size={18} />
                {loggingIn ? 'Entrando…' : 'Entrar no sistema'}
              </button>
            </form>
          ) : (
            <Button onClick={() => window.location.reload()}>
              <RefreshCw size={17} />
              Verificar novamente
            </Button>
          )}
        </div>
      </div>
    );
  if (!state)
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <WifiOff size={36} />
          <h1>Não foi possível carregar a operação.</h1>
          <p>{syncError}</p>
          <Button onClick={() => void loadState()}>
            <RefreshCw size={17} />
            Tentar novamente
          </Button>
        </div>
      </div>
    );
  return (
    <AppShell
      items={nav.map((id) => ({
        ...names[id],
        id,
        group: id === 'masters' ? 'GESTÃO' : undefined,
        count: id === 'visitors' ? pending.length : 0,
      }))}
      active={page}
      unit={state.settings.unitName || 'Unidade'}
      user={{
        name: user!.name,
        role: role === 'finance' && portoEnabled ? 'Financeiro do Porto' : roleNames[role],
        initials: initials(user?.name),
      }}
      title={names[page].title}
      onNavigate={(id) => navigate(id as Page)}
      onLogout={() => void submitLogout()}
      topbar={
        <>
          <div className="global-search">
            <Search size={17} />
            <input
              id="global-search"
              value={globalQuery}
              onChange={(e) => setGlobalQuery(e.target.value)}
              placeholder="Buscar pessoa, placa ou empresa…"
              aria-label="Busca geral"
            />
            {globalQuery && (
              <button aria-label="Limpar busca" onClick={() => setGlobalQuery('')}>
                <X size={14} />
              </button>
            )}
            {globalQuery.trim().length > 1 && (
              <div className="search-results">
                {searchResults.length ? (
                  searchResults.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        navigate(r.page);
                        open('detail', r.row, r.page);
                      }}
                    >
                      <Search size={15} />
                      <span>
                        <strong>{r.title}</strong>
                        <small>{r.sub}</small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))
                ) : (
                  <div className="search-no-result">Nenhum registro encontrado.</div>
                )}
              </div>
            )}
          </div>
          <div className="top-actions">
            <button
              aria-label={
                loading
                  ? 'Atualizando dados'
                  : online
                    ? 'Sincronizado. Atualizar dados'
                    : 'Sem conexão. Tentar novamente'
              }
              className={`sync-indicator ${!online ? 'offline' : ''}`}
              onClick={() => void loadState()}
              title={syncAt ? `Última atualização: ${dt(syncAt, tz)}` : 'Atualizar dados'}
            >
              {loading ? (
                <RefreshCw className="spinning" size={13} />
              ) : online ? (
                <span className="live-dot" />
              ) : (
                <WifiOff size={13} />
              )}
              <span>{loading ? 'Atualizando…' : online ? 'Sincronizado' : 'Sem conexão'}</span>
            </button>
            <button
              className="icon-button notification-button"
              title="Ver alertas"
              aria-label={`${alerts.length} alertas`}
              onClick={() => navigate('notifications')}
            >
              <Bell size={20} />
              {alerts.length > 0 && <span className="notifications-count">{alerts.length}</span>}
            </button>
            <button
              type="button"
              className="top-avatar"
              aria-label="Abrir minha senha"
              title={user?.name}
              onClick={() => navigate('password')}
            >
              {initials(user?.name)}
            </button>
          </div>
        </>
      }
    >
      {!online && (
        <div className="connection-banner">
          <WifiOff size={18} />
          <div>
            <strong>Conexão interrompida. Exibindo a última sincronização.</strong>
            <span>
              Alterações suspensas. Use a lista impressa e reconcilie os registros após a conexão
              voltar.
            </span>
          </div>
          <Button variant="small" onClick={() => open('contingency')}>
            <Printer size={15} />
            Lista de contingência
          </Button>
          <Button variant="small" onClick={() => void loadState()}>
            <RefreshCw size={15} />
            Reconectar
          </Button>
        </div>
      )}
      <main key={page} id="main-content" tabIndex={-1} className="page-content" data-screen={page}>
        {(deploymentStage === 'homologation' || environment === 'demo') && (
          <div className="environment-banner" role="note">
            <strong>
              {environment === 'demo' ? 'Demonstração isolada' : 'Ambiente de homologação'}
            </strong>
            <span>
              {environment === 'demo'
                ? 'Dados fictícios · alterações apenas nesta aba.'
                : 'Pode conter cadastros reais e dados de teste. Alterações são gravadas nesta instalação.'}
            </span>
          </div>
        )}
        {page !== 'quickgate' && (
          <PageHeader
            title={<>{names[page].title}</>}
            description={names[page].sub}
            actions={
              <>
                {page === 'dashboard' ? (
                  <>
                    <span className="date-display">
                      <CalendarDays size={16} />
                      {new Intl.DateTimeFormat('pt-BR', {
                        timeZone: tz,
                        day: '2-digit',
                        month: 'long',
                      }).format(new Date())}
                    </span>
                    {allowed(user, 'VISITOR_REQUEST') && (
                      <Button variant="primary" disabled={disabled} onClick={() => open('visitor')}>
                        <Plus size={17} />
                        Novo acesso
                      </Button>
                    )}
                    <Button className="dashboard-report-link" onClick={() => navigate('reports')}>
                      <ChartNoAxesCombined size={17} />
                      Ver relatórios
                    </Button>
                  </>
                ) : page === 'visitors' && allowed(user, 'VISITOR_REQUEST') ? (
                  <Button variant="primary" disabled={disabled} onClick={() => open('visitor')}>
                    <Plus size={17} />
                    Nova solicitação
                  </Button>
                ) : page === 'vehicles' && allowed(user, 'VEHICLE_ENTER') ? (
                  <Button variant="primary" disabled={disabled} onClick={() => open('vehicle')}>
                    <Plus size={17} />
                    Registrar entrada
                  </Button>
                ) : page === 'masters' && canMaster(role, masterKind) ? (
                  <Button
                    variant="primary"
                    disabled={disabled}
                    onClick={() => setDialog({ kind: 'master', masterKind })}
                  >
                    <Plus size={17} />
                    Novo cadastro
                  </Button>
                ) : null}
              </>
            }
          />
        )}
        {(page === 'fleet' || page === 'materials') && (
          <LogisticsPanel
            key={page}
            mode={page === 'fleet' ? 'fleet' : 'materials'}
            state={state}
            user={user!}
            run={command}
            reload={loadState}
          />
        )}
        {page === 'porto' && portoEnabled && (
          <PortoPanel
            user={user!}
            disabled={disabled}
            onMaster={() => {
              setMasterKind('fleet');
              navigate('masters');
            }}
          />
        )}
        {page === 'password' && (
          <PasswordPanel
            onLogout={() => void submitLogout()}
            onDone={(data) => {
              if (data.user)
                setUser({
                  ...data.user,
                  capabilities: data.capabilities || data.user.capabilities,
                });
              notify('Senha alterada com sucesso.');
              navigate('dashboard');
            }}
          />
        )}
        {page === 'dashboard' && (
          <Dashboard
            user={user}
            state={state}
            inside={inside}
            vehiclesInside={vehiclesInside}
            pending={pending}
            alerts={alerts}
            role={role}
            navigate={navigate}
            open={open}
            tz={tz}
          />
        )}
        {page === 'visitors' && (
          <VisitorsPanel {...{ visitors, revision, tz, user, disabled, open }} />
        )}
        {page === 'vehicles' && (
          <>
            <div className="stat-strip">
              <div className="stat-item">
                <Truck size={19} />
                <span>
                  Veículos no local<strong>{vehiclesInside.length}</strong>
                </span>
              </div>
              <div className="stat-item">
                <Activity size={19} />
                <span>
                  Movimentações registradas<strong>{vehicles.length}</strong>
                </span>
              </div>
            </div>
            <div className="card">
              <Toolbar
                query={query}
                onQuery={setQuery}
                status={status}
                onStatus={setStatus}
                options={['inside', 'completed']}
                placeholder="Buscar placa, motorista ou empresa…"
              />
              <div className="vehicle-period">
                <FormField label="Entrada desde">
                  <input
                    className="input"
                    type="date"
                    value={vehiclePeriod.from}
                    max={vehiclePeriod.to || undefined}
                    onChange={(event) =>
                      setVehiclePeriod({
                        ...vehiclePeriod,
                        from: event.target.value,
                      })
                    }
                  />
                </FormField>
                <FormField label="Entrada até">
                  <input
                    className="input"
                    type="date"
                    value={vehiclePeriod.to}
                    min={vehiclePeriod.from || undefined}
                    onChange={(event) =>
                      setVehiclePeriod({
                        ...vehiclePeriod,
                        to: event.target.value,
                      })
                    }
                  />
                </FormField>
                {(vehiclePeriod.from || vehiclePeriod.to) && (
                  <Button onClick={() => setVehiclePeriod({ from: '', to: '' })}>
                    Limpar período
                  </Button>
                )}
              </div>
              <Table
                server={{
                  collection: 'vehicles',
                  q: query,
                  status,
                  revision,
                  params: vehiclePeriod,
                }}
                rows={vehicles.filter(
                  (r) => match(r, query) && (status === 'all' || r.status === status),
                )}
                emptyTitle="Movimentação de veículos"
                emptyText="Registre a primeira entrada com placa, motorista, empresa e motivo de acesso."
                columns={[
                  {
                    title: 'Veículo',
                    render: (r) => (
                      <div className="avatar-cell">
                        <span className="initials">
                          <Truck size={20} />
                        </span>
                        <div className="cell-primary mono">
                          {r.plate}
                          <span className="cell-subtle">{r.company}</span>
                        </div>
                      </div>
                    ),
                  },
                  {
                    title: 'Motorista / motivo',
                    render: (r) => (
                      <div>
                        {r.driver}
                        <span className="cell-subtle">{r.purpose}</span>
                      </div>
                    ),
                  },
                  {
                    title: 'Entrada / saída',
                    render: (r) => (
                      <div>
                        {dt(r.entryAt, tz, true)}
                        <span className="cell-subtle">
                          {r.exitAt ? dt(r.exitAt, tz, true) : 'Aguardando saída'}
                        </span>
                      </div>
                    ),
                  },
                  { title: 'Portaria', render: (r) => r.gateName || '—' },
                  {
                    title: 'Situação',
                    render: (r) => (
                      <Status
                        value={r.status}
                        facePending={
                          r.initialAccessScope === 'gate_only' && r.status === 'authorized'
                        }
                      />
                    ),
                  },
                  {
                    title: 'Ações',
                    render: (r) => (
                      <div className="row-actions">
                        <Action
                          icon={Eye}
                          label="Detalhes do veículo"
                          onClick={() => open('detail', r, 'vehicles')}
                        />
                        {r.status === 'inside' && allowed(user, 'VEHICLE_EXIT') && (
                          <Action
                            icon={LogOut}
                            label="Registrar saída do veículo"
                            disabled={disabled}
                            onClick={() => open('confirm', r, 'VEHICLE_EXIT')}
                          />
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </>
        )}
        {page === 'masters' && (
          <>
            <div className="tabs">
              {[
                { id: 'people', label: 'Pessoas', icon: Users },
                { id: 'fleet', label: 'Veículos', icon: Truck },
                { id: 'companies', label: 'Empresas', icon: Building2 },
              ].map((t) => (
                <button
                  key={t.id}
                  className={`tab ${masterKind === t.id ? 'active' : ''}`}
                  onClick={() => {
                    setMasterKind(t.id);
                    setQuery('');
                  }}
                >
                  <t.icon size={17} />
                  {t.label}
                  <span className="tab-count">
                    {(state as unknown as Record<string, Row[]>)[t.id]?.length || 0}
                  </span>
                </button>
              ))}
            </div>
            <div className="card">
              <Toolbar query={query} onQuery={setQuery} placeholder="Buscar nos cadastros…" />
              <Table
                rows={((state as unknown as Record<string, Row[]>)[masterKind] || []).filter(
                  (r: Row) => match(r, query),
                )}
                emptyTitle="Cadastros que economizam tempo"
                emptyText="Salve pessoas, veículos e empresas para reaproveitar as informações nos próximos acessos."
                columns={[
                  {
                    title: masterKind === 'fleet' ? 'Placa' : 'Nome',
                    render: (r) => (
                      <div className="cell-primary">
                        {r.name || r.plate}
                        <span className="cell-subtle">
                          {r.company ||
                            (r.documentLast4 ? `Documento final ${r.documentLast4}` : '')}
                        </span>
                      </div>
                    ),
                  },
                  {
                    title: 'Responsável / contato',
                    render: (r) => (
                      <div>
                        {r.contact || r.driver || r.host || '—'}
                        <span className="cell-subtle">{r.email || r.phone || ''}</span>
                      </div>
                    ),
                  },
                  {
                    title: 'Situação',
                    render: (r) => <Status value={r.active === false ? 'disabled' : 'active'} />,
                  },
                  {
                    title: 'Ações',
                    render: (r) => (
                      <div className="row-actions">
                        {canMaster(role, masterKind) && (
                          <>
                            <Action
                              icon={Pencil}
                              label="Editar cadastro"
                              disabled={disabled}
                              onClick={() =>
                                setDialog({
                                  kind: 'master',
                                  masterKind,
                                  row: r,
                                })
                              }
                            />
                            <Action
                              icon={r.active === false ? Check : Ban}
                              label={
                                r.active === false ? 'Reativar cadastro' : 'Desativar cadastro'
                              }
                              disabled={
                                disabled ||
                                (masterKind === 'people' &&
                                  r.active === false &&
                                  !capability(user, 'accessManage'))
                              }
                              onClick={() => open('master-toggle', { ...r, masterKind })}
                            />
                          </>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </div>
          </>
        )}
        {page === 'reports' && (
          <Reports
            state={state}
            report={report}
            setReport={setReport}
            tz={tz}
            open={open}
            user={user}
            revision={revision}
            openPorto={
              portoEnabled && portoPermissions(user).view ? () => navigate('porto') : undefined
            }
          />
        )}
        {page === 'audit' && capability(user, 'auditView') && (
          <div className="card">
            <Toolbar
              query={query}
              onQuery={setQuery}
              placeholder="Buscar ação, usuário ou justificativa…"
            />
            <Table
              server={{ collection: 'audit', q: query, revision }}
              rows={state.audit.filter(
                (r) =>
                  match(r, query) ||
                  normalize(actionLabel(r.action ?? '')).includes(normalize(query)),
              )}
              emptyTitle="Tudo fica registrado"
              emptyText="As ações realizadas geram um histórico com usuário, data e alterações."
              columns={[
                { title: 'Data e hora', render: (r) => dt(r.at, tz) },
                {
                  title: 'Usuário',
                  render: (r) => (
                    <div className="cell-primary">
                      {typeof r.actor === 'object' ? r.actor.name : r.actor}
                      <span className="cell-subtle">{roleNames[r.role as Role] || r.role}</span>
                    </div>
                  ),
                },
                {
                  title: 'Ação',
                  render: (r) => <span className="chip">{actionLabel(r.action ?? '')}</span>,
                },
                {
                  title: 'Registro',
                  render: (r) => (
                    <div>
                      {r.entity}
                      <span className="cell-subtle mono">{r.entityId?.slice(-10) || '—'}</span>
                    </div>
                  ),
                },
                {
                  title: 'Resumo',
                  render: (r) =>
                    typeof r.detail === 'string' ? r.detail : r.reason || 'Alteração registrada',
                },
                {
                  title: '',
                  render: (r) => (
                    <Action
                      icon={Eye}
                      label="Ver alterações de auditoria"
                      onClick={() => open('audit-detail', r)}
                    />
                  ),
                },
              ]}
            />
          </div>
        )}
        {page === 'quickgate' && (
          <CentralAccess
            {...{
              state,
              user: user!,
              revision,
              disabled,
              tz,
              command,
              loadState,
              open,
              notify,
            }}
          />
        )}
        {page === 'incidents' && (
          <IncidentsAndShifts
            {...{
              state,
              user: user!,
              revision,
              disabled,
              tz,
              command,
              loadState,
              open,
              notify,
            }}
          />
        )}
        {page === 'notifications' && (
          <NotificationsPanel
            {...{
              state,
              user: user!,
              revision,
              disabled,
              tz,
              command,
              loadState,
              open,
              notify,
            }}
          />
        )}
        {page === 'settings' && role === 'admin' && (
          <Administration
            user={user!}
            loadState={loadState}
            role={role}
            state={state}
            revision={revision}
            tab={settingsTab}
            setTab={setSettingsTab}
            disabled={disabled}
            command={command}
            users={users}
            invites={invites}
            error={usersError}
            loadUsers={loadUsers}
            tz={tz}
            open={open}
            notify={notify}
          />
        )}
        <footer className="page-footer">
          <span>
            Next Portaria
            {environment === 'local' ? ' · Ambiente local' : ''}
          </span>
          <span>
            {syncAt ? `Atualizado ${dt(syncAt, tz, true)}` : 'Aguardando sincronização'} · {tz}
          </span>
        </footer>
      </main>
      {toast && (
        <div className="toast" role="status">
          <CircleCheck size={18} />
          <span>{toast}</span>
          <button aria-label="Dispensar mensagem" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {dialog && (
        <OperationDialog
          key={`${dialog.kind}-${dialog.row?.id || dialog.masterKind || ''}-${dialog.action || ''}`}
          dialog={dialog}
          portoEnabled={portoEnabled}
          state={state}
          user={user!}
          tz={tz}
          online={online}
          close={() => setDialog(null)}
          command={command}
          userCommand={userCommand}
          loadState={loadState}
          revision={revision}
          onDone={notify}
          open={setDialog}
        />
      )}
    </AppShell>
  );
}
