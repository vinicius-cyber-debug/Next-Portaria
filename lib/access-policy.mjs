import { RETIRED_COMMANDS } from './module-policy.mjs';
const PERMISSIONS = {
  director: [
    'PERSON_AUTHORIZE',
    'PERSON_AUTH_REVOKE',
    'VISITOR_REQUEST',
    'VISITOR_APPROVE',
    'VISITOR_REJECT',
    'VISITOR_REVOKE',
    'VISITOR_CANCEL',
    'RECORD_CORRECT',
    'MASTER_SAVE',
    'RESERVATION_SAVE',
    'RESERVATION_CANCEL',
    'INCIDENT_CREATE',
    'INCIDENT_UPDATE',
    'SHIFT_HANDOVER',
    'SHIFT_ACKNOWLEDGE',
    'ACCESS_AREA_SAVE',
    'PERSON_REQUIREMENT_SAVE',
    'CREW_MANIFEST_SAVE',
    'EMERGENCY_START',
    'EMERGENCY_RECONCILE',
    'EMERGENCY_CLOSE',
    'ACCESS_EXIT_CORRECT',
  ],
  gate: [
    'VISITOR_GATE_REGISTER',
    'VISITOR_GATE_REVOKE',
    'PERSON_ENTER',
    'VISITOR_MARK_UNCONFIRMED',
    'EMPLOYEE_LEAVE',
    'EMPLOYEE_RETURN',
    'VISITOR_REQUEST',
    'VISITOR_CHECKIN',
    'VISITOR_CHECKOUT',
    'VISITOR_CANCEL',
    'VEHICLE_ENTER',
    'VEHICLE_EXIT',
    'MASTER_SAVE',
    'INCIDENT_CREATE',
    'INCIDENT_UPDATE',
    'SHIFT_HANDOVER',
    'SHIFT_ACKNOWLEDGE',
    'EMERGENCY_START',
    'EMERGENCY_RECONCILE',
    'EMERGENCY_CLOSE',
  ],
  operations: [
    'STAY_OPEN',
    'STAY_CLOSE',
    'RECORD_CORRECT',
    'MASTER_SAVE',
    'RESERVATION_SAVE',
    'RESERVATION_CANCEL',
    'INCIDENT_CREATE',
    'INCIDENT_UPDATE',
    'SHIFT_HANDOVER',
    'SHIFT_ACKNOWLEDGE',
    'ACCESS_AREA_SAVE',
    'PERSON_REQUIREMENT_SAVE',
    'CREW_MANIFEST_SAVE',
    'EMERGENCY_START',
    'EMERGENCY_RECONCILE',
    'EMERGENCY_CLOSE',
    'ACCESS_EXIT_CORRECT',
  ],
  finance: [
    'SETTINGS_UPDATE',
    'CHARGE_PAID',
    'CHARGE_PAYMENT',
    'CHARGE_CANCEL',
    'PAYMENT_REVERSE',
    'MASTER_SAVE',
    'CONTRACT_SAVE',
    'MONTH_CLOSE',
  ],
  reader: [],
};
const COMMANDS = new Set([
  ...Object.values(PERMISSIONS).flat(),
  'BERTH_ADD',
  'BERTH_REMOVE',
  'PERSON_AUTHORIZE',
  'PERSON_AUTH_REVOKE',
  'PERSON_ENTER',
  'VISITOR_MARK_UNCONFIRMED',
  'EMPLOYEE_LEAVE',
  'EMPLOYEE_RETURN',
]);
export const ROLES = ['admin', 'director', 'gate', 'operations', 'finance', 'reader'];
export function canonicalRole(role) {
  return role === 'ops' ? 'operations' : role;
}
export function can(role, type) {
  if (canonicalRole(role) === 'finance' && type !== 'READ') return false;
  return !RETIRED_COMMANDS.includes(type) && historicalCan(role, type);
}
export function historicalCan(role, type) {
  role = canonicalRole(role);
  if (!ROLES.includes(role)) return false;
  return (
    type === 'READ' ||
    ((role === 'admin' || PERMISSIONS[role]?.includes(type)) && COMMANDS.has(type))
  );
}
export function isKnownCommand(type) {
  return COMMANDS.has(type);
}

export function allowedMaster(role, kind) {
  return (
    role === 'admin' ||
    (
      {
        director: ['people', 'companies'],
        gate: ['people', 'fleet'],
        operations: ['people', 'vessels', 'companies'],
        finance: ['companies'],
      }[role] ?? []
    ).includes(kind)
  );
}
export function accessManager(role) {
  return ['admin', 'director', 'operations'].includes(role);
}

export function changesProtectedPersonCategory(current, input) {
  if (!current || !Object.hasOwn(input, 'category') || input.category === current.category)
    return false;
  // Portaria may flag a visitor as a contractor awaiting review; this removes
  // eligibility rather than granting visitor privileges to an employee.
  const pendingContractor =
    current.category === 'visitor' &&
    input.category === 'contractor' &&
    (input.securityStatus == null || ['pending', 'blocked'].includes(input.securityStatus));
  return !pendingContractor;
}
export function canMaintainMaster(role, kind) {
  return kind !== 'vessels' && can(role, 'MASTER_SAVE') && allowedMaster(canonicalRole(role), kind);
}
