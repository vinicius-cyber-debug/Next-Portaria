'use client';

import { ArrowRight, Download, LockKeyhole, Printer } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { request } from '../lib/http-client';
import {
  allowedReportColumns,
  getReportDefinition,
  reportCatalog,
  reportSeverity,
  reportValue,
  type ReportColumn,
} from '../lib/report-catalog.mjs';
import { usePagedRecords } from './access-support';
import { capability } from './operations-panels';
import {
  download,
  Field,
  localDate,
  type PortState,
  type Row,
  Table,
  type User,
} from './portal-shared';
import type { PortalResponse } from './portal-types';
import { Button, FormField, StatusBadge } from './ui';
import './portal-reports.css';

const groups = [
  { label: 'Controle de acesso', kinds: ['visitors', 'accessCorrections', 'emergencyRollCalls'] },
  { label: 'Veículos e logística', kinds: ['vehicles', 'fleetTrips', 'materialExits'] },
  { label: 'Operação e segurança', kinds: ['incidents', 'handovers'] },
];

const filters: Record<string, { date: string; search: string }> = {
  visitors: { date: 'data da solicitação', search: 'Pessoa, motivo ou responsável' },
  vehicles: { date: 'entrada na portaria', search: 'Placa, motorista ou motivo' },
  fleetTrips: { date: 'saída da frota', search: 'Placa, motorista ou destino' },
  materialExits: { date: 'registro da saída', search: 'Material, destino ou responsável' },
  incidents: { date: 'abertura da ocorrência', search: 'Ocorrência, local ou responsável' },
  handovers: { date: 'registro da passagem', search: 'Turno, resumo ou pendência' },
  accessCorrections: { date: 'saída física', search: 'Pessoa ou empresa' },
  emergencyRollCalls: { date: 'abertura da conferência', search: 'Nome da conferência' },
};

interface ReportSelection {
  kind: string;
  from: string;
  to: string;
  company: string;
  status: string;
  q?: string;
  areaId?: string;
  gateName?: string;
  fleetId?: string;
  severity?: string;
}

const extraFields = ['q', 'areaId', 'gateName', 'fleetId', 'severity'] as const;

