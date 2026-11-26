/** @typedef {{field: string, label: string, format?: 'dateTime' | 'status' | 'count' | 'severity', capability?: 'documentView'}} ReportColumn */
/** @typedef {{label: string, dateField: string, columns: ReportColumn[], statuses?: Record<string, string>}} ReportDefinition */

/** @type {ReportColumn} */
const status = { field: 'status', label: 'Situação', format: 'status' };
/** @param {string} field @param {string} label @returns {ReportColumn} */
const date = (field, label) => ({ field, label, format: 'dateTime' });

/** @type {Record<string, ReportDefinition>} */
export const reportCatalog = {
  visitors: {
    label: 'Visitantes e acessos',
    dateField: 'requestedAt',
    statuses: {
      pending: 'Pendente',
      authorized: 'Autorizado',
      inside: 'No local',
      unconfirmed: 'Saída não confirmada',
      temporarily_out: 'Saída produtiva',
      unconfirmed_closed: 'Reconciliado · saída desconhecida',
      completed: 'Finalizado',
      denied: 'Recusado',
      revoked: 'Revogado',
      cancelled: 'Cancelado',
    },
    columns: [
      { field: 'name', label: 'Pessoa' },
      { field: 'company', label: 'Empresa' },
      { field: 'purpose', label: 'Motivo' },
      { field: 'host', label: 'Responsável' },
      { field: 'areaName', label: 'Área' },
      date('requestedAt', 'Solicitação'),
      date('expectedAt', 'Previsão'),
      date('enteredAt', 'Entrada'),
      date('leftAt', 'Saída'),
      status,
    ],
  },
  vehicles: {
    label: 'Veículos na portaria',
    dateField: 'entryAt',
    statuses: { inside: 'No local', completed: 'Finalizado' },
    columns: [
      { field: 'plate', label: 'Placa' },
      { field: 'driver', label: 'Motorista' },
      { field: 'company', label: 'Empresa' },
      { field: 'purpose', label: 'Motivo' },
      { field: 'gateName', label: 'Portaria' },
      date('entryAt', 'Entrada'),
      date('exitAt', 'Saída'),
      status,
    ],
  },
  fleetTrips: {
    label: 'Deslocamentos da frota',
    dateField: 'departedAt',
    statuses: { out: 'Em deslocamento', returned: 'Retornou' },
    columns: [
      { field: 'plate', label: 'Placa' },
      { field: 'vehicleName', label: 'Veículo' },
      { field: 'driver', label: 'Motorista' },
      { field: 'destination', label: 'Destino' },
      date('departedAt', 'Saída'),
      date('returnedAt', 'Retorno'),
      { field: 'odometerOut', label: 'Km na saída', format: 'count' },
      { field: 'odometerIn', label: 'Km no retorno', format: 'count' },
      { field: 'distanceKm', label: 'Distância (km)', format: 'count' },
      status,
    ],
  },
  materialExits: {
    label: 'Saída de materiais',
    dateField: 'createdAt',
    columns: [
      date('createdAt', 'Registro'),
      { field: 'description', label: 'Material' },
      { field: 'quantity', label: 'Quantidade' },
      { field: 'destination', label: 'Destino' },
      { field: 'responsible', label: 'Responsável' },
      { field: 'vehiclePlate', label: 'Placa' },
      { field: 'invoiceNumber', label: 'Nota fiscal', capability: 'documentView' },
    ],
  },
  incidents: {
    label: 'Ocorrências',
    dateField: 'createdAt',
    statuses: { open: 'Aberta', in_progress: 'Em andamento', resolved: 'Resolvida' },
    columns: [
      date('createdAt', 'Abertura'),
      { field: 'title', label: 'Ocorrência' },
      { field: 'category', label: 'Categoria' },
      { field: 'severity', label: 'Gravidade', format: 'severity' },
      { field: 'location', label: 'Local' },
      { field: 'responsible', label: 'Responsável' },
      status,
      date('resolvedAt', 'Resolução'),
    ],
  },
  handovers: {
    label: 'Passagens de turno',
    dateField: 'createdAt',
    columns: [
      date('createdAt', 'Registro'),
      { field: 'shift', label: 'Turno' },
      { field: 'createdBy', label: 'Registrado por' },
      { field: 'summary', label: 'Resumo' },
      { field: 'pending', label: 'Pendências' },
      { field: 'incidentCount', label: 'Ocorrências vinculadas', format: 'count' },
      { field: 'acknowledgementCount', label: 'Ciências registradas', format: 'count' },
    ],
  },
  accessCorrections: {
    label: 'Saídas sem entrada',
    dateField: 'occurredAt',
    columns: [
      date('occurredAt', 'Saída física'),
      { field: 'name', label: 'Pessoa' },
      { field: 'company', label: 'Empresa' },
      { field: 'gateName', label: 'Portaria' },
      { field: 'createdBy', label: 'Registrado por' },
      date('createdAt', 'Registro'),
    ],
  },
  emergencyRollCalls: {
    label: 'Conferências de emergência',
    dateField: 'startedAt',
    statuses: { open: 'Aberta', closed: 'Encerrada' },
    columns: [
      date('startedAt', 'Abertura'),
      { field: 'title', label: 'Conferência' },
      { field: 'startedBy', label: 'Iniciada por' },
      { field: 'peopleCount', label: 'Pessoas na lista', format: 'count' },
      { field: 'confirmedCount', label: 'Localizadas', format: 'count' },
      { field: 'unresolvedCount', label: 'Não localizadas', format: 'count' },
      status,
      date('closedAt', 'Encerramento'),
    ],
  },
};

