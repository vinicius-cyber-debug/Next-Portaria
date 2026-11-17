import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorConnectionFresh,relativeEventTime} from '../lib/monitor-freshness.mjs';
const now=Date.parse('2026-11-17T12:00:00Z');
test('conexão recente e evento antigo são informações independentes',()=>{
 assert.equal(monitorConnectionFresh({status:'connected',lastSuccessAt:new Date(now).toISOString(),events:[{occurredAt:'2026-11-15T12:00:00Z'}]},now),true);
 assert.equal(relativeEventTime('2026-11-15T12:00:00Z',now),'Há 2 dias');
});
test('consulta vencida, inválida ou com relógio adiantado não indica conexão atual',()=>{
 for(const lastSuccessAt of [null,'invalid',new Date(now-31000).toISOString(),new Date(now+61000).toISOString()])assert.equal(monitorConnectionFresh({status:'connected',lastSuccessAt},now),false);
 assert.equal(monitorConnectionFresh({status:'offline',lastSuccessAt:new Date(now).toISOString()},now),false);
 assert.equal(relativeEventTime('invalid',now),'Horário indisponível');
 assert.equal(relativeEventTime(new Date(now+61000).toISOString(),now),'Horário à frente do relógio desta tela');
});
