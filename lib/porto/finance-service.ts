import {randomUUID} from 'node:crypto';
import type {PoolClient,QueryResultRow} from 'pg';
import type {MediaUser} from '../persistence/contracts.ts';
import {PORTO_UNIT,fail,localDay,portoPermissions,requirePorto,text} from './domain.mjs';
import {amount,cashAmount,chargePreview,paymentInput,reportPeriod} from './finance-domain.mjs';
type Row=QueryResultRow;
const uuid=(prefix:string)=>prefix+'_'+randomUUID();
const numeric=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n))fail('AMOUNT_OVERFLOW','Total fora do intervalo seguro.');return n};
const state=(row:Row)=>numeric(row.saldo_centavos)===0?'quitada':numeric(row.pago_centavos)>0?'parcial':'pendente';
export const FINANCE_ACTIONS:Record<string,'pay'|'adjust'|'exit'|'cashClose'>={DEFINIR_PAGADOR:'pay',REGISTRAR_PAGAMENTO:'pay',ESTORNAR_PAGAMENTO:'adjust',CONCEDER_DESCONTO:'adjust',ESTORNAR_DESCONTO:'adjust',REGISTRAR_SAIDA:'exit',FECHAR_CAIXA:'cashClose'};
export class PortoFinance {
 readonly client:PoolClient;readonly user:MediaUser;readonly now:string;
 constructor(client:PoolClient,user:MediaUser,now:string){this.client=client;this.user=user;this.now=now}
 private async event(action:string,entity:string,data:Row){await this.client.query('INSERT INTO porto_eventos(id,unidade_id,entidade_id,acao,ator_id,ator_nome,dados) VALUES($1,$2,$3,$4,$5,$6,$7)',[uuid('pe'),PORTO_UNIT,entity,action,this.user.id,this.user.name,JSON.stringify(data)])}
 async account(id:string){
  const result=await this.client.query(`SELECT p.*,r.embarcacao_destino,r.finalidade,pg.id AS pagador_id,pg.empresa_id,pg.empresa_nome,c.id AS cobranca_id,c.numero AS cobranca_numero,c.vencimento,s.* FROM porto_permanencias p JOIN porto_solicitacoes r ON r.id=p.solicitacao_id LEFT JOIN LATERAL(SELECT * FROM porto_pagadores WHERE permanencia_id=p.id ORDER BY sequencia DESC LIMIT 1) pg ON true LEFT JOIN porto_cobrancas c ON c.permanencia_id=p.id CROSS JOIN LATERAL porto_saldo(p.id,$2) s WHERE p.id=$1 AND p.unidade_id=$3 FOR UPDATE OF p`,[id,this.now,PORTO_UNIT]);
  const row=result.rows[0];if(!row)fail('NOT_FOUND','Permanência não encontrada.',404);return row;
 }
 private async saldo(id:string){const result=(await this.client.query('SELECT * FROM porto_saldo($1,$2)',[id,this.now])).rows[0];return {...result,situacao:state(result)}}
 async execute(type:string,payload:Row):Promise<Row>{
  requirePorto(this.user,FINANCE_ACTIONS[type]);
  if(type==='FECHAR_CAIXA')return this.closeCash(payload);
  const stayId=text(payload.permanenciaId??payload.id,'Permanência',120),account=await this.account(stayId),reason=text(payload.justificativa,'Justificativa',500);
  if(type==='DEFINIR_PAGADOR'){
   if(account.status!=='em_andamento'||numeric(account.pago_centavos)!==0)fail('PAYER_FROZEN','O pagador não pode ser alterado após o recebimento ou a saída.',409);
   const companyId=text(payload.empresaId,'Empresa pagadora',120),company=(await this.client.query("SELECT body FROM operational_records WHERE collection='companies' AND id=$1 FOR UPDATE",[companyId])).rows[0];
   if(!company)fail('NOT_FOUND','Empresa não encontrada no cadastro.',404);const record=JSON.parse(company.body);if(record.active===false)fail('COMPANY_INACTIVE','A empresa está desativada.');
   const payer=uuid('ppg');await this.client.query('INSERT INTO porto_pagadores(id,permanencia_id,empresa_id,empresa_nome,definido_em,definido_por,justificativa) VALUES($1,$2,$3,$4,$5,$6,$7)',[payer,stayId,companyId,text(record.name,'Nome da empresa',150),this.now,this.user.id,reason]);
   await this.event(type,stayId,{pagadorId:payer,empresaId:companyId,empresaNome:record.name,justificativa:reason});return {id:payer,permanenciaId:stayId};
  }
  if(type==='REGISTRAR_SAIDA'){
   if(account.status!=='em_andamento')fail('ALREADY_CLOSED','A saída já foi registrada.',409);
   if(payload.veiculoConferido!==true)fail('IDENTITY_REQUIRED','Confirme a conferência do veículo na saída.');
   if(!account.pagador_id)fail('PAYER_REQUIRED','O financeiro precisa identificar a empresa pagadora antes da saída.',409);
   if(numeric(account.saldo_centavos)!==0)fail('EXIT_REQUIRES_SETTLEMENT','Saída bloqueada: aguarde o financeiro confirmar a quitação.',409);
   const preview=chargePreview(account.entrada_em.toISOString(),this.now,numeric(account.valor_diaria_centavos),account.modalidade_cobranca),invoice=uuid('pc');
   await this.client.query("UPDATE porto_permanencias SET status='encerrada',saida_em=$2,saida_operador_id=$3 WHERE id=$1",[stayId,this.now,this.user.id]);
   const result=(await this.client.query('INSERT INTO porto_cobrancas(id,unidade_id,permanencia_id,pagador_id,modalidade,quantidade,valor_unitario_centavos,bruto_centavos,emitida_em,vencimento,emitida_por) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[invoice,PORTO_UNIT,stayId,account.pagador_id,account.modalidade_cobranca,preview.quantidade,account.valor_diaria_centavos,preview.totalCentavos,this.now,localDay(this.now),this.user.id])).rows[0];
   await this.event(type,stayId,{cobrancaId:invoice,saidaEm:this.now,quantidade:preview.quantidade,modalidade:account.modalidade_cobranca,brutoCentavos:preview.totalCentavos,justificativa:reason});return {id:stayId,cobranca:result};
  }
  if(type==='REGISTRAR_PAGAMENTO'){
   if(!account.pagador_id)fail('PAYER_REQUIRED','Identifique a empresa pagadora antes do recebimento.');
   const payment=paymentInput(payload);if(payment.valorCentavos>numeric(account.saldo_centavos))fail('PAYMENT_OVER_BALANCE','O recebimento excede o saldo disponível.',409);
   const paymentId=uuid('ppa'),kind=account.status==='em_andamento'?'adiantamento':'pagamento';
   const result=(await this.client.query('INSERT INTO porto_pagamentos(id,permanencia_id,pagador_id,tipo,valor_centavos,metodo,referencia,justificativa,ocorrido_em,ator_id,ator_nome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[paymentId,stayId,account.pagador_id,kind,payment.valorCentavos,payment.metodo,payment.referencia,reason,this.now,this.user.id,this.user.name])).rows[0];
   await this.event(type,paymentId,{permanenciaId:stayId,tipo:kind,valorCentavos:payment.valorCentavos,metodo:payment.metodo,justificativa:reason});return {...result,saldo:await this.saldo(stayId)};
  }
  if(type==='ESTORNAR_PAGAMENTO'){
   const originId=text(payload.origemId,'Recebimento de origem',120),origin=(await this.client.query("SELECT p.*,p.valor_centavos-COALESCE((SELECT sum(valor_centavos) FROM porto_pagamentos e WHERE e.origem_id=p.id),0)::bigint AS restante FROM porto_pagamentos p WHERE p.id=$1 AND p.permanencia_id=$2 AND p.tipo<>'estorno'",[originId,stayId])).rows[0];
   if(!origin)fail('NOT_FOUND','Recebimento de origem não encontrado.',404);const value=amount(payload.valorCentavos);if(value>numeric(origin.restante))fail('REVERSAL_OVER_BALANCE','O estorno excede o valor ainda não estornado.',409);
   const paymentId=uuid('ppe'),result=(await this.client.query("INSERT INTO porto_pagamentos(id,permanencia_id,pagador_id,tipo,origem_id,valor_centavos,metodo,referencia,justificativa,ocorrido_em,ator_id,ator_nome) VALUES($1,$2,$3,'estorno',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[paymentId,stayId,origin.pagador_id,originId,value,origin.metodo,origin.referencia,reason,this.now,this.user.id,this.user.name])).rows[0];
   await this.event(type,paymentId,{permanenciaId:stayId,origemId:originId,valorCentavos:value,justificativa:reason});return {...result,saldo:await this.saldo(stayId)};
  }
  if(type==='CONCEDER_DESCONTO'||type==='ESTORNAR_DESCONTO'){
   let value:number,originId:string|null=null;
   if(type==='CONCEDER_DESCONTO'){value=amount(payload.valorCentavos);if(value>numeric(account.saldo_centavos))fail('DISCOUNT_OVER_BALANCE','O desconto excede o saldo em aberto.',409)}
   else{originId=text(payload.origemId,'Desconto de origem',120);const origin=(await this.client.query("SELECT * FROM porto_ajustes WHERE id=$1 AND permanencia_id=$2 AND tipo='desconto'",[originId,stayId])).rows[0];if(!origin)fail('NOT_FOUND','Desconto não encontrado.',404);if((await this.client.query('SELECT 1 FROM porto_ajustes WHERE origem_id=$1',[originId])).rowCount)fail('ALREADY_REVERSED','O desconto já foi estornado.',409);value=numeric(origin.valor_centavos)}
   const adjustment=uuid('paj');await this.client.query('INSERT INTO porto_ajustes(id,permanencia_id,tipo,origem_id,valor_centavos,justificativa,ocorrido_em,ator_id,ator_nome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[adjustment,stayId,type==='CONCEDER_DESCONTO'?'desconto':'estorno_desconto',originId,value,reason,this.now,this.user.id,this.user.name]);
   await this.event(type,adjustment,{permanenciaId:stayId,origemId:originId,valorCentavos:value,justificativa:reason});return {id:adjustment,saldo:await this.saldo(stayId)};
  }
  fail('VALIDATION','Comando financeiro inválido.');
 }
 private async cashSummary(){
  const rows=(await this.client.query("SELECT p.metodo,sum(CASE WHEN p.tipo='estorno' THEN -p.valor_centavos ELSE p.valor_centavos END) AS liquido,count(*) AS quantidade FROM porto_pagamentos p JOIN porto_permanencias s ON s.id=p.permanencia_id WHERE s.unidade_id=$1 AND NOT EXISTS(SELECT 1 FROM porto_caixa_itens i WHERE i.pagamento_id=p.id) GROUP BY p.metodo",[PORTO_UNIT])).rows;
  const methods:Record<string,number>={dinheiro:0,pix:0,debito:0,credito:0,transferencia:0};let quantity=0;for(const row of rows){methods[row.metodo]=numeric(row.liquido);quantity+=numeric(row.quantidade)}
  return {metodosCentavos:methods,totalCentavos:numeric(Object.values(methods).reduce((a,b)=>a+b,0)),quantidade:quantity};
 }
 private async closeCash(payload:Row){
  const opening=cashAmount(payload.saldoInicialCentavos),counted=cashAmount(payload.dinheiroConferidoCentavos),reason=text(payload.justificativa,'Justificativa do fechamento',500),summary=await this.cashSummary();
  if(!summary.quantidade)fail('EMPTY_CASH','Não há novos movimentos para fechar.',409);
  const expected=numeric(opening+summary.metodosCentavos.dinheiro),difference=numeric(counted-expected);if(expected<0)fail('CASH_OPENING_REQUIRED','O saldo inicial informado não cobre as devoluções em dinheiro.');
  const closing=uuid('pfc'),result=(await this.client.query('INSERT INTO porto_caixa_fechamentos(id,unidade_id,fechado_em,fechado_por,operador_nome,saldo_inicial_centavos,dinheiro_conferido_centavos,dinheiro_esperado_centavos,diferenca_centavos,resumo,justificativa) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[closing,PORTO_UNIT,this.now,this.user.id,this.user.name,opening,counted,expected,difference,JSON.stringify({metodosCentavos:summary.metodosCentavos,totalCentavos:summary.totalCentavos,quantidade:summary.quantidade}),reason])).rows[0];
  await this.client.query('INSERT INTO porto_caixa_itens(fechamento_id,pagamento_id) SELECT $1,p.id FROM porto_pagamentos p JOIN porto_permanencias s ON s.id=p.permanencia_id WHERE s.unidade_id=$2 AND NOT EXISTS(SELECT 1 FROM porto_caixa_itens i WHERE i.pagamento_id=p.id)',[closing,PORTO_UNIT]);
  await this.event('FECHAR_CAIXA',closing,{quantidade:summary.quantidade,totalCentavos:summary.totalCentavos,diferencaCentavos:difference,justificativa:reason});return result;
 }
 async read(path:string,query:URLSearchParams):Promise<Row|null>{
  if(!['contas','caixa','relatorios','recibos','cobrancas'].some(value=>path===value||path.startsWith(value+'/')))return null;
  requirePorto(this.user,'financial');
  const index=Number(query.get('page')||1),size=Number(query.get('pageSize')||20);if(!Number.isSafeInteger(index)||index<1||index>1000000||!Number.isSafeInteger(size)||size<1||size>50)fail('VALIDATION','Paginação inválida.');
  if(path==='contas'){
   const q=(query.get('q')||'').trim(),status=query.get('status')||'';if(q.length>150||!['','pendente','parcial','quitada'].includes(status))fail('VALIDATION','Filtro inválido.');
   const from=`FROM porto_permanencias p LEFT JOIN LATERAL(SELECT * FROM porto_pagadores WHERE permanencia_id=p.id ORDER BY sequencia DESC LIMIT 1) pg ON true LEFT JOIN porto_cobrancas c ON c.permanencia_id=p.id CROSS JOIN LATERAL porto_saldo(p.id,$2) s WHERE p.unidade_id=$1 AND position(lower($3) in lower(p.placa||' '||p.motorista_nome||' '||COALESCE(pg.empresa_nome,'')))>0 AND ($4='' OR CASE WHEN s.saldo_centavos=0 THEN 'quitada' WHEN s.pago_centavos>0 THEN 'parcial' ELSE 'pendente' END=$4)`;
   const args=[PORTO_UNIT,this.now,q,status],count=numeric((await this.client.query('SELECT count(*) AS n '+from,args)).rows[0].n);
   const rows=(await this.client.query('SELECT p.*,pg.empresa_nome,pg.empresa_id,pg.id AS pagador_id,c.id AS cobranca_id,c.numero AS cobranca_numero,c.vencimento,s.* '+from+' ORDER BY p.entrada_em DESC,p.id LIMIT $5 OFFSET $6',[...args,size,(index-1)*size])).rows.map(row=>({...row,situacao_financeira:state(row)}));
   return {rows,total:count,totalPages:Math.max(1,Math.ceil(count/size)),page:index,agora:this.now};
  }
  if(path.startsWith('contas/')){
   const account=await this.account(path.slice(7)),payments=(await this.client.query('SELECT p.*,COALESCE((SELECT sum(valor_centavos) FROM porto_pagamentos e WHERE e.origem_id=p.id),0)::bigint AS estornado_centavos FROM porto_pagamentos p WHERE permanencia_id=$1 ORDER BY numero DESC LIMIT 200',[account.id])).rows,adjustments=(await this.client.query('SELECT a.*,EXISTS(SELECT 1 FROM porto_ajustes e WHERE e.origem_id=a.id) AS estornado FROM porto_ajustes a WHERE permanencia_id=$1 ORDER BY ocorrido_em DESC,id LIMIT 200',[account.id])).rows;
   return {conta:{...account,situacao_financeira:state(account)},pagamentos:payments,ajustes:adjustments,limiteHistorico:200};
  }
  if(path.startsWith('recibos/')){
   const payment=(await this.client.query('SELECT x.*,pg.empresa_nome,p.placa,p.motorista_nome,p.entrada_em,p.modalidade_cobranca,p.valor_diaria_centavos,COALESCE((SELECT sum(valor_centavos) FROM porto_pagamentos e WHERE e.origem_id=x.id),0)::bigint AS estornado_centavos FROM porto_pagamentos x JOIN porto_pagadores pg ON pg.id=x.pagador_id JOIN porto_permanencias p ON p.id=x.permanencia_id WHERE x.id=$1 AND p.unidade_id=$2',[path.slice(8),PORTO_UNIT])).rows[0];if(!payment)fail('NOT_FOUND','Recibo não encontrado.',404);
   return {recibo:payment,unidade:(await this.client.query("SELECT body FROM operational_settings WHERE id=$1",[PORTO_UNIT])).rows[0]?.body,naoFiscal:true};
  }
  if(path.startsWith('cobrancas/')){
   const invoice=(await this.client.query('SELECT c.*,p.placa,p.motorista_nome,p.entrada_em,p.saida_em,pg.empresa_nome,s.* FROM porto_cobrancas c JOIN porto_permanencias p ON p.id=c.permanencia_id JOIN porto_pagadores pg ON pg.id=c.pagador_id CROSS JOIN LATERAL porto_saldo(p.id,$3) s WHERE c.id=$1 AND c.unidade_id=$2',[path.slice(10),PORTO_UNIT,this.now])).rows[0];if(!invoice)fail('NOT_FOUND','Cobrança não encontrada.',404);return {cobranca:invoice,naoFiscal:true};
  }
  if(path==='caixa'){
   requirePorto(this.user,'cashClose');const summary=await this.cashSummary(),rows=(await this.client.query('SELECT * FROM porto_caixa_fechamentos WHERE unidade_id=$1 ORDER BY numero DESC LIMIT $2 OFFSET $3',[PORTO_UNIT,size,(index-1)*size])).rows,count=numeric((await this.client.query('SELECT count(*) AS n FROM porto_caixa_fechamentos WHERE unidade_id=$1',[PORTO_UNIT])).rows[0].n);
   return {aberto:{metodosCentavos:summary.metodosCentavos,totalCentavos:summary.totalCentavos,quantidade:summary.quantidade},rows,total:count,totalPages:Math.max(1,Math.ceil(count/size)),page:index};
  }
  if(path.startsWith('caixa/')){requirePorto(this.user,'cashClose');const closing=(await this.client.query('SELECT * FROM porto_caixa_fechamentos WHERE id=$1 AND unidade_id=$2',[path.slice(6),PORTO_UNIT])).rows[0];if(!closing)fail('NOT_FOUND','Fechamento não encontrado.',404);const items=(await this.client.query('SELECT p.* FROM porto_pagamentos p JOIN porto_caixa_itens i ON i.pagamento_id=p.id WHERE i.fechamento_id=$1 ORDER BY p.numero',[closing.id])).rows;return {fechamento:closing,movimentos:items}}
  if(path==='relatorios'||path==='relatorios/exportar'){
   if(path.endsWith('/exportar'))requirePorto(this.user,'export');
   const result=await this.report(query);if(!path.endsWith('/exportar'))return result;
   const cell=(value:unknown)=>'"'+String(value??'').replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')+'"';
   const lines=[['Relatório por categoria — centavos inteiros','Categoria','Recebido líquido (centavos)','Movimentos'],...result.categorias.map((row:Row)=>[row.categoriaCodigo??row.categoria_codigo,row.categoria_nome,row.recebido_liquido_centavos,row.movimentos])];
   return {nome:`porto-${result.periodo.inicio}-${result.periodo.fim}.csv`,csv:'\uFEFF'+lines.map(row=>row.map(cell).join(';')).join('\r\n')};
  }
  fail('NOT_FOUND','Consulta financeira não encontrada.',404);
 }
 private async report(query:URLSearchParams){
  const period=reportPeriod(query,this.now),category=(query.get('categoria')||'').trim(),company=(query.get('empresa')||'').trim();if(category.length>40||company.length>120)fail('VALIDATION','Filtro inválido.');
  const args=[PORTO_UNIT,period.inicio,period.fim,category,company,this.now],filter="p.unidade_id=$1 AND ($4='' OR p.categoria_codigo=$4) AND ($5='' OR pg.empresa_id=$5)",payer="LEFT JOIN LATERAL(SELECT * FROM porto_pagadores WHERE permanencia_id=p.id ORDER BY sequencia DESC LIMIT 1) pg ON true";
  return this.reportData(args,filter,payer,period);
 }
 private async reportData(args:unknown[],filter:string,payer:string,period:{inicio:string;fim:string}){
  const start="($2::date::timestamp AT TIME ZONE 'America/Manaus')",end="(($3::date+1)::timestamp AT TIME ZONE 'America/Manaus')";
  const cte=`WITH base AS(SELECT p.*,pg.empresa_nome,pg.empresa_id,s.* FROM porto_permanencias p ${payer} CROSS JOIN LATERAL porto_saldo(p.id,$6) s WHERE ${filter}), cash AS(SELECT x.*,p.categoria_codigo,p.categoria_nome FROM porto_pagamentos x JOIN porto_permanencias p ON p.id=x.permanencia_id JOIN porto_pagadores pg ON pg.id=x.pagador_id WHERE ${filter} AND x.ocorrido_em>=${start} AND x.ocorrido_em<${end}) `;
  const summary=(await this.client.query(cte+`SELECT (SELECT count(*) FROM base WHERE entrada_em>=${start} AND entrada_em<${end}) AS entradas,(SELECT count(*) FROM base WHERE saida_em>=${start} AND saida_em<${end}) AS saidas,(SELECT COALESCE(avg(extract(epoch FROM saida_em-entrada_em)),0) FROM base WHERE saida_em>=${start} AND saida_em<${end})::float8 AS permanencia_media_segundos,(SELECT COALESCE(sum(c.bruto_centavos),0) FROM porto_cobrancas c JOIN base b ON b.id=c.permanencia_id WHERE c.emitida_em>=${start} AND c.emitida_em<${end}) AS cobrado_bruto_centavos,(SELECT COALESCE(sum(valor_centavos) FILTER(WHERE tipo<>'estorno'),0) FROM cash) AS recebido_bruto_centavos,(SELECT COALESCE(sum(valor_centavos) FILTER(WHERE tipo='estorno'),0) FROM cash) AS estornado_centavos,(SELECT COALESCE(sum(CASE WHEN tipo='estorno' THEN -valor_centavos ELSE valor_centavos END),0) FROM cash) AS recebido_liquido_centavos,(SELECT COALESCE(sum(saldo_centavos),0) FROM base WHERE status='em_andamento') AS saldo_acessos_centavos,(SELECT COALESCE(sum(saldo_centavos),0) FROM base WHERE status='encerrada') AS saldo_cobrancas_centavos,(SELECT COALESCE(sum(b.saldo_centavos),0) FROM base b JOIN porto_cobrancas c ON c.permanencia_id=b.id WHERE c.vencimento<($6::timestamptz AT TIME ZONE 'America/Manaus')::date AND b.saldo_centavos>0) AS vencido_centavos`,args)).rows[0];
  const categories=(await this.client.query(cte+"SELECT categoria_codigo,categoria_nome,sum(CASE WHEN tipo='estorno' THEN -valor_centavos ELSE valor_centavos END)::bigint AS recebido_liquido_centavos,count(*) AS movimentos FROM cash GROUP BY categoria_codigo,categoria_nome ORDER BY categoria_nome",args)).rows;
  const days=(await this.client.query(cte+"SELECT (ocorrido_em AT TIME ZONE 'America/Manaus')::date AS dia,sum(CASE WHEN tipo='estorno' THEN -valor_centavos ELSE valor_centavos END)::bigint AS recebido_liquido_centavos,count(*) AS movimentos FROM cash GROUP BY dia ORDER BY dia",args)).rows;
  for(const [key,value] of Object.entries(summary))if(key!=='permanencia_media_segundos')summary[key]=numeric(value);
  return {periodo:period,agora:this.now,resumo:summary,categorias:categories,dias:days,exportar:portoPermissions(this.user).export};
 }
}
