import {calendarCharge,cents,fail,instant,localDay,text} from './domain.mjs';
export const PAYMENT_METHODS=['dinheiro','pix','debito','credito','transferencia'];
export function chargePreview(entry,end,unitCents,mode='diaria'){
 if(!['acesso','diaria'].includes(mode))fail('VALIDATION','Modalidade de cobrança inválida.');
 const value=calendarCharge(entry,end,unitCents);
 return {...value,modalidade:mode,quantidade:mode==='acesso'?1:value.diarias,totalCentavos:mode==='acesso'?unitCents:value.totalCentavos};
}
export function amount(value){if(!Number.isSafeInteger(value)||value<=0)fail('VALIDATION','Informe um valor positivo em centavos inteiros.');return value}
export function cashAmount(value){if(!Number.isSafeInteger(value)||value<0)fail('VALIDATION','Informe um valor não negativo em centavos inteiros.');return value}
export function parseMoney(value,allowZero=false){
 if(typeof value!=='string'||value.length>32||!/^\d+(?:[,.]\d{1,2})?$/.test(value.trim()))fail('VALIDATION','Informe reais sem separador de milhar, por exemplo 150,00.');
 const [whole,fraction='']=value.trim().split(/[,.]/),result=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(result>BigInt(Number.MAX_SAFE_INTEGER))fail('AMOUNT_OVERFLOW','Valor fora do intervalo seguro.');return allowZero?cashAmount(Number(result)):amount(Number(result));
}
export function balance(gross,discounts,paid){
 for(const value of [gross,discounts,paid])cashAmount(value);
 if(discounts>gross||paid>gross-discounts)fail('BALANCE_CONFLICT','O valor excede o saldo disponível.',409);
 return {brutoCentavos:gross,descontosCentavos:discounts,liquidoCentavos:gross-discounts,pagoCentavos:paid,saldoCentavos:gross-discounts-paid,situacao:paid===gross-discounts?'quitada':paid>0?'parcial':'pendente'};
}
export function paymentInput(payload){const value=amount(payload.valorCentavos),method=text(payload.metodo,'Forma de pagamento',30);if(!PAYMENT_METHODS.includes(method))fail('VALIDATION','Forma de pagamento inválida.');return {valorCentavos:value,metodo:method,referencia:method==='dinheiro'?(payload.referencia?text(payload.referencia,'Referência',150):''):text(payload.referencia,'Referência do recebimento',150)}}
export function reportPeriod(query,now){
 const last=localDay(now),first=new Date(Date.parse(last+'T12:00:00Z')-29*86400000).toISOString().slice(0,10),start=query.get('inicio')||first,end=query.get('fim')||last;
 for(const value of [start,end]){if(!/^\d{4}-\d\d-\d\d$/.test(value))fail('VALIDATION','Período inválido.');instant(value+'T12:00:00Z')}
 const days=(Date.parse(end+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000+1;
 if(days<1||days>366)fail('VALIDATION','Escolha um período de até 366 dias.');
 return {inicio:start,fim:end};
}
export function tariffMode(value){const mode=value??'acesso';if(!['acesso','diaria'].includes(mode))fail('VALIDATION','Modalidade inválida.');return mode}
export {cents};
