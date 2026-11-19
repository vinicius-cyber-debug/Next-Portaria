# Gestão do Porto — cobrança por acesso e financeiro

Versão candidata `0.8.0-rc.1`, destinada à homologação da portaria e do financeiro. O módulo usa Node/PostgreSQL 17 e permanece desativado por padrão. Publicar a release não atualiza o servidor automaticamente.

## Regras confirmadas em 09/11/2026

- A tabela física fornecida cobra **por descida/acesso**, não por diária. Cada nova entrada inicia outra operação e outro valor único, mesmo no mesmo dia. A passagem da meia-noite não aumenta um acesso.
- A empresa pagadora deve estar identificada no cadastro de empresas. Pessoa física não é opção de pagador.
- Antes da saída, o financeiro recebe **adiantamentos**, inclusive parciais. A saída fica bloqueada até o saldo ser zero ou haver desconto/isenção integral autorizado.
- A portaria confere a saída. Na mesma transação, a aplicação encerra a permanência e emite uma única cobrança definitiva, vinculada aos adiantamentos e ajustes. Uma falha reverte tudo.
- Dinheiro recebido, cobrança emitida, saldo e valor bruto de acessos em andamento são indicadores distintos. A saída física não registra um novo recebimento.
- Adiantamentos e pagamentos não podem exceder o saldo. Descontos não podem exceder o saldo ainda não recebido. Para corrigir um recebimento, use estorno; para corrigir desconto, use estorno do desconto. Registros anteriores não são apagados.
- Um estorno autorizado depois da saída pode reabrir saldo de uma cobrança. A saída histórica permanece preservada. O saldo pode ser quitado em novo pagamento; vencido significa vencimento anterior à data atual de Manaus.
- Todas as datas operacionais usam o relógio do servidor. A apresentação e os períodos de relatório usam `America/Manaus`.

### Preservação do legado

A migração `005_porto_financeiro.sql` marca tabelas e permanências anteriores como `diaria`, sem recalcular ou alterar seus valores. Essas permanências mantêm a fórmula de calendário da Fase 1: diferença entre datas locais + 1, primeira diária imediata e sem proporcionalidade. A modalidade e a tarifa são copiadas na entrada e permanecem imutáveis. Novas publicações na interface são por acesso. A API também reconhece a modalidade explícita `diaria` para compatibilidade com o histórico.

Não foram reativados os módulos antigos de atracação, embarcações, `STAY_OPEN`, `CHARGE_PAYMENT` ou `MONTH_CLOSE`. O destino da descida continua um texto; o acesso de pessoas é independente.

## Tabela física para revisão e publicação

No formulário Nova tabela tarifária, **Preencher com a tabela da foto** apenas preenche um rascunho. O administrador confere valores, informa a justificativa e publica uma versão nova. A migração não insere preços, não publica automaticamente e não retroage à data escrita na foto.

| Categoria terrestre | Valor por acesso |
| --- | ---: |
| Moto | R$ 25,00 |
| Triciclo | R$ 50,00 |
| Fiorino | R$ 100,00 |
| Montana | R$ 100,00 |
| HR | R$ 150,00 |
| 3/4 — caminhão pequeno, 1.500 kg | R$ 250,00 |
| Caminhão M — até 5 toneladas | R$ 300,00 |
| Caminhão G | R$ 500,00 |
| Muck + máquina em cima | R$ 1.000,00 |
| Carreta | R$ 1.000,00 |

Lanchas e jet ski não entram no cadastro de veículos terrestres desta entrega. A finalidade e a operação desses itens precisam ser confirmadas em um módulo próprio. Cada tabela publicada contém todas as categorias aplicáveis; não há herança silenciosa de preço de uma versão anterior. A categoria da solicitação exige escolha explícita, sem assumir a primeira opção.

## Permissões aprovadas