function periodStart(today: string, days: number) {
  const date = new Date(today + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}

const selectOptions = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

export function Reports({
  state,
  report,
  setReport,
  tz,
  open,
  user,
  revision,
  openPorto,
}: {
  state: PortState;
  report: ReportSelection;
  setReport: Dispatch<SetStateAction<ReportSelection>>;
  tz: string;
  open: (k: string, r?: Partial<Row>, a?: string) => void;
  user: User | null;
  revision: number;
  openPorto?: () => void;
}) {
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState<'csv' | 'print' | null>(null);
  const kind = Object.hasOwn(filters, report.kind) ? report.kind : 'visitors';
  const definition = reportCatalog[kind];
  const filter = filters[kind];
  const accessAreas = state.accessAreas ?? [];
  const fleet = state.fleet ?? [];
  const validPeriod = !report.from || !report.to || report.from <= report.to;
  const params: Record<string, string> = {
    report: 'true',
    from: report.from,
    to: report.to,
    company: report.company.trim(),
    status: report.status,
  };
  for (const field of extraFields) {
    const value = report[field]?.trim();
    if (value) params[field] = value;
  }
  const summary = usePagedRecords(validPeriod ? kind : '', params, 1, 1, revision);
  const canExport = capability(user, 'dataExport');
  const showCompany = ['visitors', 'vehicles', 'accessCorrections'].includes(kind);
  const showGate = ['vehicles', 'accessCorrections'].includes(kind);
  const showInvoice = kind === 'materialExits' && capability(user, 'documentView');
  const searchHint = filter.search + (showInvoice ? ' ou nota fiscal' : '');
  const exportDisabled =
    !validPeriod ||
    !!summary.error ||
    !summary.total ||
    summary.loading ||
    !canExport ||
    !!exporting;

  function update(name: string, value: string) {
    setExportError('');
    setReport((previous) => ({ ...previous, [name]: value }));
  }

  function reset(kind: string, from = '', to = '') {
    setExportError('');
    setReport({ kind, from, to, company: '', status: 'all' });
  }

  function selectPeriod(days: number) {
    const today = localDate(undefined, tz).slice(0, 10);
    setExportError('');
    setReport((previous) => ({ ...previous, from: periodStart(today, days), to: today }));
  }

  async function exportReport(format: 'csv' | 'print') {
    setExportError('');
    setExporting(format);
    try {
      if (format === 'csv') {
        const search = new URLSearchParams({ kind, ...params });
        const response = await request('/api/exports?' + search, { cache: 'no-store' });
        if (!response.ok) {
          const data = (await response.json()) as PortalResponse;
          throw new Error(data.error?.message || 'Não foi possível exportar.');
        }
        download(
          'porto-' + kind + '-' + localDate(undefined, tz).slice(0, 10) + '.csv',
          await response.arrayBuffer(),
          'text/csv;charset=utf-8',
        );
        return;
      }
      const rows: Row[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const search = new URLSearchParams({
          collection: kind,
          ...params,
          page: String(page),
          pageSize: '100',
        });
        const response = await request('/api/records?' + search, { cache: 'no-store' });
        const data = (await response.json()) as PortalResponse;
        if (!response.ok) {
          throw new Error(data.error?.message || 'Não foi possível preparar a impressão.');
        }
        if (data.total > 5000) {
          throw new Error(
            'Selecione um período menor para imprimir até 5.000 registros, ou exporte o CSV.',
          );
        }
        rows.push(...(data.rows ?? []));
        totalPages = data.totalPages;
        page++;
      } while (page <= totalPages);
      const conditions = [
        params.q && 'Busca: ' + params.q,
        params.company && 'Empresa: ' + params.company,
        params.status !== 'all' &&
          definition.statuses?.[params.status] &&
          'Situação: ' + definition.statuses[params.status],
        params.areaId &&
          'Área: ' + (accessAreas.find(({ id }) => id === params.areaId)?.name || params.areaId),
        params.gateName && 'Portaria: ' + params.gateName,
        params.fleetId &&
          'Veículo: ' + (fleet.find(({ id }) => id === params.fleetId)?.plate || params.fleetId),
        params.severity &&
          'Gravidade: ' +
            (reportSeverity[params.severity as keyof typeof reportSeverity] || params.severity),
      ].filter(Boolean);
      open('print-report', {
        rows,
        kind,
        from: report.from,
        to: report.to,
        description: conditions.join(' · '),
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'Não foi possível preparar o relatório.',
      );
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="reports-page">
      <section className="card" aria-label="Configurar relatório">
        <div className="card-body reports-form">
          <fieldset disabled={!!exporting}>
            <div className="reports-selection">
              <FormField label="Tipo de relatório">
                <select
                  className="select"
                  value={kind}
                  onChange={(event) => reset(event.target.value, report.from, report.to)}
                >
                  {groups.map(({ label, kinds }) => (
                    <optgroup label={label} key={label}>
                      {kinds.map((id) => (
                        <option value={id} key={id}>
                          {reportCatalog[id].label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </FormField>
              <div className="reports-presets">
                <span className="field-label">Período rápido</span>
                <div className="actions">
                  {[
                    { days: 1, label: 'Hoje' },
                    { days: 7, label: '7 dias' },
                    { days: 30, label: '30 dias' },
                  ].map(({ days, label }) => (
                    <Button type="button" key={days} onClick={() => selectPeriod(days)}>
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <div className="reports-filters">
              <Field
                field={{ name: 'from', label: 'Data inicial', type: 'date' }}
                value={report.from}
                onChange={update}
              />
              <Field
                field={{ name: 'to', label: 'Data final', type: 'date' }}
                value={report.to}
                onChange={update}
              />
              <FormField label="Buscar" hint={searchHint}>
                <input
                  className="input"
                  type="search"
                  maxLength={200}
                  value={report.q || ''}
                  onChange={(event) => update('q', event.target.value)}
                />
              </FormField>
              {definition.statuses && (
                <Field
                  field={{
                    name: 'status',
                    label: 'Situação',
                    type: 'select',
                    options: [
                      { value: 'all', label: 'Todas as situações' },
                      ...selectOptions(definition.statuses),
                    ],
                  }}
                  value={report.status}
                  onChange={update}
                />
              )}
              {showCompany && (
                <FormField label="Empresa">
                  <input
                    className="input"
                    maxLength={200}
                    value={report.company}
                    onChange={(event) => update('company', event.target.value)}
                  />
                </FormField>
              )}
              {kind === 'visitors' && accessAreas.length > 0 && (
                <Field
                  field={{
                    name: 'areaId',
                    label: 'Área',
                    type: 'select',
                    options: [
                      { label: 'Todas as áreas', value: '' },
                      ...accessAreas.map(({ id, name }) => ({ label: name, value: id })),
                    ],
                  }}
                  value={report.areaId || ''}
                  onChange={update}
                />
              )}
              {showGate && (
                <Field
                  field={{
                    name: 'gateName',
                    label: 'Portaria',
                    type: 'select',
                    options: [
                      { label: 'Todas as portarias', value: '' },
                      ...state.settings.gateNames.map((name) => ({ label: name, value: name })),
                    ],
                  }}
                  value={report.gateName || ''}
                  onChange={update}
                />
              )}
              {kind === 'fleetTrips' && fleet.length > 0 && (
                <Field
                  field={{
                    name: 'fleetId',
                    label: 'Veículo da empresa',
                    type: 'select',
                    options: [
                      { label: 'Toda a frota', value: '' },
                      ...fleet.map(({ id, plate, name }) => ({
                        label: [plate, name].filter(Boolean).join(' · '),
                        value: id,
                      })),
                    ],
                  }}
                  value={report.fleetId || ''}
                  onChange={update}
                />
              )}
              {kind === 'incidents' && (
                <Field
                  field={{
                    name: 'severity',
                    label: 'Gravidade',
                    type: 'select',
                    options: [
                      { label: 'Todas as gravidades', value: '' },
                      ...selectOptions(reportSeverity),
                    ],
                  }}
                  value={report.severity || ''}
                  onChange={update}
                />
              )}
            </div>
            <div className="reports-filter-footer">
              <span className="field-hint">Recorte por {filter.date}.</span>
              <button type="button" className="section-link" onClick={() => reset(kind)}>
                Limpar filtros
              </button>
            </div>
          </fieldset>
        </div>
      </section>
      <section className="card report-results" aria-label="Resultados">
        <div className="card-header reports-results-header">
          <div>
            <h2 className="card-title">{definition.label}</h2>
            <p className="card-subtitle" role="status">
              {!validPeriod
                ? 'Corrija as datas para consultar.'
                : summary.error
                  ? 'Consulta indisponível.'
                  : summary.loading
                    ? 'Consultando…'
                    : summary.total.toLocaleString('pt-BR') +
                      (summary.total === 1 ? ' registro' : ' registros')}
            </p>
          </div>
          {canExport && (
            <div className="actions reports-result-actions">
              <Button onClick={() => void exportReport('csv')} disabled={exportDisabled}>
                <Download size={16} aria-hidden="true" />
                {exporting === 'csv' ? 'Exportando…' : 'Exportar CSV'}
              </Button>
              <Button onClick={() => void exportReport('print')} disabled={exportDisabled}>
                <Printer size={16} aria-hidden="true" />
                {exporting === 'print' ? 'Preparando…' : 'Imprimir'}
              </Button>
            </div>
          )}
        </div>
        {!canExport && (
          <p className="reports-notice">
            <LockKeyhole size={16} aria-hidden="true" /> Exportação e impressão exigem permissão.
          </p>
        )}
        {exportError && (
          <div className="notice error reports-notice" role="alert">
            {exportError}
          </div>
        )}
        {validPeriod ? (
          <Table
            server={{ collection: kind, params, revision }}
            rows={[]}
            columns={reportColumns(kind, tz, user?.capabilities)}
            emptyTitle="Nenhum registro encontrado"
            emptyText="Ajuste os filtros para consultar outro recorte."
            stackOnNarrow
            label="Registros do relatório"
          />
        ) : (
          <p className="reports-notice" role="alert">
            A data inicial deve ser anterior ou igual à data final.
          </p>
        )}
      </section>
      {(canExport || openPorto) && (
        <div className="reports-related">
          {canExport && (
            <button type="button" className="section-link" onClick={() => open('contingency')}>
              <Printer size={16} aria-hidden="true" /> Lista de presentes para contingência
            </button>
          )}
          {openPorto && (
            <button type="button" className="section-link" onClick={openPorto}>
              Acessar Gestão do Porto <ArrowRight size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function reportColumns(
  kind: string,
  tz: string,
  capabilities?: User['capabilities'],
): { title: string; render: (r: Row) => React.ReactNode; raw: (r: Row) => unknown }[] {
  const definition = getReportDefinition(kind) ?? reportCatalog.visitors;
  return allowedReportColumns(definition, capabilities).map((column: ReportColumn) => {
    const raw = (row: Row) => reportValue(row, column, definition, tz);
    return {
      title: column.label,
      raw,
      render: (row: Row) => (
        <>
          <span className="report-cell-label" aria-hidden="true">
            {column.label}
          </span>
          {column.format === 'status' && typeof row.status === 'string' ? (
            <StatusBadge value={row.status}>{raw(row)}</StatusBadge>
          ) : (
            raw(row)
          )}
        </>
      ),
    };
  });
}

export function printNow() {
  document.body.classList.add('print-mode');
  const clean = () => {
    document.body.classList.remove('print-mode');
    window.removeEventListener('afterprint', clean);
  };
  window.addEventListener('afterprint', clean);
  window.print();
  setTimeout(clean, 1200);
}

export function PrintTable({
  rows,
  columns,
}: {
  rows: Row[];
  columns: { title: string; raw: (r: Row) => unknown }[];
}) {
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label="Tabela de registros. Role para ver todas as colunas."
    >
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r, i) => (
              <tr key={r.id || i}>
                {columns.map((c, j) => (
                  <td key={j}>{String(c.raw(r) ?? '—')}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length}>Nenhum registro.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
