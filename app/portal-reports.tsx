'use client';

import { ArrowRight, ChartNoAxesCombined, Download, LockKeyhole, Printer } from 'lucide-react';
import React, { useState } from 'react';
import { request as fetch } from '../lib/http-client';
import { usePagedRecords } from './access-support';
import { capability } from './operations-panels';
import {
  download,
  dt,
  Field,
  PortState,
  Row,
  Status,
  statusNames,
  Table,
  User,
} from './portal-shared';
import type { PortalResponse } from './portal-types';
import { Button } from './ui';

export function Reports({
  report,
  setReport,
  tz,
  open,
  user,
  revision,
}: {
  state: PortState;
  report: { kind: string; from: string; to: string; company: string; status: string };
  setReport: React.Dispatch<
    React.SetStateAction<{
      kind: string;
      from: string;
      to: string;
      company: string;
      status: string;
    }>
  >;
  tz: string;
  open: (k: string, r?: Partial<Row>, a?: string) => void;
  user: User | null;
  revision: number;
}) {
  const [exportError, setExportError] = useState(''),
    [exporting, setExporting] = useState(false);
  const kinds = [
      { value: 'visitors', label: 'Visitantes' },
      { value: 'vehicles', label: 'Veículos' },
    ],
    params = {
      from: report.from,
      to: report.to,
      company: report.company,
      status: report.status,
    },
    summary = usePagedRecords(report.kind, params, 1, 1, revision),
    options =
      report.kind === 'visitors'
        ? [
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
          ]
        : ['inside', 'completed'],
    columns = reportColumns(report.kind, tz),
    update = (name: string, value: string) => setReport({ ...report, [name]: value });
  async function printReport() {
    setExportError('');
    setExporting(true);
    try {
      const rows: Row[] = [];
      let page = 1,
        totalPages = 1;
      do {
        const search = new URLSearchParams({
            collection: report.kind,
            ...params,
            page: String(page),
            pageSize: '100',
          }),
          response = await fetch('/api/records?' + search, {
            cache: 'no-store',
          }),
          data = (await response.json()) as PortalResponse;
        if (!response.ok)
          throw new Error(data.error?.message || 'Não foi possível preparar a impressão.');
        if (data.total > 5000)
          throw new Error(
            'Selecione um período menor para imprimir até 5.000 registros, ou exporte o CSV completo.',
          );
        rows.push(...(data.rows ?? []));
        totalPages = data.totalPages;
        page++;
      } while (page <= totalPages);
      open('print-report', {
        rows,
        kind: report.kind,
        from: report.from,
        to: report.to,
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'Não foi possível preparar a impressão.',
      );
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Explore seus registros</h2>
            <p className="card-subtitle">
              Consulte todo o histórico por período, com carregamento por página.
            </p>
          </div>
          <ChartNoAxesCombined size={23} />
        </div>
        <div className="card-body">
          <div className="report-controls">
            <Field
              field={{
                name: 'kind',
                label: 'Tipo de relatório',
                type: 'select',
                options: kinds,
              }}
              value={report.kind}
              onChange={(_, v) => setReport({ ...report, kind: v, status: 'all' })}
            />
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
            <Field
              field={{ name: 'company', label: 'Empresa / cliente' }}
              value={report.company}
              onChange={update}
            />
            <Field
              field={{
                name: 'status',
                label: 'Situação',
                type: 'select',
                options: [
                  { value: 'all', label: 'Todas as situações' },
                  ...options.map((s) => ({ value: s, label: statusNames[s] })),
                ],
              }}
              value={report.status}
              onChange={update}
            />
          </div>
          <div className="report-actions">
            <span className="field-hint">
              {summary.loading ? 'Consultando…' : summary.total + ' registro(s) no filtro'}
            </span>
            <div className="actions">
              <Button
                onClick={async () => {
                  setExportError('');
                  setExporting(true);
                  try {
                    const search = new URLSearchParams({
                        kind: report.kind,
                        ...params,
                      }),
                      response = await fetch('/api/exports?' + search);
                    if (!response.ok) {
                      const data = (await response.json()) as PortalResponse;
                      throw new Error(data.error?.message || 'Não foi possível exportar.');
                    }
                    download(
                      'porto-' + report.kind + '-' + new Date().toISOString().slice(0, 10) + '.csv',
                      await response.text(),
                      'text/csv;charset=utf-8',
                    );
                  } catch (error) {
                    setExportError(
                      error instanceof Error ? error.message : 'Não foi possível exportar.',
                    );
                  } finally {
                    setExporting(false);
                  }
                }}
                disabled={!summary.total || !capability(user, 'dataExport') || exporting}
              >
                <Download size={16} />
                Exportar CSV
              </Button>
              <Button
                disabled={!summary.total || !capability(user, 'dataExport') || exporting}
                onClick={() => void printReport()}
              >
                <Printer size={16} />
                {exporting ? 'Preparando…' : 'Imprimir'}
              </Button>
            </div>
          </div>
          {exportError && (
            <div className="notice error" role="alert">
              {exportError}
            </div>
          )}
          {!capability(user, 'dataExport') && (
            <div className="notice info">
              <LockKeyhole size={17} />
              Seu acesso permite consulta. Exportações e impressão estão restritas.
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <Table
          server={{ collection: report.kind, params, revision }}
          rows={[]}
          columns={columns}
          emptyTitle="Nenhum registro neste período"
          emptyText="Ajuste os filtros para consultar os dados registrados na operação."
        />
      </div>
      <div className="notice info">
        <Printer size={18} />
        <div>
          Para contingência, imprima a lista de pessoas e veículos atualmente no local.
          <button
            className="content-link"
            disabled={!capability(user, 'dataExport')}
            onClick={() => open('contingency')}
          >
            Abrir lista de presentes
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </>
  );
}

export function reportColumns(
  kind: string,
  tz: string,
): {
  title: string;
  render: (r: Row) => React.ReactNode;
  raw: (r: Row) => unknown;
}[] {
  const fields: { title: string; raw: (r: Row) => unknown }[] =
    kind === 'visitors'
      ? [
          { title: 'Visitante', raw: (r) => r.name },
          { title: 'Empresa', raw: (r) => r.company },
          { title: 'Motivo', raw: (r) => r.purpose },
          { title: 'Responsável', raw: (r) => r.host },
          { title: 'Previsão', raw: (r) => dt(r.expectedAt, tz) },
          { title: 'Entrada', raw: (r) => dt(r.enteredAt, tz) },
          { title: 'Saída', raw: (r) => dt(r.leftAt, tz) },
        ]
      : [
          { title: 'Placa', raw: (r) => r.plate },
          { title: 'Motorista', raw: (r) => r.driver },
          { title: 'Empresa', raw: (r) => r.company },
          { title: 'Motivo', raw: (r) => r.purpose },
          { title: 'Entrada', raw: (r) => dt(r.entryAt, tz) },
          { title: 'Saída', raw: (r) => dt(r.exitAt, tz) },
        ];
  return [
    ...fields.map((f) => ({
      ...f,
      render: (r: Row) => String(f.raw(r) ?? '—'),
    })),
    {
      title: 'Situação',
      raw: (r) => statusNames[r.status] || r.status,
      render: (r) => (
        <Status
          value={r.status}
          facePending={r.initialAccessScope === 'gate_only' && r.status === 'authorized'}
        />
      ),
    },
  ];
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