export const reportSeverity = { low: 'Baixa', medium: 'Média', high: 'Alta', critical: 'Crítica' };

/** @param {string} kind @returns {ReportDefinition | undefined} */
export function getReportDefinition(kind) {
  return Object.hasOwn(reportCatalog, kind) ? reportCatalog[kind] : undefined;
}

/** @param {ReportDefinition} definition @param {Record<string, boolean> | undefined} capabilities @returns {ReportColumn[]} */
export function allowedReportColumns(definition, capabilities) {
  return definition.columns.filter(
    (column) => !column.capability || capabilities?.[column.capability],
  );
}

const dateFormats = new Map();
const countFormat = new Intl.NumberFormat('pt-BR');

/** @param {Record<string, unknown>} row @param {ReportColumn} column @param {ReportDefinition} definition @param {string} timezone @returns {string} */
export function reportValue(row, column, definition, timezone) {
  const value = row[column.field];
  if (value == null || value === '') return '—';
  if (column.format === 'status') return definition.statuses?.[String(value)] ?? String(value);
  if (column.format === 'severity') return reportSeverity[String(value)] ?? String(value);
  if (column.format === 'count' && typeof value === 'number') return countFormat.format(value);
  if (column.format !== 'dateTime') return String(value);
  const date = new Date(String(value));
  if (Number.isNaN(+date)) return '—';
  if (!dateFormats.has(timezone))
    dateFormats.set(
      timezone,
      new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    );
  return dateFormats.get(timezone).format(date);
}

export function projectReportRecord(kind, row, columns, areaNames = new Map()) {
  let source = row;
  if (kind === 'visitors') {
    source = { ...row, areaName: areaNames.get(row.areaId) ?? row.areaName };
  }
  if (kind === 'handovers') {
    source = {
      ...row,
      incidentCount: Array.isArray(row.incidentIds) ? row.incidentIds.length : 0,
      acknowledgementCount: Array.isArray(row.acknowledgements) ? row.acknowledgements.length : 0,
    };
  }
  if (kind === 'emergencyRollCalls') {
    const people = Array.isArray(row.people) ? row.people : [];
    const confirmedCount = people.filter((person) => person?.confirmedAt).length;
    source = {
      ...row,
      peopleCount: people.length,
      confirmedCount,
      unresolvedCount: people.length - confirmedCount,
    };
  }
  return Object.fromEntries([
    ['id', row.id],
    ...columns.map(({ field }) => {
      const value = source[field];
      return [field, ['number', 'string', 'boolean'].includes(typeof value) ? value : null];
    }),
  ]);
}

function csvValue(value) {
  const text = String(value ?? '');
  return '"' + (/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""') + '"';
}

export function reportCsv(columns, records) {
  return (
    '\uFEFF' +
    [
      columns.map(({ label }) => csvValue(label)).join(';'),
      ...records.map((record) => columns.map(({ field }) => csvValue(record[field])).join(';')),
    ].join('\r\n')
  );
}
