'use client';

import {
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Contact,
  FileText,
  History,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  Pencil,
  Printer,
  ShieldCheck,
  UserRound,
  WifiOff,
} from 'lucide-react';
import React, { useRef, useState } from 'react';
import { request as fetch } from '../lib/http-client';
import type { SessionUser } from '../lib/operational-types';
import { PASSWORD_MIN_LENGTH } from '../lib/password-policy.mjs';
import { getReportDefinition } from '../lib/report-catalog.mjs';
import { personCategories } from './access-panels';
import { canDecide, useApprovers } from './access-support';
import { BrandMark } from './brand-mark';
import { FormStepNavigation, useFormSteps } from './form-steps';
import { allowed, capability } from './operations-panels';
import { PrintTable, printNow, reportColumns } from './portal-reports';
import {
  Dialog,
  Field,
  FieldDef,
  Modal,
  PortState,
  Role,
  Row,
  Status,
  User,
  actionLabel,
  asIso,
  attemptKey,
  dt,
  localDate,
  normalize,
  roleNames,
} from './portal-shared';
import type { PortalResponse } from './portal-types';
import { Button, FormSection } from './ui';
import { VisitorCamera } from './visitor-camera';
import { VisitorFaceNotice } from './visitor-face-notice';
import { PersonPicker } from './person-picker';

