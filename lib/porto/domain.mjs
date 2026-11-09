/** Independent vehicle-port domain. No legacy stay, invoice or payment commands. */
export const PORTO_TIMEZONE='America/Manaus';
export const PORTO_UNIT='settings'; // The current installation has one unit, owned by operational_settings.
export const MAX_DAILY_CENTS=1_000_000_000;
export class PortoError extends Error {
 constructor(code,message,status=400){super(message);this.name='PortoError';this.code=code;this.status=status;}
}
/** @returns {never} */
export function fail(code,message,status=400){throw new PortoError(code,message,status)}
export function text(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail('VALIDATION',`${label} inválido.`);return value.trim()}
export function instant(value,label='Data'){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))fail('VALIDATION',`${label} inválida. Informe o fuso ou o deslocamento UTC.`);
 const date=new Date(value);if(date.getUTCFullYear()<2000||date.getUTCFullYear()>9999)fail('VALIDATION',`${label} fora do intervalo suportado.`);
 const day=Number(value.slice(8,10)),month=Number(value.slice(5,7)),year=Number(value.slice(0,4));
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())fail('VALIDATION',`${label} inválida.`);
 return date.toISOString();
}
export function cents(value){if(!Number.isSafeInteger(value)||value<=0||value>MAX_DAILY_CENTS)fail('VALIDATION','A diária deve ser um valor positivo em centavos inteiros, dentro do limite técnico.');return value}
export function parseDailyPrice(value){
 if(typeof value!=='string'||!/^\d+(?:[,.]\d{1,2})?$/.test(value.trim()))fail('VALIDATION','Informe a diária sem separador de milhar, por exemplo 150,00.');
 const [whole,fraction='']=value.trim().split(/[,.]/),amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(amount>BigInt(MAX_DAILY_CENTS))fail('VALIDATION','Diária acima do limite técnico.');return cents(Number(amount));
}
const localFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:PORTO_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export function localDay(value){const date=instant(value),parts=Object.fromEntries(localFormatter.formatToParts(new Date(date)).map(part=>[part.type,part.value]));return `${parts.year}-${parts.month}-${parts.day}`}
export function fromManausLocal(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))fail('VALIDATION','Vigência local inválida.');
 const nominal=instant(value+':00Z'),format=new Intl.DateTimeFormat('sv-SE',{timeZone:PORTO_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const local=format.format(new Date(nominal)).replace(' ','T'),offset=Date.parse(local+':00Z')-Date.parse(nominal),result=new Date(Date.parse(nominal)-offset).toISOString();
 if(format.format(new Date(result)).replace(' ','T')!==value)fail('VALIDATION','Horário local inexistente.');return result;
}
export function calendarCharge(entry,end,dailyCents){
 const start=instant(entry,'Entrada'),finish=instant(end,'Saída ou referência');cents(dailyCents);
 if(Date.parse(finish)<Date.parse(start))fail('INVALID_PERIOD','A saída ou referência não pode ser anterior à entrada.');
 const firstDay=localDay(start),lastDay=localDay(finish),days=(Date.parse(lastDay+'T00:00:00Z')-Date.parse(firstDay+'T00:00:00Z'))/86400000+1;
 const total=BigInt(days)*BigInt(dailyCents);if(total>BigInt(Number.MAX_SAFE_INTEGER))fail('AMOUNT_OVERFLOW','Valor acumulado fora do intervalo seguro.');
 return {diarias:days,valorDiariaCentavos:dailyCents,totalCentavos:Number(total),dataInicial:firstDay,dataFinal:lastDay,fuso:PORTO_TIMEZONE};
}
export function portoPermissions(user){
 const active=user?.status==='active',role=active?user.role:'';
 const financial=['admin','director','finance'].includes(role),operate=['admin','director','gate'].includes(role)&&(role==='admin'||user?.overrides?.gateOperate!==false);
 return {view:['admin','director','gate','finance'].includes(role),request:['admin','director','gate'].includes(role),approve:['admin','director'].includes(role),entry:operate,exit:operate,tariffs:role==='admin',financial,audit:['admin','director'].includes(role)&&(role==='admin'||user?.capabilities?.auditView!==false),pay:['admin','finance'].includes(role),adjust:['admin','director'].includes(role)&&(role==='admin'||user?.overrides?.exceptionApprove!==false),cashClose:['admin','finance'].includes(role),export:financial&&(role==='admin'||user?.overrides?.dataExport!==false)};
}
export function requirePorto(user,action){if(!portoPermissions(user)[action])fail('FORBIDDEN','Seu perfil não permite esta operação na Gestão do Porto.',403)}
export function categoryCode(value){const code=text(value,'Código da categoria',40);if(!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code))fail('VALIDATION','Use um código de categoria com 2 a 40 letras minúsculas, números, hífen ou sublinhado.');return code}
export function tariffTable(payload,now){
 const effective=payload.vigenciaInicio?instant(payload.vigenciaInicio,'Vigência'):now;
 if(Date.parse(effective)<Date.parse(now))fail('BACKDATED_TARIFF','Não é permitido publicar tarifa retroativa.');
 if(!Array.isArray(payload.tarifas)||!payload.tarifas.length||payload.tarifas.length>50)fail('VALIDATION','Informe de uma a 50 categorias de tarifa.');
 const entries=payload.tarifas.map(row=>({codigo:categoryCode(row?.codigo),nome:text(row?.nome,'Categoria',100),valorDiariaCentavos:cents(row?.valorDiariaCentavos)}));
 if(new Set(entries.map(row=>row.codigo)).size!==entries.length)fail('VALIDATION','A tabela contém categorias repetidas.');
 return {nome:text(payload.nome,'Nome da tabela',120),justificativa:text(payload.justificativa,'Justificativa',500),vigenciaInicio:effective,tarifas:entries};
}
export function portRequest(payload){return {veiculoId:text(payload.veiculoId,'Veículo',120),motoristaId:payload.motoristaId?text(payload.motoristaId,'Motorista cadastrado',120):null,motoristaNome:text(payload.motoristaNome,'Nome do motorista',150),categoriaCodigo:categoryCode(payload.categoriaCodigo),finalidade:text(payload.finalidade,'Finalidade',500),embarcacaoDestino:text(payload.embarcacaoDestino,'Embarcação de destino',150),observacoes:payload.observacoes?text(payload.observacoes,'Observações',1000):''}}
