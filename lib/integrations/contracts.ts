/** Application contracts, NOT vendor HTTP payloads or an authorization to drive hardware. */
export type Capability='inspect'|'readUsers'|'readEvents'|'confirmedPassage'|'userSync'|'faceEnrollment'|'permissionSync'|'credentialRevocation'|'onlineAuthorization';
export type CapabilityState={support:'unknown'|'supported'|'unsupported';evidence:'not_validated'|'simulation'|'verified_device';firmware:string|null};
export type DeviceInspection={
  deviceId:string;manufacturer:string;model:string;firmware:string;serial:string;
  observedAt:string;mode:'simulation'|'read_only';capabilities:Record<Capability,CapabilityState>;
};
export type DeviceUser={nativeUserId:string;displayName?:string};
export type DeviceEvent={
  deviceId:string;generation:string;nativeEventId:string;sourceRevision:string;
  occurredAt:string;nativeUserId:string|null;direction:'entry'|'exit'|'unknown';
  kind:'authorization_granted'|'authorization_denied'|'passage_confirmed'|'passage_abandoned'|'unclassified';
};
export type PageRequest={cursor?:string;limit?:number;signal?:AbortSignal};
export type DevicePage<T>={items:T[];nextCursor:string|null;observedAt:string};
export interface DeviceReadAdapter {
  readonly mode:'simulation'|'read_only';
  inspect(signal?:AbortSignal):Promise<DeviceInspection>;
  readUsers(request?:PageRequest):Promise<DevicePage<DeviceUser>>;
  readEvents(request?:PageRequest):Promise<DevicePage<DeviceEvent>>;
}
// Write operations and credentials/biometric payloads intentionally have no interface yet.
export const CAPABILITIES:readonly Capability[]=['inspect','readUsers','readEvents','confirmedPassage','userSync','faceEnrollment','permissionSync','credentialRevocation','onlineAuthorization'];
export type IntegrationFailureKind='offline'|'timeout'|'authentication'|'unsupported'|'invalid_input'|'aborted';
export class IntegrationError extends Error {
  readonly kind:IntegrationFailureKind;readonly retryable:boolean;
  constructor(kind:IntegrationFailureKind){
    const messages:Record<IntegrationFailureKind,string>={offline:'Equipamento indisponível.',timeout:'Tempo de comunicação excedido.',authentication:'Credencial do equipamento recusada.',unsupported:'Recurso não validado para este equipamento.',invalid_input:'Dados ou cursor da integração inválidos.',aborted:'Consulta cancelada.'};
    super(messages[kind]);this.name='IntegrationError';this.kind=kind;this.retryable=kind==='offline'||kind==='timeout';
  }
}
