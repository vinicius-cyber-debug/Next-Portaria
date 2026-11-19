import type {
  CollectionName,
  OperationalRecord,
  OperationalState,
  SessionUser,
} from '../lib/operational-types';

/** Optional fields represent partial forms and historical records; extensions require narrowing. */
export interface PortalRecord extends Partial<OperationalRecord> {
  [key: string]: unknown;
  id: string;
  name: string;
  status: string;
  areaIds?: string[];
  reviewedAt?: string;
  reviewedBy?: string;
  rows?: PortalRecord[];
  users?: PortalRecord[];
  invites?: PortalRecord[];
  result?: PortalRecord;
  visitor?: PortalRecord;
  row?: PortalRecord;
  error?: string;
  pass?: { id: string; visitorId: string; code: string; expiresAt: string };
  attachment?: { id: string; name: string };
  history?: PortalRecord[];
  acknowledgements?: PortalRecord[];
  notifications?: PortalRecord[];
  backups?: PortalRecord[];
  access?: PortalRecord[];
  userId?: string;
  actorId?: string;
  actor?: string | { name: string };
  at?: string;
  severity?: string;
  location?: string;
  responsible?: string;
  resolution?: string;
  shift?: string;
  summary?: string;
  pending?: string;
  incidentIds?: string[];
  readAt?: string;
  section?: string;
  entityId?: string;
  message?: string;
  createdBy?: string;
  updatedBy?: string;
  expiresAt?: string;
  finishedAt?: string;
  verifiedAt?: string;
  content?: string;
  type?: string;
  registration?: string;
  restricted?: boolean;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  visitorId?: string;
  initialAccessScope?: string;
  initialGateAccess?: boolean;
  identityConfirmed?: boolean;
  initialApprovedById?: string;
  faceEnrollment?: { status: string };
  authorizedBy?: string;
  checkedInBy?: string;
  checkedOutBy?: string;
  productionPeriod?: string;
  productionPeriodLabel?: string;
  people?: EmergencyPerson[];
  definitions?: { key: string; label: string; description: string }[];
  overrides?: Record<string, boolean>;
  effective?: Record<string, boolean>;
  config?: ContinuityConfig;
  driverPersonId?: string;
  occupantPersonIds?: string[];
  securityStatus?: string;
  restrictions?: string;
  allowedAreaIds?: string[];
  reconciledAt?: string;
  reconciledBy?: string;
  reconciliationReason?: string;
  uncertaintyReason?: string;
  uncertaintyRecordedBy?: string;
  uncertaintyRecordedAt?: string;
  approvedBy?: string | null;
  rejectedBy?: string;
  revokedBy?: string;
  cancelledBy?: string;
  requestedBy?: string;
  registrationIdentityConfirmedAt?: string;
  registrationIdentityConfirmedBy?: string;
  startedAt?: string;
  startedBy?: string;
  closedAt?: string;
  closedBy?: string;
  presenceConfidence?: string;
  unresolvedCount?: number;
  note?: string;
  description?: string;
  body?: string;
  text?: string;
  value?: string;
  label?: string;
  page?: string;
  role?: import('../lib/operational-types').Role;
  identityReconfirmedAt?: string;
  identityReconfirmedBy?: string;
  enteredBy?: string;
  exitedBy?: string;
  responsibleName?: string;
  occurredAt?: string;
  masterKind?: string;
  kind?: string;
  from?: string;
  to?: string;
  code?: string;
  exportedAt?: string;
  by?: string;
  changedBy?: string;
  changedAt?: string;
  acknowledgedAt?: string;
  userName?: string;
  acknowledgedBy?: string;
  revision?: number;
  sizeBytes?: number;
  size?: number;
  bytes?: number;
  verificationError?: string;
}
export interface EmergencyPerson {
  visitorId: string;
  personId?: string | null;
  name: string;
  company: string;
  host?: string;
  gateName?: string;
  areaName?: string;
  areaId?: string | null;
  presenceConfidence?: string;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  note?: string;
}
export interface OperationAlert {
  title: string;
  text: string;
  page: import('./portal-shared').Page;
  high?: boolean;
}
export interface ContinuityConfig {
  backupEnabled: boolean;
  everyHours: number;
  retentionDays: number;
  notificationsEnabled: boolean;
  noticeKinds: string[];
  recipientRoles: string[];
}
export interface PortalResponse {
  [field: string]: unknown;
  error?: { code?: string; message?: string };
  visitor?: PortalRecord;
  pass?: { id: string; visitorId: string; code: string; expiresAt: string };
  attachment?: { id: string; name: string };
  result?: PortalRecord;
  capabilities?: Record<string, boolean>;
  invites?: PortalRecord[];
  rows?: PortalRecord[];
  notifications?: PortalRecord[];
  backups?: PortalRecord[];
  config?: ContinuityConfig;
  message?: string;
  verifiedAt?: string;
  exportedAt?: string;
  state?: PortalState;
  revision: number;
  user?: SessionUser;
  users?: SessionUser[];
  delta?: {
    collections: Record<string, { upsert: PortalRecord[]; remove: string[] }>;
    values: Record<string, unknown>;
  };
  features?: { porto?: boolean };
  environment?: string;
  deploymentStage?: 'homologation' | 'production' | null;
  unchanged?: boolean;
  total: number;
  totalPages: number;
  replayed?: boolean;
  notificationSummary?: Record<string, number>;
  unreadCount?: number;
  automation?: { enabled: boolean };
  defaults?: Record<string, Record<string, boolean>>;
}
export type PortalState = Omit<OperationalState, CollectionName | 'audit'> &
  Record<CollectionName | 'audit', PortalRecord[]>;
export type PortalUser = SessionUser;
export type FieldValue = string | number | boolean | null | undefined | readonly string[];