export function OperationDialog({
  dialog,
  state,
  user,
  tz,
  online,
  close,
  command,
  userCommand,
  loadState,
  revision,
  onDone,
  open,
  portoEnabled = false,
}: {
  dialog: Dialog;
  state: PortState;
  user: User;
  tz: string;
  online: boolean;
  close: () => void;
  command: (t: string, p: Record<string, unknown>, expectedRevision?: number) => Promise<boolean>;
  userCommand: (p: Record<string, unknown>) => Promise<boolean>;
  loadState: () => Promise<void>;
  revision: number;
  onDone: (s: string) => void;
  open: (d: Dialog) => void;
  portoEnabled?: boolean;
}) {
  const roleOptions = Object.entries(roleNames)
    .filter(([value]) => value !== 'finance' || portoEnabled)
    .map(([value, label]) => ({
      value,
      label: value === 'finance' ? 'Financeiro do Porto' : label,
    }));
  const original = dialog.row || {},
    kind = dialog.kind,
    action = dialog.action || '',
    masterKind = dialog.masterKind || original.masterKind || 'people';
  const collection = (
    { visitors: state.visitors, vehicles: state.vehicles } as Record<string, Row[]>
  )[action];
  const r =
    (kind === 'detail' ? collection?.find((x: Row) => x.id === original.id) : null) || original;
  const [seed] = useState<Partial<Row>>(() => {
    const initial: Partial<Row> = {
      category: 'visitor',
      ...r,
      existingId: kind === 'visitor' ? r.personId || '' : '',
      gateName: state.settings.gateNames.includes(r.gateName ?? '')
        ? r.gateName
        : state.settings.gateNames[0] || '',
      expectedAt: localDate(undefined, tz),
      validUntil: localDate(new Date(Date.now() + 8 * 3600000).toISOString(), tz),
      reason: '',
      confirmation: '',
      role: r.role || 'reader',
      status: r.status === 'pending' ? 'active' : r.status || 'active',
    };
    if (kind === 'master' && masterKind === 'people' && capability(user, 'accessManage') && !r.id)
      initial.securityStatus = 'pending';
    if (kind === 'correction') {
      Object.assign(initial, r);
    }
    if (kind === 'visitor')
      initial.initialGateAccess =
        user?.role === 'gate' &&
        capability(user, 'gateOperate') &&
        capability(user, 'documentView');
    return initial;
  });
  const [v, setV] = useState<Partial<Row>>(seed),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [expectedRevision, setExpectedRevision] = useState(revision),
    [conflict, setConflict] = useState(false),
    [backup, setBackup] = useState<{
      exportedAt: string;
      state: PortState;
      format: string;
      version: number;
    } | null>(null),
    [fileName, setFileName] = useState('');
  const [visitorPhoto, setVisitorPhoto] = useState<File | null>(null),
    uploadedPhoto = useRef<{ id: string; revision: number } | null>(null);
  const restoreKeys = useRef(new Map<string, string>()),
    approvers = useApprovers(),
    formRef = useRef<HTMLFormElement>(null);
  const change = (name: string, value: unknown) => {
    setError('');
    if (name === 'existingId') {
      setVisitorPhoto(null);
      uploadedPhoto.current = null;
    }
    setV((prev) => {
      let next = { ...prev, [name]: value };
      if (['existingId', 'name', 'company', 'initialGateAccess'].includes(name))
        next.identityConfirmed = false;
      if (name === 'existingId') {
        if (kind === 'visitor') {
          const p = state.people.find((p) => p.id === value);
          if (p)
            next = {
              ...next,
              name: p.name,
              company: p.company || '',
              host: p.host || '',
              category: p.category || 'visitor',
              documentLast4: p.documentLast4 || '',
            };
          else
            next = {
              ...next,
              name: '',
              company: '',
              host: '',
              category: 'visitor',
              documentLast4: '',
            };
        }
        if (kind === 'vehicle') {
          const p = state.fleet.find((p) => p.id === value);
          if (p)
            next = {
              ...next,
              plate: p.plate,
              driver: p.driver || '',
              company: p.company || '',
            };
        }
      }
      if (name === 'areaId' && kind === 'visitor') {
        const area = (state.accessAreas || []).find((area: Row) => area.id === value);
        next = {
          ...next,
          responsibleUserId: area?.responsibleUserId || '',
          substituteUserId: area?.substituteUserId || '',
        };
        const responsible = approvers.users.find(
          (u: SessionUser) => u.id === area?.responsibleUserId,
        );
        if (responsible) next.host = responsible.name;
      }
      if (name === 'responsibleUserId') {
        const responsible = approvers.users.find((u: SessionUser) => u.id === value);
        if (responsible) next.host = responsible.name;
        if (next.substituteUserId === value) next.substituteUserId = '';
      }
      if (name === 'driverPersonId' && kind === 'vehicle') {
        const person = state.people.find((p) => p.id === value);
        if (person) next = { ...next, driver: person.name };
      }
      return next;
    });
  };
  const gate: FieldDef = {
    disabled: kind === 'visitor' && v.initialGateAccess,
    name: 'gateName',
    label: 'Portaria',
    type: 'select',
    required: true,
    options: state.settings.gateNames.map((s: string) => ({
      value: s,
      label: s,
    })),
  };
  const existing = (rows: Row[], label: string, nameField = 'name'): FieldDef => ({
    name: 'existingId',
    label,
    type: 'select',
    full: true,
    options: [
      { value: '', label: 'Preencher manualmente' },
      ...rows
        .filter((p) => p.active !== false)
        .map((p) => ({
          value: p.id,
          label: p[nameField] + (p.company ? ' · ' + p.company : ''),
        })),
    ],
  });
  let title = '',
    fields: FieldDef[] = [],
    submit = 'Salvar registro',
    intro: React.ReactNode = null;
  if (kind === 'visitor') {
    title = 'Nova solicitação de visita';
    submit = v.initialGateAccess ? 'Autorizar portaria' : 'Enviar para autorização';
    fields = [
      existing(
        v.initialGateAccess
          ? state.people.filter((person) => person.category === 'visitor')
          : state.people,
        'Reaproveitar pessoa cadastrada',
      ),
      { name: 'name', label: 'Nome completo', required: true },
      {
        name: 'documentLast4',
        label: 'Últimos 4 dígitos do documento',
        hint: 'Opcional. Não informe CPF ou RG completo.',
      },
      {
        name: 'category',
        label: 'Tipo de pessoa',
        type: 'select',
        options: personCategories.filter(
          (c) => capability(user, 'accessManage') || c.value !== 'employee' || !!v.existingId,
        ),
      },
      {
        name: 'company',
        label: 'Empresa / origem',
        required: true,
        list: 'companies',
      },
      {
        name: 'areaId',
        label: 'Setor de destino',
        type: 'select',
        required: !!state.accessAreas?.some((a: Row) => a.active),
        options: [
          { value: '', label: 'Selecione o setor' },
          ...(state.accessAreas || [])
            .filter((a: Row) => a.active)
            .map((a: Row) => ({
              value: a.id,
              label: a.name + (a.restricted ? ' · área restrita' : ''),
            })),
        ],
      },
      {
        name: 'responsibleUserId',
        label: 'Usuário responsável pela aprovação',
        type: 'select',
        disabled:
          user.role === 'gate' &&
          !!(state.accessAreas || []).find((area: Row) => area.id === v.areaId)?.responsibleUserId,
        required: !!(state.accessAreas || []).find((area: Row) => area.id === v.areaId)
          ?.responsibleUserId,
        options: [
          { value: '', label: 'Sem responsável vinculado (diretoria)' },
          ...approvers.users.map((u: SessionUser) => ({ value: u.id, label: u.name })),
        ],
      },
      {
        name: 'substituteUserId',
        label: 'Substituto do responsável',
        type: 'select',
        disabled:
          user.role === 'gate' &&
          !!(state.accessAreas || []).find((area: Row) => area.id === v.areaId)?.responsibleUserId,
        options: [
          { value: '', label: 'Sem substituto' },
          ...approvers.users
            .filter((u: SessionUser) => u.id !== v.responsibleUserId)
            .map((u: SessionUser) => ({ value: u.id, label: u.name })),
        ],
      },
      {
        name: 'host',
        label: 'Responsável / contato na unidade',
        required: true,
        hint: 'O usuário selecionado receberá a pendência de autorização.',
      },
      {
        name: 'purpose',
        label: 'Motivo da visita',
        type: 'textarea',
        required: true,
        full: true,
      },
      {
        name: 'expectedAt',
        label: 'Previsão de entrada',
        type: 'datetime-local',
        required: true,
      },
      {
        name: 'validUntil',
        label: 'Autorização válida até',
        type: 'datetime-local',
        required: true,
      },
      gate,
      { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ];
    intro = (
      <div className="notice info">
        <ShieldCheck size={18} />
        Responsável ou substituto autoriza. A portaria confere identidade e validade antes da
        entrada.
      </div>
    );
  }
  if (kind === 'vehicle') {
    title = 'Registrar entrada de veículo';
    submit = 'Confirmar entrada';
    fields = [
      existing(state.fleet, 'Reaproveitar veículo cadastrado', 'plate'),
      {
        name: 'plate',
        label: 'Placa',
        required: true,
        hint: 'Placa sem espaços ou hífen.',
      },
      {
        name: 'driverPersonId',
        label: 'Motorista no cadastro de pessoas',
        type: 'select',
        options: [
          { value: '', label: 'Selecionar pessoa (opcional)' },
          ...state.people
            .filter((p) => p.active !== false)
            .map((p) => ({ value: p.id, label: p.name })),
        ],
      },
      { name: 'driver', label: 'Motorista', required: true },
      {
        name: 'company',
        label: 'Empresa / origem',
        required: true,
        list: 'companies',
      },
      { name: 'host', label: 'Responsável na unidade' },
      gate,
      {
        name: 'visitorId',
        label: 'Vincular visitante',
        type: 'select',
        options: [
          { value: '', label: 'Sem vínculo' },
          ...state.visitors
            .filter((s) => ['authorized', 'inside'].includes(s.status))
            .map((s) => ({ value: s.id, label: s.name })),
        ],
      },
      { name: 'cargo', label: 'Carga / operação' },
      {
        name: 'purpose',
        label: 'Motivo da entrada',
        type: 'textarea',
        required: true,
        full: true,
      },
      { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    ];
    intro = (
      <div className="notice info">
        <Clock3 size={18} />A entrada será registrada com o horário do servidor. A saída do veículo
        é independente da saída do visitante.
      </div>
    );
  }

  if (kind === 'reason') {
    title = actionLabel(action);
    submit = 'Confirmar com justificativa';
    fields = [
      {
        name: 'reason',
        label: 'Justificativa',
        type: 'textarea',
        required: true,
        full: true,
        hint: 'O motivo fica registrado no histórico e na auditoria.',
      },
    ];
    intro = (
      <div className="notice warning">
        <CircleAlert size={19} />
        <div>{r.name || r.plate}</div>
      </div>
    );
  }
  if (kind === 'confirm') {
    title = actionLabel(action);
    submit = 'Confirmar';
    if (action === 'VISITOR_CHECKIN')
      fields = [
        gate,
        ...(state.visitors.some(
          (old) =>
            old.id !== r.id &&
            old.status === 'unconfirmed' &&
            ((r.personId && old.personId === r.personId) ||
              ((!r.personId || !old.personId) &&
                normalize(old.name) === normalize(r.name) &&
                normalize(old.company) === normalize(r.company))),
        )
          ? [
              {
                name: 'reconciliationReason',
                label: 'Justificativa da reconciliação',
                type: 'textarea',
                required: true,
                full: true,
                hint: 'A entrada anterior continuará sem horário de saída.',
              } as FieldDef,
            ]
          : []),
      ];
    intro = (
      <div className="confirmation-summary">
        <span className="initials">
          <ShieldCheck size={25} />
        </span>
        <h3>{r.name || r.plate}</h3>
        <p>{r.company || r.driver}</p>
        <p>
          {action.includes('CHECK') || action === 'VEHICLE_EXIT'
            ? 'O horário será registrado pelo servidor.'
            : 'Confirme a autorização para o período solicitado.'}
        </p>
        {action === 'VISITOR_CHECKIN' && (
          <p>
            Portaria de entrada: <strong>{v.gateName}</strong>
          </p>
        )}
        {r.expectedAt && (
          <p className="field-hint">
            {dt(r.expectedAt, tz)} até {dt(r.validUntil, tz)}
          </p>
        )}
      </div>
    );
  }

  if (kind === 'invite') {
    title = 'Criar usuário local';
    submit = 'Cadastrar usuário';
    fields = [
      { name: 'name', label: 'Nome completo', required: true },
      { name: 'email', label: 'E-mail', type: 'email', required: true },
      {
        name: 'username',
        label: 'Usuário para login',
        required: true,
        hint: '3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.',
      },
      {
        name: 'password',
        label: 'Senha inicial',
        type: 'password',
        required: true,
        hint: `Mínimo ${PASSWORD_MIN_LENGTH} caracteres. O usuário deverá trocar esta senha no primeiro acesso.`,
      },
      {
        name: 'role',
        label: 'Perfil de acesso',
        type: 'select',
        required: true,
        options: roleOptions,
        full: true,
      },
    ];
    intro = (
      <div className="notice info">
        <LockKeyhole size={18} />
        Crie um acesso próprio. A senha será armazenada como hash; não será enviada por e-mail.
      </div>
    );
  }
  if (kind === 'password-reset') {
    title = 'Redefinir senha';
    submit = 'Redefinir senha';
    fields = [
      {
        name: 'password',
        label: 'Nova senha',
        type: 'password',
        required: true,
        hint: `Mínimo de ${PASSWORD_MIN_LENGTH} caracteres. Todas as sessões desse usuário serão encerradas.`,
      },
    ];
    intro = (
      <div className="notice warning">
        <LockKeyhole size={18} />A senha anterior deixará de funcionar. Informe a nova senha ao
        operador de forma segura.
      </div>
    );
  }
  if (kind === 'user') {
    title = 'Editar perfil de acesso';
    submit = 'Salvar permissões';
    fields = [
      {
        name: 'role',
        label: 'Perfil',
        type: 'select',
        required: true,
        options:
          r.role === 'finance' && !portoEnabled
            ? [
                {
                  value: 'finance',
                  label: 'Perfil histórico (somente consulta)',
                },
                ...roleOptions,
              ]
            : roleOptions,
      },
      {
        name: 'status',
        label: 'Situação',
        type: 'select',
        required: true,
        options: [
          { value: 'active', label: 'Ativo' },
          { value: 'pending', label: 'Pendente de análise' },
          { value: 'disabled', label: 'Desativado' },
        ],
      },
    ];
    intro = (
      <div className="notice info">
        <UserRound size={19} />
        <div>
          <strong>{r.name}</strong>
          <br />
          {r.email}
        </div>
      </div>
    );
  }
  if (kind === 'revoke-invite') {
    title = 'Revogar acesso pré-cadastrado';
    submit = 'Revogar acesso';
    intro = (
      <div className="notice warning">
        <Ban size={20} />
        <div>
          Remover o acesso pré-cadastrado de <strong>{r.email}</strong>?
        </div>
      </div>
    );
  }
  if (kind === 'master-toggle') {
    title = r.active === false ? 'Reativar cadastro' : 'Desativar cadastro';
    submit = 'Confirmar';
    intro = (
      <div className="notice info">
        <Contact size={20} />
        <div>
          {r.name || r.plate}
          <p>
            {r.active === false
              ? 'O cadastro ficará disponível para novos registros.'
              : 'O cadastro deixará de aparecer nos novos registros. O histórico permanece preservado.'}
          </p>
        </div>
      </div>
    );
  }
  if (kind === 'master') {
    const labels: Record<string, string> = {
      people: 'pessoa',
      fleet: 'veículo',
      companies: 'empresa',
    };
    title = (r.id ? 'Editar ' : 'Cadastrar ') + labels[masterKind];
    fields =
      masterKind === 'fleet'
        ? [
            { name: 'plate', label: 'Placa', required: true },
            { name: 'name', label: 'Descrição do veículo' },
            { name: 'driver', label: 'Motorista habitual' },
            { name: 'company', label: 'Empresa', list: 'companies' },
          ]
        : [
            {
              name: 'name',
              label: masterKind === 'people' ? 'Nome completo' : 'Nome',
              required: true,
              full: true,
            },
            ...(masterKind === 'people'
              ? [
                  {
                    name: 'category',
                    label: 'Tipo de pessoa',
                    type: 'select',
                    options: personCategories.filter(
                      (c) =>
                        capability(user, 'accessManage') ||
                        c.value !== 'employee' ||
                        r.category === 'employee',
                    ),
                  },
                  {
                    name: 'documentLast4',
                    label: 'Últimos 4 dígitos do documento',
                    hint: 'Opcional. Informe apenas quatro dígitos.',
                  },
                  { name: 'company', label: 'Empresa', list: 'companies' },
                  { name: 'host', label: 'Responsável habitual na unidade' },
                  ...(capability(user, 'accessManage')
                    ? [
                        {
                          name: 'securityStatus',
                          label: 'Requisitos de segurança',
                          type: 'select',
                          options: [
                            { value: 'cleared', label: 'Liberados' },
                            { value: 'pending', label: 'Validação pendente' },
                            { value: 'blocked', label: 'Acesso bloqueado' },
                          ],
                        },
                        {
                          name: 'restrictions',
                          label: 'Restrições de acesso',
                          type: 'textarea',
                          full: true,
                        },
                      ]
                    : []),
                ]
              : []),
          ];
    fields.push(
      { name: 'contact', label: 'Contato responsável' },
      { name: 'phone', label: 'Telefone', type: 'tel' },
      { name: 'email', label: 'E-mail de contato', type: 'email' },
      { name: 'notes', label: 'Observações', type: 'textarea', full: true },
    );
    intro = (
      <div className="notice info">
        <Contact size={18} />
        Informe apenas os dados necessários para a operação. Cadastros podem ser desativados sem
        apagar o histórico.
      </div>
    );
  }
  if (kind === 'correction') {
    title = 'Corrigir informações do registro';
    submit = 'Salvar correção';
    const entity = action;
    fields =
      entity === 'visitor'
        ? [
            { name: 'name', label: 'Nome', required: true },
            { name: 'company', label: 'Empresa', required: true },
            { name: 'host', label: 'Responsável', required: true },
            ...(['pending', 'authorized'].includes(r.status ?? '')
              ? [
                  {
                    name: 'responsibleUserId',
                    label: 'Usuário responsável pela aprovação',
                    type: 'select',
                    options: [
                      { value: '', label: 'Diretoria (sem vínculo)' },
                      ...approvers.users.map((u: SessionUser) => ({
                        value: u.id,
                        label: u.name,
                      })),
                    ],
                  },
                  {
                    name: 'substituteUserId',
                    label: 'Substituto do responsável',
                    type: 'select',
                    options: [
                      { value: '', label: 'Sem substituto' },
                      ...approvers.users
                        .filter((u: SessionUser) => u.id !== v.responsibleUserId)
                        .map((u: SessionUser) => ({ value: u.id, label: u.name })),
                    ],
                  },
                ]
              : []),
            {
              name: 'purpose',
              label: 'Motivo da visita',
              required: true,
              type: 'textarea',
              full: true,
            },
          ]
        : [
            { name: 'driver', label: 'Motorista', required: true },
            { name: 'company', label: 'Empresa', required: true },
            { name: 'host', label: 'Responsável' },
            {
              name: 'purpose',
              label: 'Motivo',
              required: true,
              type: 'textarea',
              full: true,
            },
          ];
    fields.push(
      { name: 'notes', label: 'Observações', type: 'textarea', full: true },
      {
        name: 'reason',
        label: 'Justificativa da correção',
        required: true,
        type: 'textarea',
        full: true,
      },
    );
    intro = (
      <div className="notice info">
        <History size={19} />A correção fica auditada. Os horários efetivos de entrada e saída são
        preservados.
      </div>
    );
  }
  if (kind === 'restore') {
    title = 'Revisar e restaurar backup';
    submit = 'Restaurar dados';
    fields = [
      {
        name: 'reason',
        label: 'Justificativa da restauração',
        type: 'textarea',
        required: true,
        full: true,
      },
      {
        name: 'confirmation',
        label: 'Digite RESTAURAR para confirmar',
        required: true,
        full: true,
      },
    ];
    intro = (
      <div className="notice warning">
        <CircleAlert size={20} />
        <div>
          Esta ação substitui configurações, cadastros e registros operacionais. O sistema valida o
          arquivo e registra a restauração na auditoria. Exporte uma cópia atual antes de continuar.
        </div>
      </div>
    );
  }
  if (kind === 'visitor' && v.initialGateAccess) {
    intro = (
      <div className="notice info">
        <ShieldCheck size={18} />O porteiro autoriza esta visita somente na portaria. A foto será
        salva; o envio facial ainda está pendente de integração.
      </div>
    );
    fields = fields.map((field) =>
      field.name === 'category'
        ? {
            ...field,
            disabled: true,
            options: [{ value: 'visitor', label: 'Visitante' }],
          }
        : field.name === 'host'
          ? {
              ...field,
              hint: 'Contato de referência. Esta autorização vale somente para a portaria.',
            }
          : ['areaId', 'responsibleUserId', 'substituteUserId'].includes(field.name)
            ? {
                ...field,
                disabled: true,
                required: false,
                options: [
                  {
                    value: String(v[field.name] ?? ''),
                    label:
                      field.name === 'areaId'
                        ? 'Somente portaria'
                        : 'Dispensado na liberação inicial',
                  },
                ],
              }
            : field,
    );
  }
  const sharedAccess = [
    'areaId',
    'responsibleUserId',
    'substituteUserId',
    'host',
    'gateName',
    'visitorId',
    'securityStatus',
    'restrictions',
  ];
  const sharedOperation = ['cargo', 'purpose', 'expectedAt', 'validUntil', 'notes', 'reason'];
  const contact = ['contact', 'phone', 'email', 'notes'];
  const groupSpecs =
    kind === 'master'
      ? [
          {
            title:
              masterKind === 'people'
                ? 'Identificação da pessoa'
                : masterKind === 'fleet'
                  ? 'Identificação do veículo'
                  : 'Identificação da empresa',
            shortTitle:
              masterKind === 'people' ? 'Pessoa' : masterKind === 'fleet' ? 'Veículo' : 'Empresa',
            names: fields
              .map((f) => f.name)
              .filter((name) => !contact.includes(name) && !sharedAccess.includes(name)),
          },
          {
            title: 'Segurança e destino',
            shortTitle: 'Segurança',
            names: sharedAccess,
          },
          {
            title: 'Contato e observações',
            shortTitle: 'Contato',
            names: contact,
          },
        ]
      : [
          {
            title: kind === 'vehicle' ? 'Veículo e condutor' : 'Identificação da pessoa',
            shortTitle: kind === 'vehicle' ? 'Veículo' : 'Pessoa',
            names: fields
              .map((f) => f.name)
              .filter((name) => !sharedAccess.includes(name) && !sharedOperation.includes(name)),
          },
          {
            title: 'Destino e autorização',
            shortTitle: 'Acesso',
            names: sharedAccess,
          },
          {
            title: kind === 'vehicle' ? 'Informações da operação' : 'Período e motivo da visita',
            shortTitle: kind === 'vehicle' ? 'Operação' : 'Visita',
            names: sharedOperation,
          },
        ];
  const groups = groupSpecs
    .map((group) => ({
      ...group,
      fields: fields.filter((field) => group.names.includes(field.name)),
    }))
    .filter((group) => group.fields.length);
  const formSteps = useFormSteps(
    formRef,
    groups.length,
    ['visitor', 'vehicle', 'master'].includes(kind) && groups.length > 1,
  );
  const optionalFields = (index: number) =>
    index === 0
      ? kind === 'visitor'
        ? ['category', 'documentLast4']
        : kind === 'vehicle'
          ? ['driverPersonId']
          : []
      : [];
  const submitCommand = (type: string, payload: Record<string, unknown>) =>
    command(type, payload, expectedRevision);
  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (!formSteps.beforeSubmit()) return;
    setError('');
    setSaving(true);
    try {
      let ok = false;
      if (kind === 'visitor') {
        if (v.initialGateAccess && !visitorPhoto) {
          formSteps.go(0);
          throw new Error('Fotografe o visitante para autorizar a entrada inicial na portaria.');
        }
        let photo = uploadedPhoto.current,
          photoJustUploaded = false;
        if (visitorPhoto && !photo) {
          const form = new FormData();
          form.set('file', visitorPhoto);
          const response = await fetch('/api/visitor-photos', {
              method: 'POST',
              body: form,
            }),
            data = (await response.json()) as PortalResponse;
          if (!response.ok)
            throw new Error(data.error?.message || 'Não foi possível salvar a foto.');
          if (!data.attachment) throw Error('Foto não confirmada pelo servidor.');
          photo = { id: data.attachment.id, revision: data.revision };
          uploadedPhoto.current = photo;
          photoJustUploaded = true;
          setExpectedRevision(data.revision);
        }
        const payload = {
          ...v,
          personId: v.existingId || undefined,
          expectedAt: asIso(v.expectedAt ?? '', tz),
          validUntil: asIso(v.validUntil ?? '', tz),
          photoAttachmentId: photo?.id,
          ...(v.initialGateAccess
            ? {
                category: 'visitor',
                areaId: null,
                responsibleUserId: null,
                substituteUserId: null,
                gateName: state.settings.gateNames[0],
              }
            : {}),
        };
        ok = await command(
          v.initialGateAccess ? 'VISITOR_GATE_REGISTER' : 'VISITOR_REQUEST',
          payload,
          photoJustUploaded ? photo!.revision : expectedRevision,
        );
      } else if (kind === 'vehicle')
        ok = await submitCommand('VEHICLE_ENTER', {
          ...v,
          fleetId: v.existingId || undefined,
          visitorId: v.visitorId || undefined,
        });
      else if (kind === 'confirm' || kind === 'reason')
        ok = await submitCommand(action, {
          id: r.id,
          reason: v.reason,
          ...(action === 'VISITOR_CHECKIN'
            ? {
                gateName: v.gateName,
                reconciliationReason: v.reconciliationReason,
                identityConfirmed: v.identityConfirmed === true,
              }
            : {}),
        });
      else if (kind === 'master')
        ok = await submitCommand('MASTER_SAVE', {
          kind: masterKind,
          record: { ...v, id: r.id || undefined, active: r.active !== false },
        });
      else if (kind === 'master-toggle')
        ok = await submitCommand('MASTER_SAVE', {
          kind: r.masterKind,
          record: { ...r, active: r.active === false },
        });
      else if (kind === 'invite')
        ok = await userCommand({
          action: 'create_local',
          name: v.name,
          email: v.email,
          username: v.username,
          password: v.password,
          role: v.role,
        });
      else if (kind === 'password-reset')
        ok = await userCommand({
          action: 'reset_password',
          id: r.id,
          password: v.password,
        });
      else if (kind === 'user')
        ok = await userCommand({
          action: 'update',
          id: r.id,
          role: v.role,
          status: v.status,
        });
      else if (kind === 'revoke-invite')
        ok = await userCommand({ action: 'revoke_invite', id: r.id });
      else if (kind === 'correction') {
        const changes: Record<string, unknown> = {};
        fields
          .filter((f) => f.name !== 'reason')
          .forEach((f) => {
            changes[f.name] = v[f.name] || '';
          });
        if (action === 'vehicle' && !v.host) delete changes.host;
        ok = await submitCommand('RECORD_CORRECT', {
          kind: action,
          id: r.id,
          reason: v.reason,
          changes,
        });
      } else if (kind === 'restore') {
        if (!backup) throw new Error('Selecione um arquivo de backup válido.');
        if (v.confirmation !== 'RESTAURAR') throw new Error('Digite RESTAURAR para confirmar.');
        const restoreSignature = JSON.stringify({ backup, reason: v.reason }),
          idempotencyKey = attemptKey(restoreKeys.current, restoreSignature),
          response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              revision: expectedRevision,
              backup,
              reason: v.reason,
              idempotencyKey,
            }),
          }),
          d = (await response.json()) as PortalResponse;
        if (response.status === 409) {
          await loadState();
          throw Object.assign(new Error('A operação foi alterada. Revise e confirme novamente.'), {
            code: 'CONFLICT',
          });
        }
        if (!response.ok) throw new Error(d.error?.message || 'Não foi possível restaurar.');
        restoreKeys.current.delete(restoreSignature);
        await loadState();
        onDone('Backup restaurado e registrado na auditoria.');
        ok = true;
      }
      if (ok) close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar. Tente novamente.');
      if ((err as Row)?.code === 'CONFLICT') setConflict(true);
    } finally {
      setSaving(false);
    }
  }
  if (kind === 'detail') {
    const visitor = action === 'visitors',
      entity = visitor ? 'visitor' : 'vehicle',
      items: Record<string, unknown> = visitor
        ? {
            Visitante: r.name,
            ...(r.initialAccessScope
              ? {
                  'Escopo da autorização': 'Somente catraca da portaria',
                  'Cadastro facial': 'Pendente de integração e confirmação no equipamento',
                }
              : {}),
            Empresa: r.company,
            Motivo: r.purpose,
            Responsável: r.host,
            'Setor de destino':
              state.accessAreas?.find((a: Row) => a.id === r.areaId)?.name || 'Não informado',
            Portaria: r.gateName,
            'Documento (final)': state.documentRestricted
              ? 'Acesso restrito'
              : r.documentLast4 || 'Não informado',
            Previsão: dt(r.expectedAt, tz),
            Validade: dt(r.validUntil, tz),
            'Solicitado por': r.requestedBy,
            'Autorizado por': r.approvedBy || '—',
            Entrada: dt(r.enteredAt, tz),
            Saída: dt(r.leftAt, tz),
            ...(r.identityReconfirmedAt
              ? {
                  'Identidade reconferida':
                    dt(r.identityReconfirmedAt, tz) + ' · ' + (r.identityReconfirmedBy || '—'),
                }
              : {}),
          }
        : {
            Placa: r.plate,
            Motorista: r.driver,
            Empresa: r.company,
            Motivo: r.purpose,
            Responsável: r.host || '—',
            Portaria: r.gateName,
            Entrada: dt(r.entryAt, tz),
            Saída: dt(r.exitAt, tz),
            'Registrado por': r.enteredBy,
            'Motorista cadastrado':
              state.people.find((p) => p.id === r.driverPersonId)?.name || 'Não vinculado',
            Acompanhantes:
              (r.occupantPersonIds || [])
                .map((id: string) => state.people.find((p) => p.id === id)?.name || id)
                .join(', ') || 'Nenhum',
            'Carga / operação': r.cargo || 'Não informada',
          };
    return (
      <Modal title={visitor ? 'Detalhes da visita' : 'Detalhes do veículo'} onClose={close} wide>
        <div className="modal-body" tabIndex={0} role="region" aria-label="Informações do registro">
          <div className="detail-status">
            <Status
              value={r.status ?? ''}
              facePending={r.initialAccessScope === 'gate_only' && r.status === 'authorized'}
            />
            <span className="cell-subtle mono">{r.id}</span>
          </div>
          {visitor && <VisitorFaceNotice visit={r} canView={capability(user, 'documentView')} />}
          <div className="detail-grid">
            {Object.entries(items).map(([label, value]) => (
              <div className="detail-item" key={label}>
                <span>{label}</span>
                <strong>{String(value ?? '—')}</strong>
              </div>
            ))}
          </div>
          {r.reason && (
            <div className="notice warning">
              <History size={18} />
              {r.reason}
            </div>
          )}
          {r.notes && (
            <div className="detail-notes">
              <span className="field-label">Observações</span>
              <p>{r.notes}</p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button onClick={close}>Fechar</Button>
          {allowed(user, 'RECORD_CORRECT') &&
            (user.role === 'admin' || (user.role === 'director' && visitor)) && (
              <Button
                disabled={!online}
                onClick={() => open({ kind: 'correction', row: r, action: entity })}
              >
                <Pencil size={16} />
                Corrigir informações
              </Button>
            )}
          {visitor &&
            r.status === 'authorized' &&
            r.initialAccessScope === 'gate_only' &&
            allowed(user, 'VISITOR_GATE_REVOKE') &&
            (user.role === 'admin' || r.initialApprovedById === user.id) && (
              <Button
                disabled={!online}
                onClick={() =>
                  open({
                    kind: 'reason',
                    row: r,
                    action: 'VISITOR_GATE_REVOKE',
                  })
                }
              >
                Cancelar liberação inicial
              </Button>
            )}
          {visitor && r.status === 'pending' && canDecide(user, r) && (
            <Button
              variant="primary"
              disabled={!online}
              onClick={() => open({ kind: 'confirm', row: r, action: 'VISITOR_APPROVE' })}
            >
              <ShieldCheck size={16} />
              Autorizar acesso
            </Button>
          )}
          {visitor && r.status === 'authorized' && allowed(user, 'VISITOR_CHECKIN') && (
            <Button
              variant="primary"
              disabled={!online}
              onClick={() => open({ kind: 'confirm', row: r, action: 'VISITOR_CHECKIN' })}
            >
              <LogIn size={16} />
              Registrar entrada
            </Button>
          )}
          {visitor && r.status === 'inside' && allowed(user, 'VISITOR_CHECKOUT') && (
            <Button
              variant="primary"
              disabled={!online}
              onClick={() => open({ kind: 'confirm', row: r, action: 'VISITOR_CHECKOUT' })}
            >
              <LogOut size={16} />
              Registrar saída
            </Button>
          )}
        </div>
      </Modal>
    );
  }

  if (kind === 'audit-detail')
    return (
      <Modal title="Detalhes da auditoria" onClose={close} wide>
        <div className="modal-body">
          <div className="notice info">
            <ShieldCheck size={20} />
            <div>
              <strong>{actionLabel(r.action ?? '')}</strong>
              <br />
              {dt(r.at, tz)} · {typeof r.actor === 'object' ? r.actor.name : r.actor} ·{' '}
              {roleNames[r.role as Role]}
            </div>
          </div>
          {r.reason && (
            <div className="detail-notes">
              <strong>Justificativa</strong>
              <p>{r.reason}</p>
            </div>
          )}
          {(r.changes || []).map((c, i: number) => (
            <div className="audit-detail" key={i}>
              <h3>
                {(
                  {
                    visitors: 'Visitantes',
                    vehicles: 'Veículos',
                    stays: 'Atracações',
                    settings: 'Configurações',
                    berths: 'Berços',
                    charges: 'Cobranças',
                  } as Record<string, string>
                )[c.kind] || c.kind}{' '}
                <small className="mono">{c.id}</small>
              </h3>
              <div className="audit-comparison">
                <div>
                  <span className="field-label">Antes</span>
                  <pre>{c.before ? JSON.stringify(c.before, null, 2) : 'Registro novo'}</pre>
                </div>
                <div>
                  <span className="field-label">Depois</span>
                  <pre>{c.after ? JSON.stringify(c.after, null, 2) : 'Registro removido'}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <Button onClick={close}>Fechar</Button>
        </div>
      </Modal>
    );

  if (kind === 'contingency' || kind === 'print-report') {
    const reportRows = r.rows || [],
      reportKind = r.kind || 'visitors';
    return (
      <Modal
        title={
          kind === 'contingency' ? 'Lista de presentes e contingência' : 'Relatório da operação'
        }
        onClose={close}
        wide
      >
        <div className="modal-body print-target" id="print-target">
          <div className="print-document-header">
            <div className="brand-print">
              <BrandMark size={25} />
              <strong>{state.settings.unitName}</strong>
            </div>
            <h2>
              {kind === 'contingency'
                ? 'Lista de presentes e contingência'
                : (getReportDefinition(reportKind)?.label ?? 'Relatório da operação')}
            </h2>
            <p>
              Gerado em {dt(new Date().toISOString(), tz)} · {tz}
            </p>
            {(r.from || r.to) && (
              <p>
                {r.from && 'Desde ' + r.from.split('-').reverse().join('/')}
                {r.from && r.to && ' · '}
                {r.to && 'Até ' + r.to.split('-').reverse().join('/')}
              </p>
            )}
            {kind === 'print-report' && r.description && <p>{r.description}</p>}
          </div>
          {kind === 'contingency' ? (
            <>
              <div className="notice warning">
                Retrato do último estado sincronizado. Registre ocorrências em papel e reconcilie os
                dados após a conexão voltar.
              </div>
              <h3 className="subsection-title">
                Pessoas no local · {state.visitors.filter((x) => x.status === 'inside').length}
              </h3>
              <PrintTable
                rows={state.visitors.filter((x) => x.status === 'inside')}
                columns={[
                  { title: 'Nome', raw: (x) => x.name },
                  { title: 'Empresa', raw: (x) => x.company },
                  { title: 'Responsável', raw: (x) => x.host },
                  {
                    title: 'Setor',
                    raw: (x) =>
                      state.accessAreas?.find((a: Row) => a.id === x.areaId)?.name ||
                      'Não informado',
                  },
                  { title: 'Conferência física', raw: () => '' },
                  { title: 'Entrada', raw: (x) => dt(x.enteredAt, tz) },
                  { title: 'Portaria', raw: (x) => x.gateName },
                ]}
              />
              <h3 className="subsection-title">
                Veículos no local · {state.vehicles.filter((x) => x.status === 'inside').length}
              </h3>
              <PrintTable
                rows={state.vehicles.filter((x) => x.status === 'inside')}
                columns={[
                  { title: 'Placa', raw: (x) => x.plate },
                  { title: 'Motorista', raw: (x) => x.driver },
                  { title: 'Empresa', raw: (x) => x.company },
                  { title: 'Entrada', raw: (x) => dt(x.entryAt, tz) },
                ]}
              />
              <h3 className="subsection-title">Ocorrências durante a contingência</h3>
              <PrintTable
                rows={Array.from({ length: 5 }, (_, i) => ({
                  id: String(i),
                  name: '',
                  status: '',
                }))}
                columns={[
                  { title: 'Horário', raw: () => '' },
                  { title: 'Nome / placa', raw: () => '' },
                  { title: 'Entrada / saída / ocorrência', raw: () => '' },
                  { title: 'Responsável', raw: () => '' },
                ]}
              />
            </>
          ) : (
            <PrintTable
              rows={reportRows}
              columns={reportColumns(reportKind, tz, user.capabilities)}
            />
          )}
          <div className="print-fineprint">
            Acesso restrito. Guarde este documento de acordo com a política de dados pessoais da
            unidade.
          </div>
        </div>
        <div className="modal-footer">
          <Button onClick={close}>Fechar</Button>
          <Button disabled={!capability(user, 'dataExport')} variant="primary" onClick={printNow}>
            <Printer size={16} />
            Imprimir lista
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={title || 'Registro'}
      onClose={() => {
        if (!saving) close();
      }}
      wide={['visitor', 'vehicle', 'master', 'correction', 'restore'].includes(kind)}
    >
      <form ref={formRef} noValidate={formSteps.enabled} onSubmit={submitForm}>
        {formSteps.enabled && (
          <FormStepNavigation
            titles={groups.map((group) => group.shortTitle)}
            current={formSteps.current}
            onSelect={formSteps.go}
            disabled={saving}
          />
        )}
        <div className="modal-body progressive-form-body">
          {intro}
          {kind === 'restore' && (
            <div className="backup-upload">
              <label htmlFor="backup-file" className="field-label">
                Arquivo de backup JSON
              </label>
              <input
                className="input"
                id="backup-file"
                type="file"
                accept="application/json,.json"
                onChange={async (e) => {
                  setError('');
                  setBackup(null);
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setFileName(file.name);
                  try {
                    if (file.size > 5 * 1024 * 1024 - 16 * 1024)
                      throw new Error('O arquivo excede o limite de 5 MB.');
                    const d = JSON.parse(await file.text());
                    if (
                      d.format !== 'porto-gestao-backup' ||
                      d.version !== 2 ||
                      !d.state ||
                      !Array.isArray(d.state.visitors) ||
                      !Array.isArray(d.state.charges)
                    )
                      throw new Error('Este arquivo não é um backup válido do Next Portaria v2.');
                    setBackup(d);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Arquivo inválido.');
                  }
                }}
              />
              {backup && (
                <div className="notice info">
                  <FileText size={19} />
                  <div>
                    <strong>{fileName}</strong>
                    <br />
                    Exportado em {dt(backup.exportedAt, tz)}
                    <br />
                    {backup.state.visitors.length} visitas · {backup.state.vehicles?.length || 0}{' '}
                    veículos · dados históricos preservados
                  </div>
                </div>
              )}
            </div>
          )}
          {['visitor', 'vehicle', 'master', 'correction'].includes(kind) ? (
            <div className={'form-sections ' + (kind === 'visitor' ? 'visitor-form' : '')}>
              {groups.map((group, index) => (
                <div
                  key={group.title}
                  data-form-step={index}
                  className={
                    kind === 'visitor' && group.shortTitle === 'Pessoa'
                      ? 'visitor-person-layout'
                      : undefined
                  }
                  hidden={formSteps.enabled && formSteps.current !== index}
                >
                  <FormSection title={group.title}>
                    {group.fields
                      .filter((f) => !optionalFields(index).includes(f.name))
                      .map((f) =>
                        kind === 'visitor' && f.name === 'existingId' ? (
                          <PersonPicker
                            key={f.name}
                            people={
                              v.initialGateAccess
                                ? state.people.filter((person) => person.category === 'visitor')
                                : state.people
                            }
                            value={typeof v.existingId === 'string' ? v.existingId : ''}
                            onChange={(id) => change('existingId', id)}
                            photos={capability(user, 'documentView')}
                            disabled={saving}
                          />
                        ) : f.name === 'notes' ? (
                          <details className="form-optional full" key={f.name}>
                            <summary>
                              Observações opcionais
                              {v.notes ? ' · preenchidas' : ''}
                            </summary>
                            <Field field={f} value={v[f.name]} onChange={change} />
                          </details>
                        ) : (
                          <Field key={f.name} field={f} value={v[f.name]} onChange={change} />
                        ),
                      )}
                    {optionalFields(index).length > 0 && (
                      <details className="form-optional full">
                        <summary>
                          {kind === 'visitor'
                            ? 'Classificação e documento · ' +
                              (personCategories.find((category) => category.value === v.category)
                                ?.label || 'Visitante')
                            : 'Vincular motorista cadastrado (opcional)'}
                        </summary>
                        <div className="form-grid">
                          {group.fields
                            .filter((f) => optionalFields(index).includes(f.name))
                            .map((f) => (
                              <Field key={f.name} field={f} value={v[f.name]} onChange={change} />
                            ))}
                        </div>
                      </details>
                    )}
                  </FormSection>
                  {kind === 'visitor' && group.shortTitle === 'Pessoa' && (
                    <div className="visitor-capture">
                      <label className="access-check visitor-gate-option">
                        <input
                          type="checkbox"
                          checked={!!v.initialGateAccess}
                          disabled={
                            !allowed(user, 'VISITOR_GATE_REGISTER') ||
                            !capability(user, 'documentView') ||
                            saving
                          }
                          onChange={(e) => {
                            if (
                              e.target.checked &&
                              v.existingId &&
                              state.people.find((person) => person.id === v.existingId)
                                ?.category !== 'visitor'
                            ) {
                              setError(
                                'A liberação inicial é exclusiva para visitantes. Selecione um visitante ou faça um novo cadastro.',
                              );
                              return;
                            }
                            change('initialGateAccess', e.target.checked);
                            if (e.target.checked) change('category', 'visitor');
                            change('gateName', state.settings.gateNames[0]);
                          }}
                        />
                        <span>
                          Autorizar acesso inicial somente na portaria
                          <small>
                            O porteiro autoriza esta visita. Outros setores continuam exigindo
                            autorização própria. A liberação facial aguarda confirmação da
                            integração.
                          </small>
                        </span>
                      </label>
                      {formSteps.current === index && (
                        <VisitorCamera
                          key={typeof v.existingId === 'string' ? v.existingId : 'new-visitor'}
                          enroll={!!v.initialGateAccess}
                          photo={visitorPhoto}
                          onPhoto={(file) => {
                            setVisitorPhoto(file);
                            uploadedPhoto.current = null;
                            setV((previous) => ({
                              ...previous,
                              identityConfirmed: false,
                            }));
                          }}
                          disabled={saving || !capability(user, 'documentView')}
                        />
                      )}
                    </div>
                  )}
                  {group.shortTitle === 'Acesso' && (
                    <>
                      {kind === 'vehicle' && (
                        <div className="v3-spaced">
                          <span className="field-label">Acompanhantes cadastrados</span>
                          <div className="access-person-checks">
                            {state.people
                              .filter((p) => p.active !== false && p.id !== v.driverPersonId)
                              .map((p) => (
                                <label key={p.id}>
                                  <input
                                    type="checkbox"
                                    checked={(v.occupantPersonIds || []).includes(p.id)}
                                    onChange={(e) =>
                                      change(
                                        'occupantPersonIds',
                                        e.target.checked
                                          ? [...(v.occupantPersonIds || []), p.id]
                                          : (v.occupantPersonIds || []).filter(
                                              (id: string) => id !== p.id,
                                            ),
                                      )
                                    }
                                  />
                                  <span>{p.name}</span>
                                </label>
                              ))}
                          </div>
                          <p className="field-hint">
                            Motorista e acompanhantes precisam registrar seus acessos
                            individualmente. O registro do veículo não muda a presença das pessoas.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {group.shortTitle === 'Segurança' && (
                    <>
                      {kind === 'master' &&
                        masterKind === 'people' &&
                        capability(user, 'accessManage') && (
                          <div className="v3-spaced">
                            <span className="field-label">Permissões específicas de área</span>
                            <div className="access-person-checks">
                              {(state.accessAreas || []).map((area: Row) => (
                                <label key={area.id}>
                                  <input
                                    type="checkbox"
                                    checked={(v.allowedAreaIds || []).includes(area.id)}
                                    onChange={(e) =>
                                      change(
                                        'allowedAreaIds',
                                        e.target.checked
                                          ? [...(v.allowedAreaIds || []), area.id]
                                          : (v.allowedAreaIds || []).filter(
                                              (id: string) => id !== area.id,
                                            ),
                                      )
                                    }
                                  />
                                  <span>
                                    {area.name}
                                    <small>
                                      {area.restricted ? 'Área restrita' : 'Área comum'}
                                    </small>
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="form-grid">
              {fields.map((f) => (
                <Field key={f.name} field={f} value={v[f.name]} onChange={change} />
              ))}
            </div>
          )}
          {kind === 'visitor' && v.initialGateAccess && formSteps.last && (
            <label className="access-check access-identity-confirm">
              <input
                type="checkbox"
                required
                checked={v.identityConfirmed === true}
                onChange={(e) => change('identityConfirmed', e.target.checked)}
              />
              <span>
                Conferi a identidade e autorizo este visitante somente na portaria, durante a
                validade informada.
              </span>
            </label>
          )}
          {kind === 'confirm' && action === 'VISITOR_CHECKIN' && (
            <label className="access-check access-identity-confirm">
              <input
                type="checkbox"
                required
                checked={v.identityConfirmed === true}
                onChange={(e) => change('identityConfirmed', e.target.checked)}
              />
              <span>
                Conferi o documento apresentado e confirmei que esta é a pessoa autorizada.
                <small>
                  A confirmação fica registrada com meu usuário e o horário desta entrada.
                </small>
              </span>
            </label>
          )}
          <datalist id="companies">
            {state.companies
              .filter((c) => c.active !== false)
              .map((c) => (
                <option key={c.id} value={c.name} />
              ))}
          </datalist>
          <span className="field-hint">
            {formSteps.last && fields.some((f) => f.type === 'datetime-local')
              ? `Datas e horários no fuso ${tz}.`
              : ''}
          </span>
          {conflict && (
            <div className="notice warning">
              <History size={18} />
              <div>
                Seus campos foram preservados. Confira os dados atuais antes de reenviar.
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
          {error && (
            <div className="notice error" role="alert">
              <CircleAlert size={18} />
              {error}
            </div>
          )}
          {!online && (
            <div className="notice warning">
              <WifiOff size={18} />
              Reconecte para salvar. Seus dados permanecem neste formulário.
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button disabled={saving} onClick={close}>
            Cancelar
          </Button>
          {kind === 'visitor' && formSteps.current === 0 && (
            <Button
              className="visitor-photo-shortcut"
              disabled={saving || !capability(user, 'documentView')}
              onClick={() => {
                const camera = formRef.current?.querySelector<HTMLElement>('.visitor-camera');
                camera?.scrollIntoView({ block: 'center' });
                camera?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
              }}
            >
              {visitorPhoto ? 'Foto pronta' : 'Foto'}
            </Button>
          )}
          {formSteps.enabled && (
            <span className="form-step-counter">
              Etapa {formSteps.current + 1} de {groups.length}
            </span>
          )}
          {formSteps.enabled && formSteps.current > 0 && (
            <Button disabled={saving} onClick={() => formSteps.go(formSteps.current - 1)}>
              Voltar
            </Button>
          )}
          <Button
            type="submit"
            variant={kind === 'reason' || kind === 'restore' ? 'danger' : 'primary'}
            disabled={
              saving ||
              (formSteps.last &&
                (!online ||
                  conflict ||
                  (kind === 'confirm' &&
                    action === 'VISITOR_CHECKIN' &&
                    v.identityConfirmed !== true) ||
                  (kind === 'visitor' && v.initialGateAccess && v.identityConfirmed !== true) ||
                  (kind === 'restore' && (!backup || v.confirmation !== 'RESTAURAR'))))
            }
          >
            {saving ? (
              <LoaderCircle className="spinning" size={17} />
            ) : formSteps.last ? (
              <Check size={17} />
            ) : (
              <ChevronRight size={17} />
            )}{' '}
            {saving ? 'Salvando…' : formSteps.last ? submit : 'Próximo'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