| Operação | Portaria | Diretoria | Financeiro | Administrador |
| --- | --- | --- | --- | --- |
| Solicitar | Sim | Sim | Não | Sim |
| Aprovar/recusar | Não | Sim | Não | Sim |
| Registrar entrada e saída quitada | Sim | Sim | Não | Sim |
| Consultar valores e recibos | Não | Sim | Sim | Sim |
| Definir empresa pagadora | Não | Não | Sim | Sim |
| Registrar adiantamento/pagamento | Não | Não | Sim | Sim |
| Desconto, isenção e estornos | Não | Sim | Não | Sim |
| Conferir e fechar caixa | Não | Não | Sim | Sim |
| Publicar tarifas | Não | Não | Não | Sim |
| Indicadores e exportação financeira | Não | Sim | Sim | Sim |
| Histórico geral do Porto | Não | Sim | Não | Sim |

Operação e Consulta não acessam o módulo. Bloqueios individuais `gateOperate: false`, `exceptionApprove: false`, `dataExport: false` e `auditView: false` também são respeitados nas respectivas ações, exceto para administrador. Para diretoria, entrada/saída seguem a matriz do Porto, sem liberar os comandos aposentados. Financeiro consulta seu histórico de movimentos/recibos, sem acesso à auditoria geral.

As permissões são verificadas novamente dentro da transação. Valores são retirados da resposta da portaria; ela recebe apenas a indicação de liberação da saída. O administrador pode cadastrar o perfil Financeiro do Porto quando o módulo está habilitado.

## Banco e integridade

`004_porto.sql` criou tarifas versionadas, solicitações, permanências, eventos e idempotência. `005_porto_financeiro.sql` acrescenta modalidade e as tabelas:

| Tabela | Responsabilidade |
| --- | --- |
| `porto_pagadores` | Versões da identificação da empresa, com nome preservado |
| `porto_cobrancas` | Cobrança definitiva única por permanência, emitida na saída |
| `porto_pagamentos` | Adiantamentos, pagamentos e estornos, com números de recibo |
| `porto_ajustes` | Descontos/isenções e seus estornos autorizados |
| `porto_caixa_fechamentos` | Conferência imutável de cada lote |
| `porto_caixa_itens` | Movimentos pertencentes a cada fechamento, sem repetição |

A função SQL `porto_saldo` calcula valores em centavos inteiros. Gatilhos e privilégios protegem os registros; a aplicação só tem atualização nas três colunas necessárias à saída. Uma restrição diferida exige cobrança consistente e saldo zero ao concluir a saída. Descontos, pagamentos e estornos têm verificações de saldo e origem também no banco. A unidade é `operational_settings.id = settings`; não há gestão de múltiplas unidades nesta versão.

As escritas usam a mesma conexão e transação da auditoria e idempotência, serializadas com a autorização e as demais operações da base. A mesma chave e conteúdo reproduzem o resultado; conteúdo ou ator diferentes causam conflito. A saída duplicada não emite outra cobrança. Preços e modalidade não mudam após a entrada.

A empresa pode ser corrigida por novo registro antes de haver recebimento líquido e antes da saída. Recibos anteriores conservam a identificação que tinham no recebimento. Tarifas, cobranças, recebimentos, ajustes, eventos e fechamentos são imutáveis. Cadastros reutilizados mantêm suas chaves estrangeiras; excluir um cadastro referenciado não remove o histórico.

## Telas e API

As abas operacionais reúnem solicitações e veículos presentes. Financeiro permite abrir conta, identificar empresa, receber, consultar recibos e autorizar ajustes conforme o perfil. O recibo e a cobrança possuem impressão de controle interno, **não fiscal**. Registrar Pix, cartão ou transferência é uma conferência manual do operador, não uma integração com banco/adquirente. Não informe dados de cartão no campo de referência.

Indicadores do Porto aceita período de até 366 dias, categoria e empresa. Exibe entradas, saídas, permanência média, cobrado bruto, recebido bruto, estornado, recebido líquido e saldos atuais, com tabelas por dia e categoria e exportação CSV protegida contra fórmulas. Recebidos incluem adiantamentos. Os saldos representam a posição atual, independentemente do período de movimentos consultado. A consulta detalhada exibe até 200 movimentos e 200 ajustes recentes; o banco mantém todo o histórico.

