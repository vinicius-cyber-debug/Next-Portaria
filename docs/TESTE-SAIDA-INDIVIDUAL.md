# Teste de saída individual da portaria

Data: 14/11/2026. Horários de Manaus. Ensaio manual autorizado, com o funcionário junto à catraca e operador disponível com liberação manual funcionando.

## Escopo

O teste é individual e usa o vínculo estável do funcionário na central. Somente a saída da catraca da portaria recebe a exceção. Entrada, outros funcionários e regras preexistentes não são alterados. O teste não abre a catraca para passagem sem identificação e não utiliza inativação global da pessoa.

O destino conferido foi a catraca da portaria, iDBlock Next, firmware 6.26.0. A conexão foi testada pela função de conexão do próprio iDSecure, além da leitura do sincronismo. A indicação histórica `isCurrentlyOnline` da lista não correspondeu ao indicador atual de sincronismo; essa distinção foi corrigida no leitor e coberta por regressões.

## Etapas observadas

| Etapa | Resultado |
| --- | --- |
| Somente a saída restrita, antes da janela | O funcionário confirmou entrada liberada e saída bloqueada |
| Exceção individual de 08h47 a 09h02 | O funcionário confirmou saída liberada e entrada normal |
| Vencimento às 09h02 | Regra removida automaticamente às 09h02; o funcionário confirmou saída bloqueada e entrada liberada |
| Restauração do cadastro e remoção dos recursos criados | Departamento original restaurado, regras e horário temporários removidos; sincronismo confirmado às 09h05 |
| Identificação após a restauração | O funcionário confirmou entrada e saída normais |

Resultado do ensaio: aprovado manualmente nas quatro etapas. As cópias privadas e as confirmações recebidas foram preservadas para conferência, sem publicar dados pessoais ou fotos no repositório.

As confirmações do funcionário são evidência manual. Os eventos lidos da central são registrados separadamente e não são apresentados como confirmação automática de giro. O horário de recebimento de uma resposta no chat não é tratado como horário exato da passagem.

## Preservação e expiração

Antes das alterações foram guardadas cópias privadas do cadastro, associações, regras e equipamento fora do Git. Foram conferidos nome, identificador estável, flags, credenciais existentes e demais campos do cadastro. A central alterou o identificador mutável do registro e recodificou o JPEG ao salvar; a foto permaneceu disponível e o reconhecimento foi confirmado no teste.

A permissão usou uma regra exclusiva de saída e uma faixa de 900 segundos. Um processo de acompanhamento verificou o vencimento e removeu a regra temporária às 09h02min00s. Ele tinha prazo de contingência para restaurar o departamento original enquanto permanecesse em execução. Os horários cadastrados na central são semanais: não devem ser utilizados como autorização permanente de uso único sem remoção e reconciliação. Ao encerrar, foram removidas as duas regras e a faixa criadas nesta sessão, preservando todos os recursos anteriores. O grupo temporário ficou sem membros e o processo de acompanhamento encerrou.

Este ensaio não implementa o botão de autorização pelo líder no Next Portaria. A integração operacional exige autorização por setor no servidor, justificativa, auditoria, persistência da validade e acompanhamento da aplicação/revogação no equipamento. A prévia de horários existente continua sem adaptador de escrita e sem conceder permissões reais.

## Verificação automática desta alteração

285 testes aprovados com PostgreSQL, HTTPS e os casos opcionais de navegador habilitados. Lint completo, tipagem, formatação e compilação aprovados. A correção de status tem testes para campo histórico divergente, sincronismo em andamento, falha, status ausente/duplicado e manutenção da proibição de escrita no leitor de diretório.
