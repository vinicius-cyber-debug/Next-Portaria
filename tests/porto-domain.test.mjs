import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarCharge,localDay,fromManausLocal,parseDailyPrice,portoPermissions,tariffTable,portRequest} from '../lib/porto/domain.mjs';

for(const [name,entry,end,days] of [
 ['mesma data','2026-11-07T08:00:00-04:00','2026-11-07T23:59:59-04:00',1],
 ['dois minutos cruzando meia-noite','2026-11-07T23:59:00-04:00','2026-11-08T00:01:00-04:00',2],
 ['cinco datas','2026-11-07T23:59:00-04:00','2026-11-11T00:01:00-04:00',5],
 ['virada de mes','2026-11-30T23:59:00-04:00','2026-12-01T00:00:00-04:00',2],
 ['virada de ano','2026-12-31T23:59:00-04:00','2027-01-01T00:00:00-04:00',2],
 ['ano bissexto','2028-02-28T23:59:00-04:00','2028-03-01T00:00:00-04:00',3],
 ['UTC muda mas Manaus permanece na mesma data','2026-11-07T23:59:00Z','2026-11-08T03:59:00Z',1],
 ['meia-noite Manaus em UTC','2026-11-08T03:59:00Z','2026-11-08T04:00:00Z',2],
 ['primeira diaria imediata','2026-11-07T12:00:00Z','2026-11-07T12:00:00Z',1]
])test('Porto: diária por calendário · '+name,()=>{const result=calendarCharge(entry,end,15000);assert.equal(result.diarias,days);assert.equal(result.totalCentavos,days*15000);assert.equal(result.fuso,'America/Manaus')});
test('Porto: rejeita período negativo, datas inexistentes, fuso ausente e centavos fracionários',()=>{
 for(const run of [()=>calendarCharge('2026-11-07T00:01:00Z','2026-11-07T00:00:00Z',10000),()=>localDay('2026-02-30T00:00:00Z'),()=>localDay('2026-11-07T12:00:00'),()=>calendarCharge('2026-11-07T12:00:00Z','2026-11-07T12:00:00Z',100.5)])assert.throws(run);
});
test('Porto: conversão decimal exata, sem float monetário',()=>{assert.equal(parseDailyPrice('150,01'),15001);assert.equal(parseDailyPrice('0.10'),10);assert.equal(parseDailyPrice('300'),30000);for(const value of ['1.000,00','0','-1','1,001','NaN','Infinity'])assert.throws(()=>parseDailyPrice(value))});
test('Porto: vigência digitada é interpretada em Manaus, independente do computador',()=>{assert.equal(fromManausLocal('2026-11-07T00:00'),'2026-11-07T04:00:00.000Z');assert.equal(fromManausLocal('2026-12-31T23:59'),'2027-01-01T03:59:00.000Z');assert.throws(()=>fromManausLocal('2026-02-30T10:00'))});
test('Porto: matriz aprovada é independente dos comandos financeiros aposentados',()=>{
 const permissions=role=>portoPermissions({role,status:'active'});
 assert.equal(permissions('gate').request,true);assert.equal(permissions('gate').approve,false);assert.equal(permissions('gate').financial,false);
 assert.equal(permissions('director').entry,true);assert.equal(permissions('director').tariffs,false);
 assert.equal(permissions('finance').financial,true);assert.equal(permissions('finance').entry,false);
 assert.equal(permissions('operations').view,false);assert.equal(permissions('reader').view,false);
 assert.equal(portoPermissions({role:'gate',status:'active',overrides:{gateOperate:false}}).entry,false);
 assert.ok(Object.values(permissions('admin')).every(Boolean));assert.ok(Object.values(portoPermissions({role:'admin',status:'disabled'})).every(value=>!value));
});
test('Porto: tarifas exigem categoria única, valor positivo, motivo e vigência não retroativa',()=>{
 const now='2026-11-07T12:00:00.000Z',payload={nome:'Tabela QA',justificativa:'Teste',tarifas:[{codigo:'caminhao',nome:'Caminhão',valorDiariaCentavos:10000}]};
 assert.equal(tariffTable(payload,now).vigenciaInicio,now);
 for(const invalid of [{...payload,tarifas:[...payload.tarifas,...payload.tarifas]},{...payload,justificativa:''},{...payload,vigenciaInicio:'2026-11-06T00:00:00Z'}])assert.throws(()=>tariffTable(invalid,now));
 assert.throws(()=>portRequest({veiculoId:'v',motoristaNome:'QA',categoriaCodigo:'carro',finalidade:'QA'}),/Embarcação/);
});
