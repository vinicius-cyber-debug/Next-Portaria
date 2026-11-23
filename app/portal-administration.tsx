'use client';

import type { PortalResponse } from './portal-types';
import {
  Ban,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Download,
  History,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Pencil,
  Plus,
  Plug,
  Printer,
  ShieldCheck,
  Upload,
  Users,
} from 'lucide-react';
import React, { useState } from 'react';
import { request as fetch } from '../lib/http-client';
import type { Settings } from '../lib/operational-types';
import { AccessAreaSettings } from './access-panels';
import { capability, ContinuityPanel, DetailedPermissions } from './operations-panels';
import {
  Action,
  download,
  Field,
  FieldDef,
  initials,
  PortState,
  Role,
  roleNames,
  Row,
  Status,
  Table,
  User,
} from './portal-shared';
import { Button } from './ui';
import { ExitAccessPanel } from './exit-access-panel';
import { ControlIdSettings } from './controlid-settings';

export function Administration({
  user,
  loadState,
  role,
  state,
  revision,
  tab,
  setTab,
  disabled,
  command,
  users,
  invites,
  error,
  loadUsers,
  tz,
  open,
  notify,
}: {
  user: User;
  loadState: () => Promise<void>;
  role: Role;
  state: PortState;
  revision: number;
  tab: string;
  setTab: (v: string) => void;
  disabled: boolean;
  command: (t: string, p: Record<string, unknown>, expectedRevision?: number) => Promise<boolean>;
  users: User[];
  invites: Row[];
  error: string;
  loadUsers: () => Promise<void>;
  tz: string;
  open: (k: string, r?: Partial<Row>, a?: string) => void;
  notify: (m: string) => void;
}) {
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Configurações">
        {[
          { id: 'unit', label: 'Unidade e operação', icon: Building2 },
          { id: 'users', label: 'Usuários e permissões', icon: Users },
          { id: 'backup', label: 'Backup e contingência', icon: ShieldCheck },
          { id: 'continuity', label: 'Continuidade', icon: History },
          { id: 'access', label: 'Permissões detalhadas', icon: LockKeyhole },
          ...(role === 'admin' ? [{ id: 'sectors', label: 'Setores e líderes', icon: Users }] : []),
          { id: 'areas', label: 'Setores e áreas de acesso', icon: MapPin },
          ...(role === 'admin' ? [{ id: 'controlid', label: 'Control iD', icon: Plug }] : []),
        ].map((t) => (
          <button
            type="button"
            className={tab === t.id ? 'active' : ''}
            aria-current={tab === t.id ? 'page' : undefined}
            key={t.id}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={16} aria-hidden="true" />
            <span>{t.label}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ))}
      </nav>
      <div className="settings-panel">
        {tab === 'controlid' && role === 'admin' && (
          <ControlIdSettings disabled={disabled} onSaved={loadState} />
        )}
        {tab === 'sectors' && role === 'admin' && (
          <ExitAccessPanel user={user} administration disabled={disabled} />
        )}
        {tab === 'continuity' && role === 'admin' && (
          <ContinuityPanel
            {...{
              state,
              user,
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
        {tab === 'access' && role === 'admin' && (
          <DetailedPermissions
            {...{
              state,
              user,
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
        {tab === 'areas' && (
          <AccessAreaSettings
            {...{
              state,
              user,
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
        {tab === 'unit' && (
          <SettingsForm revision={revision} state={state} disabled={disabled} onSave={command} />
        )}
        {tab === 'users' && (
          <>
            <div className="notice info">
              <LockKeyhole size={19} />
              <div>
                Crie usuários com login e senha próprios. O administrador define o perfil e pode
                redefinir senhas.
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Usuários da unidade</h2>
                </div>
                <Button variant="primary small" disabled={disabled} onClick={() => open('invite')}>
                  <Plus size={16} />
                  Cadastrar acesso
                </Button>
              </div>
              {error && (
                <div className="notice error">
                  {error}
                  <Button variant="small" onClick={() => void loadUsers()}>
                    Tentar novamente
                  </Button>
                </div>
              )}
              <Table
                rows={users}
                emptyTitle="Nenhum usuário encontrado"
                columns={[
                  {
                    title: 'Usuário',
                    render: (r) => (
                      <div className="avatar-cell">
                        <span className="initials">{initials(r.name)}</span>
                        <div className="cell-primary">
                          {r.name}
                          <span className="cell-subtle">
                            {r.username ? '@' + r.username + ' · ' : ''}
                            {r.email}
                          </span>
                        </div>
                      </div>
                    ),
                  },
                  { title: 'Perfil', render: (r) => roleNames[r.role] },
                  {
                    title: 'Situação',
                    render: (r) => <Status value={r.status} />,
                  },
                  {
                    title: '',
                    render: (r) => (
                      <>
                        <Action
                          icon={Pencil}
                          label="Editar acesso e perfil"
                          disabled={disabled}
                          onClick={() => open('user', { ...r })}
                        />
                        {r.username && (
                          <Action
                            icon={LockKeyhole}
                            label="Redefinir senha"
                            disabled={disabled}
                            onClick={() => open('password-reset', { ...r })}
                          />
                        )}
                      </>
                    ),
                  },
                ]}
              />
            </div>
            {false && !!invites.length && (
              <div className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Acessos pré-cadastrados</h2>
                    <p className="card-subtitle">
                      O perfil será aplicado no primeiro acesso com esse e-mail.
                    </p>
                  </div>
                </div>
                <Table
                  rows={invites}
                  columns={[
                    {
                      title: 'Pessoa / e-mail',
                      render: (r) => (
                        <div>
                          {r.name}
                          <span className="cell-subtle">{r.email}</span>
                        </div>
                      ),
                    },
                    {
                      title: 'Perfil',
                      render: (r) => roleNames[r.role as Role],
                    },
                    {
                      title: '',
                      render: (r) => (
                        <Action
                          icon={Ban}
                          label="Revogar acesso pré-cadastrado"
                          disabled={disabled}
                          onClick={() => open('revoke-invite', r)}
                        />
                      ),
                    },
                  ]}
                />
              </div>
            )}
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Perfis de acesso</h2>
              </div>
              <div className="card-body role-grid">
                {[
                  {
                    role: 'admin',
                    text: 'Configurações, usuários, backup e todos os módulos.',
                  },
                  {
                    role: 'director',
                    text: 'Solicitações, aprovação, recusa e revogação de visitas; consultas gerenciais.',
                  },
                  {
                    role: 'gate',
                    text: 'Solicitações, entradas e saídas de visitantes e veículos.',
                  },
                  {
                    role: 'operations',
                    text: 'Ocorrências, evidências e passagem de turno da operação.',
                  },
                  {
                    role: 'reader',
                    text: 'Consulta de dados, indicadores e relatórios.',
                  },
                ].map((r) => (
                  <div key={r.role}>
                    <strong>{roleNames[r.role as Role]}</strong>
                    <p>{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        {tab === 'backup' && (
          <>
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Backup da operação</h2>
                </div>
                <ShieldCheck size={23} />
              </div>
              <div className="card-body">
                <p>
                  O backup operacional inclui configurações, cadastros e registros. A auditoria é
                  preservada na base e exportada separadamente. Limite do arquivo de restauração: 5
                  MB. Para bases maiores, mantenha também cópias da infraestrutura. Guarde os
                  arquivos em local de acesso restrito.
                </p>
                <div className="actions">
                  <Button
                    disabled={disabled}
                    onClick={async () => {
                      try {
                        const r = await fetch('/api/backup'),
                          d = (await r.json()) as PortalResponse;
                        if (!r.ok) throw new Error(d.error?.message || 'Falha ao exportar backup.');
                        download(
                          `porto-backup-${new Date().toISOString().slice(0, 10)}.json`,
                          JSON.stringify(d),
                          'application/json',
                        );
                        notify('Backup exportado.');
                      } catch (e) {
                        notify(e instanceof Error ? e.message : 'Falha ao exportar.');
                      }
                    }}
                  >
                    <Download size={17} />
                    Exportar backup JSON
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={async () => {
                      try {
                        const response = await fetch('/api/audit-export'),
                          data = (await response.json()) as PortalResponse;
                        if (!response.ok)
                          throw new Error(
                            data.error?.message || 'Não foi possível exportar a auditoria.',
                          );
                        download(
                          'porto-auditoria-' + new Date().toISOString().slice(0, 10) + '.json',
                          JSON.stringify(data, null, 2),
                          'application/json',
                        );
                        notify('Auditoria exportada.');
                      } catch (error) {
                        notify(
                          error instanceof Error ? error.message : 'Não foi possível exportar.',
                        );
                      }
                    }}
                  >
                    <ShieldCheck size={17} />
                    Exportar auditoria JSON
                  </Button>
                </div>
              </div>
            </div>
            <div className="card danger-zone">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Restaurar backup</h2>
                  <p className="card-subtitle">
                    Substitui os registros operacionais atuais pelo arquivo selecionado.
                  </p>
                </div>
              </div>
              <div className="card-body">
                <p>
                  Exporte o estado atual antes de restaurar. A restauração exige justificativa e
                  confirmação; os usuários de acesso não são alterados.
                </p>
                <Button disabled={disabled} onClick={() => open('restore')}>
                  <Upload size={17} />
                  Selecionar backup e revisar
                </Button>
              </div>
            </div>
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Procedimento de contingência</h2>
                <Printer size={20} />
              </div>
              <div className="card-body">
                <ol className="contingency-steps">
                  <li>Imprima uma lista atualizada de pessoas e veículos presentes.</li>
                  <li>
                    Sem conexão, registre as movimentações em formulário físico com horário e
                    responsável.
                  </li>
                  <li>
                    Quando a conexão voltar, confira a lista e reconcilie os registros.
                    Movimentações de acesso usam o horário do servidor; guarde os horários físicos
                    nas observações de correção.
                  </li>
                  <li>
                    Confira os acessos pendentes e registre a passagem de turno com os responsáveis.
                  </li>
                </ol>
                <Button
                  disabled={!capability(user, 'dataExport')}
                  onClick={() => open('contingency')}
                >
                  <Printer size={17} />
                  Abrir lista para impressão
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SettingsForm({
  state,
  disabled,
  onSave,
  revision,
}: {
  state: PortState;
  disabled: boolean;
  revision: number;
  onSave: (t: string, p: Record<string, unknown>, expectedRevision?: number) => Promise<boolean>;
}) {
  const [v, setV] = useState<Settings & { gates: string }>({
      ...state.settings,
      gates: state.settings.gateNames.join('\n'),
    }),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [saving, setSaving] = useState(false),
    [expectedRevision, setExpectedRevision] = useState(revision),
    [conflict, setConflict] = useState(false);
  const fields: FieldDef[] = [
    { name: 'unitName', label: 'Nome da unidade', required: true, full: true },
    {
      name: 'timezone',
      label: 'Fuso horário',
      type: 'select',
      required: true,
      options: [
        { value: 'America/Manaus', label: 'Manaus · UTC−4' },
        { value: 'America/Sao_Paulo', label: 'Brasília · UTC−3' },
        { value: 'America/Belem', label: 'Belém · UTC−3' },
        { value: 'America/Fortaleza', label: 'Fortaleza · UTC−3' },
        { value: 'America/Cuiaba', label: 'Cuiabá · UTC−4' },
        { value: 'America/Rio_Branco', label: 'Rio Branco · UTC−5' },
        { value: 'America/Noronha', label: 'Fernando de Noronha · UTC−2' },
      ],
    },
    {
      name: 'visitorOverstayHours',
      label: 'Alerta de permanência de visitante (horas)',
      type: 'number',
      min: '1',
      max: '8760',
      step: '1',
      required: true,
    },
    {
      name: 'openingTime',
      label: 'Horário de abertura',
      type: 'time',
      hint: 'Deixe abertura e encerramento vazios para operação 24 horas.',
    },
    { name: 'closingTime', label: 'Horário de encerramento', type: 'time' },
    {
      name: 'gates',
      label: 'Portarias da unidade',
      type: 'textarea',
      required: true,
      full: true,
      hint: 'Uma portaria por linha.',
    },
  ];
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const payload = {
        unitName: v.unitName,
        timezone: v.timezone,
        visitorOverstayHours: Number(v.visitorOverstayHours),
        gateNames: String(v.gates)
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        openingTime: v.openingTime || '',
        closingTime: v.closingTime || '',
      };
      if (await onSave('SETTINGS_UPDATE', payload, expectedRevision)) {
        setSaved(true);
        setExpectedRevision(expectedRevision + 1);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Falha ao salvar.');
      if ((error as Row)?.code === 'CONFLICT') setConflict(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="card" onSubmit={save}>
      <div className="card-header">
        <h2 className="card-title">Dados da unidade</h2>
      </div>
      <div className="card-body">
        <div className="form-grid">
          {fields.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={v[field.name]}
              onChange={(name, value) => {
                setV({ ...v, [name]: value });
                setSaved(false);
              }}
            />
          ))}
        </div>
        {error && (
          <div className="notice error" role="alert">
            <CircleAlert size={18} />
            {error}
          </div>
        )}
        {conflict && (
          <div className="notice warning">
            <History size={18} />
            <div>
              Os dados da unidade foram alterados. Revise a configuração atual antes de reenviar.
              <Button
                variant="small"
                onClick={() => {
                  setExpectedRevision(revision);
                  setConflict(false);
                  setError('');
                }}
              >
                Revisei os dados atuais
              </Button>
            </div>
          </div>
        )}
        {saved && (
          <div className="notice success" role="status">
            <CircleCheck size={18} />
            Configurações salvas.
          </div>
        )}
        <div className="settings-form-footer">
          <span className="field-hint">As alterações ficam registradas na auditoria.</span>
          <Button type="submit" variant="primary" disabled={disabled || saving || conflict}>
            {saving ? <LoaderCircle className="spinning" size={17} /> : <Check size={17} />}
            Salvar configurações
          </Button>
        </div>
      </div>
    </form>
  );
}
