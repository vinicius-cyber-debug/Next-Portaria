# Homologação empresarial — Gestão do Porto

Release candidata: `0.8.0-rc.1`. Responsáveis e aceite devem ser preenchidos pela empresa após executar o roteiro. Este arquivo não representa aprovação já obtida.

| Responsabilidade | Nome | Data | Resultado / ressalvas |
| --- | --- | --- | --- |
| Portaria | A preencher | A preencher | Pendente |
| Financeiro | A preencher | A preencher | Pendente |
| Diretoria / ajustes | A preencher | A preencher | Pendente |
| TI / recuperação e servidor | A preencher | A preencher | Pendente |

Use homologação isolada, com empresa e veículos identificados como teste. Não use documentos pessoais reais para esse ensaio. A publicação de tarifas deve ocorrer somente após conferir os dez valores terrestres transcritos da foto em [Gestão do Porto](GESTAO-PORTO.md). Lanchas e jet ski permanecem separados.

## Roteiro de negócio

1. Administrador habilita o módulo na instalação de homologação, cria usuários próprios por perfil e publica a tabela por acesso, com justificativa. Confirme que não existiam preços publicados automaticamente.
2. Portaria solicita descida, escolhe veículo e categoria explicitamente e informa motorista, destino e finalidade. Ela não pode aprovar a própria operação por usar o perfil Portaria.
3. Diretoria aprova ou recusa com justificativa. Confira que pedido recusado não permite entrada.
4. Portaria registra entrada aprovada, conferindo o veículo. Tente registrar a mesma entrada em duas sessões: somente uma permanência deve existir.
5. Financeiro abre a conta e identifica uma empresa cadastrada. Confirme que não há cobrança definitiva antes da saída e que a portaria não vê valores.
6. Tente sair sem pagar: deve ser bloqueado. Registre adiantamento parcial, confira recibo, referência e saldo. A saída deve continuar bloqueada.
7. Receba o restante ou peça desconto autorizado à diretoria. Tente receber acima do saldo, repetir uma operação e efetuar pagamento com o perfil Portaria. Não pode haver recebimento excedente ou duplicado.
8. Portaria confere e registra saída. Deve haver uma cobrança definitiva e uma saída. Adiantamentos devem quitar a cobrança sem criar outro recebimento. Tente repetir a saída.
9. Confira que nova entrada do mesmo veículo cria outro acesso. Uma operação por acesso não aumenta à meia-noite. Operações antigas por diária conservam o calendário e a tarifa original.
10. Publique outra tarifa e confira que o acesso já iniciado preserva seu valor. Não é permitido editar a versão anterior.
11. Diretoria concede um desconto, estorna esse desconto e estorna parcialmente um recebimento, com justificativa. Confira os originais preservados, os novos eventos e o saldo. Financeiro não pode executar essas autorizações. Estorno após saída pode reabrir dívida, sem apagar a saída.
12. Imprima recibo e cobrança, confira identificação da empresa, placa, número, horário de Manaus, método, referência e valores. São documentos internos não fiscais.
13. Nos indicadores, confira período, filtros de categoria/empresa, valores recebidos, adiantamentos, estornos e cobranças emitidas. Confira CSV e saldos atuais. Cobrado não deve ser interpretado como recebido.
14. Financeiro confere um lote de caixa, informa saldo inicial e dinheiro contado e justifica a conferência. Confira métodos separados, diferença e imutabilidade. Repita o fechamento sem novos movimentos: deve ser recusado. Recebimentos posteriores devem entrar em outro lote.
15. Repita solicitação, adiantamento e saída em celular real, incluindo leitura dos dados e confirmação sem corte de botões. Registre modelo do aparelho, navegador e eventuais dificuldades no aceite.

## Infraestrutura e recuperação

- Registrar tag, commit, hash do pacote, pasta instalada, IP, porta e certificado efetivamente usados.
- Confirmar backup completo anterior à migração e recuperação em banco/pasta novos. Conferir contas, permissões, recibos, saldos, fechamentos e arquivos privados.
- Informar destino UNC externo e pasta restrita da chave, com acesso da identidade real da tarefa de backup. Executar a tarefa e conferir a recuperação da cópia externa.
- Validar TLS sem alerta nos computadores e celulares autorizados. O endereço de referência do servidor é `https://192.168.0.2:8443`; ainda precisa ser confirmado no ambiente atualizado.
- Reiniciar Windows em janela combinada; confirmar PostgreSQL e aplicação sem login e sem PowerShell aberto. Conferir logs e estado das tarefas.
- Conferir firewall restrito à sub-rede autorizada, PostgreSQL apenas em loopback e ausência de interferência em serviços de terceiros.
- Guardar versão anterior e plano de recuperação. Não restaurar automaticamente um backup antigo depois de receber novas movimentações.

Somente após o aceite empresarial e de infraestrutura deve ser publicada/ativada uma versão estável definitiva. O pacote candidato não configura sozinho um destino externo inexistente nem comprova homologação na máquina da empresa.
