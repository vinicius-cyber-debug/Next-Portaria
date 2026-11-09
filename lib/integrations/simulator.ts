import {createHash} from 'node:crypto';
import {CAPABILITIES,IntegrationError} from './contracts.ts';
import type {CapabilityState,DeviceEvent,DeviceInspection,DevicePage,DeviceReadAdapter,DeviceUser,IntegrationFailureKind,PageRequest} from './contracts.ts';
type Fixtures={deviceId:string;users:DeviceUser[];events:DeviceEvent[]};
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&/^[a-zA-Z0-9_:.-]+$/.test(value);
const kinds=new Set(['authorization_granted','authorization_denied','passage_confirmed','passage_abandoned','unclassified']);
function validateEvent(event:DeviceEvent){
  if(!id(event.deviceId)||!id(event.generation)||!id(event.nativeEventId)||!id(event.sourceRevision)||(event.nativeUserId!==null&&!id(event.nativeUserId))||!kinds.has(event.kind)||!['entry','exit','unknown'].includes(event.direction)||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(event.occurredAt)||!Number.isFinite(Date.parse(event.occurredAt)))throw new IntegrationError('invalid_input');
}
/** Versions/updates and distinct devices/generations must not be deduplicated together. */
export function eventDeduplicationKey(event:DeviceEvent){
  validateEvent(event);
  return createHash('sha256').update(JSON.stringify([event.deviceId,event.generation,event.nativeEventId,event.sourceRevision,event.kind,event.occurredAt,event.nativeUserId,event.direction])).digest('hex');
}
/** Pure fixture simulator: no HTTP, discovery, SDK, filesystem or production registration. */
export class SimulatedDeviceAdapter implements DeviceReadAdapter {
  readonly mode='simulation' as const;
  private readonly fixtures:Fixtures;private readonly revision:string;private readonly now:()=>string;
  private failure:IntegrationFailureKind|null=null;
  constructor(fixtures:Fixtures,now=()=>new Date().toISOString()){
    if(!id(fixtures.deviceId)||!Array.isArray(fixtures.users)||!Array.isArray(fixtures.events))throw new IntegrationError('invalid_input');
    for(const user of fixtures.users)if(!id(user.nativeUserId)||(user.displayName!==undefined&&(typeof user.displayName!=='string'||user.displayName.length>150)))throw new IntegrationError('invalid_input');
    for(const event of fixtures.events){validateEvent(event);if(event.deviceId!==fixtures.deviceId)throw new IntegrationError('invalid_input');}
    this.fixtures=structuredClone(fixtures);this.now=now;this.revision=createHash('sha256').update(JSON.stringify(this.fixtures)).digest('hex');
  }
  setFailure(failure:IntegrationFailureKind|null){this.failure=failure;}
  private check(signal?:AbortSignal){if(signal?.aborted)throw new IntegrationError('aborted');if(this.failure)throw new IntegrationError(this.failure);}
  async inspect(signal?:AbortSignal):Promise<DeviceInspection>{
    this.check(signal);const supported=new Set(['inspect','readUsers','readEvents','confirmedPassage']);
    const capabilities=Object.fromEntries(CAPABILITIES.map(key=>[key,{support:supported.has(key)?'supported':'unsupported',evidence:'simulation',firmware:'fixture-v1'}])) as Record<(typeof CAPABILITIES)[number],CapabilityState>;
    return {deviceId:this.fixtures.deviceId,manufacturer:'simulator',model:'fixture',firmware:'fixture-v1',serial:'fixture-only',observedAt:this.now(),mode:'simulation',capabilities};
  }
  private page<T>(collection:'users'|'events',items:T[],request:PageRequest):DevicePage<T>{
    this.check(request.signal);const limit=request.limit??25;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new IntegrationError('invalid_input');let offset=0;
    if(request.cursor){
      if(request.cursor.length>1024)throw new IntegrationError('invalid_input');
      let parsed:unknown;try{parsed=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));}catch{throw new IntegrationError('invalid_input');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new IntegrationError('invalid_input');
      const data=parsed as {revision?:unknown;collection?:unknown;offset?:unknown};
      if(data.revision!==this.revision||data.collection!==collection||typeof data.offset!=='number'||!Number.isSafeInteger(data.offset)||data.offset<0||data.offset>=items.length)throw new IntegrationError('invalid_input');offset=data.offset;
    }
    const end=Math.min(items.length,offset+limit),nextCursor=end<items.length?Buffer.from(JSON.stringify({revision:this.revision,collection,offset:end})).toString('base64url'):null;
    return {items:structuredClone(items.slice(offset,end)),nextCursor,observedAt:this.now()};
  }
  async readUsers(request:PageRequest={}){return this.page('users',this.fixtures.users,request);}
  async readEvents(request:PageRequest={}){return this.page('events',this.fixtures.events,request);}
}
