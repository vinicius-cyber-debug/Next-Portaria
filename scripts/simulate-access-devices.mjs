import {SimulatedDeviceAdapter,eventDeduplicationKey} from '../lib/integrations/simulator.ts';
import {CONTROL_ID_PREPARATION} from '../lib/integrations/controlid-preparation.ts';
const deviceId='simulated-gate-a',event={deviceId,generation:'fixture-1',nativeEventId:'9007199254740993',sourceRevision:'v1',occurredAt:'2026-11-06T12:00:00Z',nativeUserId:'fake-person-1',direction:'entry',kind:'authorization_granted'};
const adapter=new SimulatedDeviceAdapter({deviceId,users:[{nativeUserId:'fake-person-1',displayName:'Pessoa fictícia'}],events:[event,event,{...event,sourceRevision:'v2',kind:'passage_abandoned'}]});
const page=await adapter.readEvents();
console.log(JSON.stringify({mode:'simulation',hardwareConnected:false,databaseChanged:false,device:await adapter.inspect(),eventsReceived:page.items.length,eventVersions:new Set(page.items.map(eventDeduplicationKey)).size,controlIdReadiness:CONTROL_ID_PREPARATION.status},null,2));
