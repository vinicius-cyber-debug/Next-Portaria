import type { SessionUser, PersonRecord } from '../operational-types';
export type ExitUser = SessionUser;
export type Sector = {
  id: string;
  name: string;
  active: boolean;
  leader_id: string | null;
  substitute_id: string | null;
  version: number;
};
export type ExitBinding = {
  person_id: string;
  source_id: string;
  native_user_id: string;
  manual_rule_id: string | null;
  target_hash: string;
  enabled: boolean;
  desired_control: boolean;
  provisioning_status: string;
  requested_by: string;
  last_error: string | null;
  verified_at: Date | null;
  verified_by: string | null;
  evidence: string;
};
export type Permit = {
  id: string;
  person_id: string;
  sector_id: string;
  issued_by: string;
  issued_by_name: string;
  reason: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  status: string;
  last_applied_at: Date | null;
  last_error: string | null;
};
export type ExitPerson = PersonRecord & { directory: NonNullable<PersonRecord['directory']> };
export type PendingExit = {
  eventId: string;
  recordId: string;
  nativeUserId: string;
  deviceId: string;
  areaId: string;
  occurredAt: string;
  state: 'pending' | 'authorized' | 'denied' | 'other';
};
export type ExitTarget = {
  sourceId: string;
  deviceId: string;
  deviceName: string;
  model: number;
  firmware: string;
  serial: string;
  entryReaderId: string;
  exitReaderId: string;
  entryAreaId: string;
  exitAreaId: string;
  exitAreaName: string;
  exitRotation: 'clockwise' | 'anticlockwise';
};
export interface ExitGateway {
  readonly mode: 'live' | 'simulation' | 'disabled';
  readonly targetHash: string;
  readonly sourceId: string;
  readonly deviceId: string;
  readonly configurationError?: string;
  inspect(): Promise<void>;
  verifyBinding(binding: ExitBinding): Promise<void>;
  provision(binding: ExitBinding): Promise<string>;
  remove(binding: ExitBinding): Promise<void>;
  readEvents(): Promise<PendingExit[]>;
  authorize(event: PendingExit, expiresAt: string): Promise<void>;
  confirm(event: PendingExit): Promise<boolean>;
}
