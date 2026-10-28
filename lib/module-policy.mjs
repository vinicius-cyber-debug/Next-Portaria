/** Operational policy; historical schemas remain available to validate and restore backups. */
export const RETIRED_COLLECTIONS = ['stays','vessels','reservations','crewManifests','charges','contracts','settlements','tariffHistory'];
export const RETIRED_COMMANDS = ['STAY_OPEN','STAY_CLOSE','BERTH_ADD','BERTH_REMOVE','RESERVATION_SAVE','RESERVATION_CANCEL','CREW_MANIFEST_SAVE','CONTRACT_SAVE','MONTH_CLOSE','CHARGE_PAID','CHARGE_PAYMENT','CHARGE_CANCEL','PAYMENT_REVERSE'];
export const RETIRED_CAPABILITIES = ['financialView','berthPlan','contractManage','monthlyClose'];
export const RETIRED_NOTICE_KINDS = ['stay_overstay','charge_overdue'];
export const RETIRED_SETTING_KEYS = ['dailyRateCents','toleranceMinutes','unitHours','name','configured','version','dueDays','overdueHours'];
export const ACTIVE_ROLES = ['admin','director','gate','operations','reader'];
export function moduleRemoved() {
  throw Object.assign(new Error('Os módulos de embarcações e financeiro foram removidos. Utilize as operações de portaria.'),{code:'MODULE_REMOVED'});
}
export function assertActiveCollection(collection) {
  if(RETIRED_COLLECTIONS.includes(collection)||collection==='berths')moduleRemoved();
}
export function assertActiveDestination(value={}) {
  if(value.destinationType==='vessel'||value.stayId||value.vesselId||value.category==='crew')moduleRemoved();
}
export function assertActiveCommand(command) {
  if(!command)return;
  if(RETIRED_COMMANDS.includes(command.type))moduleRemoved();
  const payload=command.payload??{};
  if(command.type==='MASTER_SAVE'&&payload.kind==='vessels')moduleRemoved();
  if(command.type==='RECORD_CORRECT'&&payload.kind==='stay')moduleRemoved();
  if(command.type==='SETTINGS_UPDATE'&&RETIRED_SETTING_KEYS.some(key=>Object.hasOwn(payload,key)))moduleRemoved();
  assertActiveDestination(payload);
  assertActiveDestination(payload.record??{});
  assertActiveDestination(payload.changes??{});
}
/** Keep the stable snapshot shape while withholding retired operational records. */
export function activeState(state) {
  return {...state,...Object.fromEntries(RETIRED_COLLECTIONS.map(key=>[key,[]])),berths:[],settings:Object.fromEntries(Object.entries(state.settings??{}).filter(([key])=>!RETIRED_SETTING_KEYS.includes(key)))};
}
