# Automação externa de horários — prévia implementada

O processo externo calcula o estado esperado de saída, consulta a identidade e o equipamento na central iDSecure e grava estado durável. **Ainda não restringe nem libera a catraca.** Não existe adaptador de escrita homologado para a central instalada. `mode=live` e `hardwareWritesEnabled=true` são recusados antes de qualquer consulta ou envio. O processo é independente da interface; não altera banco, grupos, usuários, permissões ou configuração do dispositivo.

## Política solicitada

- Segunda a sábado, fuso `America/Manaus`.
- Restrição de 07:30 até antes de 11:00 e de 13:30 até antes de 17:00.
- Um funcionário, uma catraca e uma leitora no sentido de saída, fixados por identificadores. Não usar nome como chave de escrita.
- Fora dos intervalos ou com a regra desativada, o objetivo é restaurar a configuração anterior (`baseline`). Isso não significa conceder uma permissão que antes não existia.
- São recusados intervalos sobrepostos, dias inválidos e intervalos que cruzam a meia-noite. Estes exigem duas faixas explícitas em uma evolução do formato.

O cálculo é repetido a cada ciclo e após iniciar. Um reinício às 08:00 calcula a restrição vigente, sem depender de ter observado a transição às 07:30. A sequência de restrição, verificação, repetição sem duplicação, restauração e recuperação de divergência foi implementada **somente no simulador de testes**; o worker real continua sendo uma prévia.

## Operação local

A configuração privada fica em `.porto-runtime/access-schedule.json`, fora do Git. Exemplo sem dados reais:

```json
{
  "version": 1,
  "mode": "preview",
  "hardwareWritesEnabled": false,
  "pollSeconds": 30,
  "rule": {
    "id": "saida-expediente-teste",
    "version": 1,
    "enabled": true,
    "timeZone": "America/Manaus",
    "subject": {
      "personId": "pessoa-teste",
      "sourceId": "idsecure-main",
      "nativeUserId": "123",
      "expectedName": "Funcionário fictício"
    },
    "target": {
      "deviceId": "2",
      "readerId": "4",
      "direction": "exit",
      "expectedName": "Portaria de teste",
      "model": 17,
      "firmware": "CONFIRMAR"
    },
    "days": [1, 2, 3, 4, 5, 6],
    "windows": [
      {"start": "07:30", "end": "11:00"},
      {"start": "13:30", "end": "17:00"}
    ]
  }
}
```

Os identificadores de exemplo não são autorização para operar esses equipamentos. Use o vínculo confirmado da instalação. O adaptador lê sua configuração privada existente de `.porto-runtime/idsecure.json`, com certificado validado. Credenciais não vão para a política ou para o estado.

```powershell
npm run access:schedule:once
npm run access:schedule:watch
```

O primeiro comando faz uma consulta e termina; o segundo acompanha continuamente até `Ctrl+C`. Caminhos podem ser definidos em `PORTO_ACCESS_SCHEDULE_CONFIG`, `PORTO_ACCESS_SCHEDULE_STATUS` e `PORTO_IDSECURE_CONFIG`. Cada ciclo recarrega a política. `access-schedule-status.json` contém `desired`, `status`, `checkedAt`, `applied:false` e `hardwareWrites:0`. `awaiting_write_adapter` significa fonte conferida e envio pendente; `source_unavailable_or_changed` não reaproveita uma confirmação anterior. O sentido físico da leitora permanece pendente de teste, mesmo quando identidade e dispositivo conferem.

O worker usa arquivo `.lock` exclusivo para impedir duas instâncias no mesmo caminho de estado. Em encerramento normal, remove o bloqueio. Depois de término forçado, confira o PID/processo e remova apenas o bloqueio residual desse worker antes de reiniciar. Não há tomada automática de bloqueio de processo desconhecido.

Falhas transitórias de rede usam espera progressiva com variação, limitada a cinco minutos. Credencial recusada, formato incompatível ou mudança de identidade/equipamento interrompem o acompanhamento e exigem correção; não há repetição infinita de autenticação. Erros são registrados por categorias controladas, sem resposta bruta ou segredo.

## Pendência para operação física e inicialização com Windows

A central consultada concede a saída do funcionário por duas regras compartilhadas. Não foi validada uma operação individual de recusa que prevaleça sobre essas concessões. Remover o funcionário indiscriminadamente dos departamentos, mudar regras compartilhadas ou inativar seu cadastro não são substitutos para restringir somente uma saída.

Antes de ativar escrita: validar o contrato da central, a precedência das permissões, o mapeamento físico da leitora, a restauração exata da base e o comportamento em contingência. Conservar a liberação de emergência independente e testar com operador no local. O teste deve demonstrar saída recusada, entrada e demais acessos preservados e saída restabelecida após a restauração. HTTP 200 não comprova esse resultado.

Depois dessa homologação, o worker com escrita deve ganhar outbox/auditoria durável, leitura de confirmação, retentativas com consulta antes de repetir e tarefa de boot sob conta de serviço com acesso mínimo. **Não foi instalada tarefa de inicialização nem serviço de bloqueio no servidor nesta etapa.** Um processo de prévia não equivale a uma automação física instalada.

Referências oficiais: [Regras e horários no iDSecure](https://www.controlid.com.br/docs/idsecure-pt/acesso/), [Modos de operação](https://www.controlid.com.br/docs/access-api-pt/modos-de-operacao/introducao-aos-modos-de-operacao/). Regras do terminal em modo autônomo e decisões do servidor em modo online precisam de adaptadores diferentes; não trocar o modo da instalação para contornar essa validação.