O caixa trabalha com **lotes de movimentos ainda não fechados**, abrangendo todos os operadores da unidade. Informa saldo inicial e dinheiro conferido; esperado = saldo inicial + entradas em dinheiro − devoluções em dinheiro. A diferença e a justificativa ficam preservadas. Movimentos posteriores entram no próximo lote, inclusive no mesmo dia. O caixa não altera recibos nem comprova conciliação bancária.

As rotas `/api/porto` usam sessão, proteção de origem, senha obrigatoriamente trocada e HTTPS da aplicação. Além das rotas operacionais, há `GET contas`, `contas/:id`, `recibos/:id`, `cobrancas/:id`, `caixa`, `caixa/:id`, `relatorios` e `relatorios/exportar`. Listas são paginadas, com no máximo 50 registros por página.

`POST comandos` recebe `{tipo, payload, idempotencyKey}`. Novos tipos: `DEFINIR_PAGADOR`, `REGISTRAR_PAGAMENTO`, `ESTORNAR_PAGAMENTO`, `CONCEDER_DESCONTO`, `ESTORNAR_DESCONTO`, `REGISTRAR_SAIDA`, `FECHAR_CAIXA`. Ajustes e operações financeiras exigem justificativa. A saída exige conferência do veículo e quitação, sem liberação por exceção de dívida.

## Homologação, atualização e backup

1. Leia [o roteiro de homologação](HOMOLOGACAO-PORTO.md) e valide o ciclo com um responsável da portaria, um do financeiro e a diretoria. Testes automatizados não substituem esse aceite empresarial.
2. Use uma instalação de homologação com dados próprios. Preserve a instalação ativa e produza um backup completo verificado antes de migrar qualquer base anterior. Não execute testes contra o servidor operacional.
3. Execute dependências do lockfile, tipos, testes e compilação. Aplique `npm run postgres:migrate` na instalação selecionada. Os arquivos anteriores não são editados; checksums divergentes interrompem a migração. A aplicação não migra automaticamente ao iniciar.
4. Para homologação local: defina `$env:PORTO_PORTO_ENABLED = 'true'` no processo servidor e inicie a aplicação compilada. É necessário reiniciar para alterar a habilitação. D1/SQLite e a demonstração em memória não implementam o módulo.
5. Para Windows Server, use o pacote identificado e o [procedimento de implantação](IMPLANTACAO-SERVIDOR.md). O instalador aceita `-EnablePorto`; a tarefa sem login lê `portoEnabled` de `current.json`. Release candidata exige `-Homologacao`. Os nomes reservados NextPortaria-* não permitem uma segunda instalação paralela sem planejamento de infraestrutura. Não aponte um ensaio para os dados ativos.
6. Confirme HTTPS confiável, funcionamento após reiniciar sem login e restauração do backup externo. O destino externo e a pasta restrita da chave precisam existir; os exemplos da documentação não são destinos configurados.

O backup completo usa `pg_dump` do esquema público e arquivos privados, criptografa, recupera em destino novo e compara os dados. Inclui todas as novas tabelas e gatilhos, e reaplica os privilégios. O JSON da tela Continuidade é parcial e não contém o Porto; sua restauração é bloqueada quando existem tarifas ou solicitações do módulo, inclusive se estiver desativado. Não contorne essa proteção para recuperar somente parte do financeiro.

Na preparação desta release, os dados fictícios e migrações são exercitados em bases descartáveis de QA. A instalação operacional não é alterada remotamente. O destino externo de backup da empresa ainda precisa ser informado e validado no servidor.

## Verificações

`npm run check`, `npm run lint:porto`, `npm run test:porto`, `npm run build` e `npm run test:porto:browser`. A suíte cobre valor por acesso, calendário legado, permissões, adiantamentos parciais, concorrência, saída atômica, ajustes, estornos, recibos, relatórios, caixa e recuperação completa. O navegador usa HTTPS, banco e usuários temporários, acessibilidade e larguras desktop/tablet/celular.
