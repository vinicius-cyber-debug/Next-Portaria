/** Data contracts for stored operational records. Unknown extension fields stay opaque. */
export type Role = 'admin' | 'director' | 'gate' | 'operations' | 'finance' | 'reader';
export type Capabilities = Record<string, boolean>;
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  role: Role;
  status: string;
  mustChangePassword?: boolean;
  capabilities?: Capabilities;
  overrides?: Capabilities;
  createdAt?: string;
  updatedAt?: string;
}
export interface DirectoryLink {
  sourceId: string;
  nativeId: string;
  recordId: string;
  registration: string;
  inactive: boolean;
  blocked: boolean;
  missing: boolean;
}
export interface RecordPhoto {
  objectKey: string;
  sha256: string;
  size: number;
  contentType: string;
}
export interface Authorization {
  id: string;
  version: number;
  status: string;
  validFrom: string;
  validUntil: string | null;
  areaIds: (string | null)[];
  exitControl: string;
  authorizedAt: string;
  authorizedBy: string;
  reason: string;
  revokedAt?: string;
  revokedBy?: string;
}
export interface Outing {
  id: string;
  leftAt: string;
  leftBy: string;
  returnedAt: string | null;
  returnedBy: string | null;
  productionPeriod: string;
  reason: string;
}
export interface AuditChange {
  kind: string;
  id: string;
  before: unknown;
  after: unknown;
}
export interface OperationalRecord {
  [field: string]: unknown;
  id: string;
  name: string;
  status: string;
  company: string;
  active: boolean;
  category: string;
  securityStatus: string;
  documentLast4: string;
  restrictions: string;
  allowedAreaIds: string[];
  directory?: DirectoryLink;
  directoryPhoto?: RecordPhoto | null;
  authorization?: Authorization;
  outings?: Outing[];
  personId?: string | null;
  areaId?: string | null;
  stayId?: string | null;
  requestedAt: string;
  validUntil: string;
  expectedAt: string;
  enteredAt: string | null;
  leftAt: string | null;
  entryAt: string;
  exitAt: string | null;
  updatedAt: string;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  host: string;
  gateName: string;
  purpose: string;
  notes: string;
  phone: string;
  email: string;
  contact: string;
  title: string;
  description: string;
  detail: string;
  reason: string;
  action: string;
  entity: string;
  attachmentIds?: string[];
  visitorPhoto?: { attachmentId: string; sha256: string };
  responsibleUserId?: string | null;
  substituteUserId?: string | null;
  role?: Role;
  capabilities?: Capabilities;
  plate: string;
  driver: string;
  vesselName: string;
  client: string;
  changes?: AuditChange[];
}
export interface Settings {
  [field: string]: unknown;
  unitName: string;
  gateNames: string[];
  timezone: string;
  visitorOverstayHours: number;
  openingTime: string;
  closingTime: string;
}
export type PersonRecord = Pick<
  OperationalRecord,
  | 'id'
  | 'name'
  | 'company'
  | 'active'
  | 'category'
  | 'securityStatus'
  | 'documentLast4'
  | 'restrictions'
  | 'allowedAreaIds'
  | 'directory'
  | 'directoryPhoto'
  | 'authorization'
> &
  Partial<Pick<OperationalRecord, 'updatedAt'>> & { updatedBy?: string };
export type StoredRecord = { id: string; [field: string]: unknown };
export interface AuditRecord extends StoredRecord {
  at: string;
  actor: string | { name: string };
  actorId?: string | null;
  role: string;
  action: string;
  entity: string;
  entityId: string;
  detail: string;
  changes: AuditChange[];
  reason?: string | null;
}
export type CollectionName =
  | 'visitors'
  | 'vehicles'
  | 'stays'
  | 'charges'
  | 'people'
  | 'fleet'
  | 'vessels'
  | 'companies'
  | 'tariffHistory'
  | 'contracts'
  | 'reservations'
  | 'incidents'
  | 'handovers'
  | 'settlements'
  | 'accessAreas'
  | 'crewManifests'
  | 'emergencyRollCalls'
  | 'accessCorrections'
  | 'personRequirements';
export type OperationalState = Record<Exclude<CollectionName, 'people'>, OperationalRecord[]> & {
  people: PersonRecord[];
  version: number;
  settings: Settings;
  audit: AuditRecord[];
  berths: string[];
  documentRestricted?: boolean;
  financialRestricted?: boolean;
  historyWindow?: { since: string; days: number; auditLimit: number; complete: boolean };
};
export type Snapshot = { state: OperationalState; revision: number };
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
