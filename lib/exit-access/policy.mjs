export const EXIT_DURATION_SECONDS = 900;
export class ExitAccessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function exitFail(code, message, status = 400) {
  throw new ExitAccessError(code, message, status);
}
export function exitPermissions(user) {
  const active = user?.status === 'active',
    admin = active && user.role === 'admin';
  const approve =
    active &&
    ['director', 'operations'].includes(user.role) &&
    user.capabilities?.exitApprove === true;
  const operate = active && user.role === 'gate' && user.capabilities?.gateOperate === true;
  return {
    manage: admin,
    approve: admin || approve,
    view: admin || approve || operate,
    all: admin || operate,
  };
}
export function managesSector(user, sector) {
  return (
    exitPermissions(user).manage ||
    (exitPermissions(user).approve && [sector.leader_id, sector.substitute_id].includes(user.id))
  );
}
export function requireSector(user, sector) {
  if (!sector?.active || !managesSector(user, sector))
    exitFail('FORBIDDEN', 'Seu perfil não pode liberar funcionários deste setor.', 403);
}
export function effectivePermitStatus(permit, now) {
  if (permit.revoked_at || permit.status === 'revoked') return 'revoked';
  return Date.parse(permit.expires_at) <= Date.parse(now) ? 'expired' : permit.status;
}
export function requireEmployee(person) {
  if (
    !person ||
    person.category !== 'employee' ||
    person.active !== true ||
    person.securityStatus !== 'cleared' ||
    person.directory?.inactive ||
    person.directory?.blocked ||
    person.directory?.missing
  )
    exitFail(
      'EMPLOYEE_UNAVAILABLE',
      'Funcionário inativo, bloqueado ou com segurança pendente.',
      409,
    );
  if (!person.directory?.sourceId || !/^\d{1,20}$/.test(person.directory?.nativeId ?? ''))
    exitFail(
      'DIRECTORY_REQUIRED',
      'O funcionário precisa de vínculo confirmado com a central.',
      409,
    );
}
