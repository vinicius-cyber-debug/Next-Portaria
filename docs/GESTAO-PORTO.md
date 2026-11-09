# Gestão do Porto — Fase 1

Estado em 09/11/2026: fundação em desenvolvimento na branch `feat/porto-foundation`. O módulo é exclusivo do runtime Node/PostgreSQL e fica desativado por padrão. Esta fase serve para homologação: não possui saída, faturamento, recebimento ou fechamento de caixa. Não deve ser usada como operação definitiva.

## Escopo e regras

O módulo registra solicitação de descida, aprovação ou recusa justificada, conferência do veículo, entrada e permanência ativa. Reutiliza os cadastros `fleet`, `people` e os usuários existentes. Não altera automaticamente a presença física da portaria. A embarcação de destino é um texto obrigatório; não reativa os antigos cadastros de embarcações, atracações ou financeiro.

As tarifas oficiais e categorias começam vazias, conforme decisão da empresa. Nenhum dado fictício é inserido por migração. Sem tarifa vigente da categoria, solicitação e entrada são recusadas. Somente o administrador publica uma nova tabela, com justificativa e vigência atual ou futura. Cada tabela contém o conjunto completo das categorias aplicáveis; a categoria não herda preço de uma versão anterior.

O preço aplicável é fixado na **entrada**, junto com a versão da tabela e a categoria. Alterações futuras não mudam esse registro. A aplicação utiliza centavos inteiros, sem cálculo monetário em ponto flutuante. O limite técnico por diária é 1.000.000.000 de centavos; valores zero, descontos e isenções aguardam definição de regras.

A diária segue datas de calendário em `America/Manaus`, independentemente do fuso do computador, navegador ou da portaria geral:

`diárias = data local da referência − data local da entrada + 1`

| Entrada → referência | Diárias |
| --- | ---: |
| Mesmo dia, ainda que poucos minutos | 1 |
| 23:59 → 00:01 do dia seguinte | 2 |
| Dia 10 → dia 14 | 5 |

Não há tolerância nem proporcionalidade. A primeira diária começa imediatamente na entrada e a próxima à meia-noite local. Na permanência aberta, a referência é o relógio do servidor, obtido depois do bloqueio da transação. A estimativa não gera cobranças à meia-noite e não representa receita recebida. Datas de entrada enviadas pelo cliente são ignoradas.

## Matriz aprovada para a Fase 1

| Perfil existente | Consulta operacional | Solicitar | Aprovar / recusar | Registrar entrada | Valores | Publicar tarifas | Histórico do Porto |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Administrador (`admin`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Diretoria / gestor (`director`) | Sim | Sim | Sim | Sim | Sim | Não | Sim |
| Portaria (`gate`) | Sim | Sim | Não | Sim | Não | Não | Não |
| Financeiro (`finance`) | Sim | Não | Não | Não | Sim | Não | Não |
| Operação / consulta (`operations`, `reader`) | Não | Não | Não | Não | Não | Não | Não |

O bloqueio individual `gateOperate: false` também impede entrada no Porto, exceto para administrador. A retirada de `auditView` da diretoria impede o histórico. Essas regras são conferidas no servidor, inclusive em operações repetidas; ocultar botões não é a proteção de acesso. A API remove os campos monetários da resposta à portaria.

Com o módulo habilitado, o administrador pode criar ou atribuir o perfil **Financeiro do Porto (consulta)** em Usuários e permissões. Sem a habilitação, a criação desse perfil continua bloqueada e contas financeiras históricas mantêm a compatibilidade anterior. Nenhum comando financeiro aposentado é liberado por esse perfil.

## Estrutura e integridade

O cálculo puro e as validações ficam em `lib/porto/domain.mjs`; as transações, consultas paginadas e autorização ficam em `lib/porto/service.ts`; a interface está em `app/porto-panel.tsx`.

A migração aditiva `database/postgres/004_porto.sql` cria:

| Tabela | Finalidade |
| --- | --- |
| `porto_tabelas_tarifarias` | Versões e vigências imutáveis por unidade |
| `porto_tarifas` | Categorias e centavos de cada versão |
| `porto_solicitacoes` | Pedido e decisão única, com dados originais preservados |
| `porto_permanencias` | Entrada e cópia imutável do preço contratado |
| `porto_eventos` | Eventos ordenados e imutáveis, com ator e horário |
| `porto_comandos` | Idempotência por chave, ator e conteúdo |

As migrações anteriores não são alteradas. A unidade desta instalação corresponde a `operational_settings.id = 'settings'`; esta fase não implementa administração de múltiplas unidades. As chaves estrangeiras ligam veículo, motorista opcional, solicitação e tarifa, incluindo o valor exato. Um índice parcial impede duas permanências abertas para o mesmo veículo/unidade.

As escritas são transacionais: alteração, evento e registro idempotente confirmam juntos. A falha de auditoria reverte a entrada. Um bloqueio compartilhado com a operação principal serializa alterações de sessão/permissões e restauração; a sessão é revalidada dentro da transação. Repetir a mesma chave e conteúdo retorna o resultado anterior, filtrado pelas permissões atuais; reutilizar a chave com outro conteúdo ou ator retorna conflito.

Privilégios da aplicação e gatilhos impedem alteração/exclusão de tarifas, permanências, eventos e comandos. Solicitação só transita de pendente para aprovada ou recusada. A Fase 1 bloqueia o encerramento da permanência no banco: a Fase 2 deverá substituir essa proteção junto com a criação atômica da cobrança, em nova migração.

## API autenticada

As rotas usam sessão, troca obrigatória de senha, proteção de origem e transporte seguro já existentes. Paginação aceita até 50 registros por página.

| Método / rota `/api/porto/…` | Uso |
| --- | --- |
| `GET status` | Habilitação, fase, fuso e permissões |
| `GET resumo` | Pendências, aprovadas sem entrada, presentes e estimativa permitida |
| `GET tarifas` | Tabela vigente e categorias |
| `GET tabelas` | Histórico paginado das versões, somente administrador |
| `GET cadastros?collection=fleet\|people&q=…` | Busca de cadastros ativos, sem documentos ou e-mails |
| `GET solicitacoes` | Consulta paginada por placa/motorista e situação |
| `GET permanencias` | Permanências e prévia atualizada pelo servidor |
| `GET eventos` | Histórico paginado, conforme matriz |
| `POST comandos` | `{tipo, payload, idempotencyKey}` |

Comandos disponíveis: `TARIFAS_PUBLICAR`, `SOLICITAR_DESCIDA`, `APROVAR_DESCIDA`, `RECUSAR_DESCIDA`, `REGISTRAR_ENTRADA`. Entrada exige solicitação aprovada, cadastros ainda ativos, placa preservada e `veiculoConferido: true`. O servidor rejeita demais comandos, incluindo saída, cobrança e pagamento.

## Homologação e recuperação

Use uma instalação de homologação separada, com banco e armazenamento próprios. Não aponte testes de navegador para o servidor operacional. Não compartilhe credenciais no chat ou no Git. O ambiente D1/SQLite e a demonstração em memória não implementam este módulo.

1. Preserve a versão em uso e pare os processos dessa instalação antes de uma atualização de esquema. Produza e confira um backup completo com `npm run backup:full`, conforme [PostgreSQL e recuperação](POSTGRESQL.md). Em uma instalação gerenciada como serviço, pare também seu supervisor pelo procedimento documentado dessa instalação.
2. Instale as dependências do lockfile com `npm ci`; execute `npm run check`, `npm run lint:porto` e `npm run build`. Para os testes com PostgreSQL, disponibilize uma conta de QA capaz de criar bancos/roles descartáveis, pelo mecanismo `PORTO_TEST_POSTGRES_CONFIG` já usado pela suíte. A senha pertence à configuração privada, não ao código.
3. Na cópia de homologação, aplique `npm run postgres:migrate`. O migrador valida os checksums anteriores, aplica `004_porto.sql` e ajusta privilégios; a aplicação não migra automaticamente ao iniciar.
4. Defina a variável no processo **servidor** e reinicie essa cópia, pois os recursos são criados e armazenados em cache no início:

   ```powershell
   $env:PORTO_PORTO_ENABLED = 'true'
   npm start
   ```

   Para serviço Windows, a variável precisa constar no ambiente do serviço, não apenas em um PowerShell interativo. O comando acima é para homologação local; não instala serviço nem configura HTTPS. A [implantação Windows](IMPLANTACAO-SERVIDOR.md) permanece o procedimento de infraestrutura.
5. Confira acesso por perfil e ausência inicial de tarifas. Cadastre categorias e valores **aprovados** apenas quando fornecidos. Exercite publicação, solicitação, recusa/aprovação, conferência/entrada, tentativa duplicada e atualização de tarifa. Confira que uma permanência mantém a tarifa original e que a portaria não recebe valores pela API.
6. Faça um backup completo após o ensaio e teste a recuperação em destino novo. Desabilitar o módulo exige remover a variável ou usar `false` e reiniciar; isso não apaga registros nem desfaz migrações.

O backup completo PostgreSQL usa `pg_dump` de todo o esquema público, inclui as novas tabelas/gatilhos e os arquivos privados, e faz recuperação de verificação. A restauração reaplica os privilégios restritos. O JSON da tela de continuidade permanece parcial e **não contém Gestão do Porto**. Quando já há tabela tarifária ou solicitação do Porto, o servidor bloqueia a restauração desse JSON com `PORTO_FULL_RESTORE_REQUIRED`, inclusive com o módulo desativado. Use recuperação PostgreSQL completa em banco e pasta novos. Não remova essa proteção para recuperar somente parte dos dados.

Nesta entrega a migração e os dados fictícios foram usados somente em bases descartáveis de QA. A base de desenvolvimento existente e o servidor operacional não foram migrados para o novo módulo. O destino de backup externo da empresa ainda precisa ser definido; a funcionalidade local não resolve essa pendência de infraestrutura.

## Verificações e próximas fases

```powershell
npm run check
npm run lint:porto
npm run test:porto
npm run build
npm run test:porto:browser
```

A suíte cobre datas, virada do mês/ano, ano bissexto, fuso, centavos, matriz de permissões, idempotência, concorrência, imutabilidade, falha de auditoria, restauração parcial e fluxo real em HTTPS. O teste de navegador cria sua própria base, usuários, tarifas fictícias e certificado temporário; valida seis larguras, consulta financeira e ausência de valores para portaria. As capturas ficam em `.porto-tooling/porto-review` ou no destino indicado por `PORTO_PORTO_TEST_OUTPUT`. O CI executa essas verificações em PostgreSQL 17 e preserva as capturas como artefato.

Validação local de 09/11/2026: 25 testes do Porto aprovados, incluindo recuperação completa de tarifas e permanências; suíte geral com 219 aprovados e dois testes reservados para navegador; execução separada PostgreSQL/vídeo/HTTPS com 18 aprovados. O fluxo do Porto gerou 15 capturas sem erros ou violações automáticas WCAG e confirmou o descarte de resposta atrasada após trocar de aba. A regressão da interface existente passou nas 139 verificações visuais, sem overflow ou violações automáticas WCAG. As compilações nativa e Cloudflare passaram. A conferência por hashes da base de desenvolvimento preservou 19 tabelas, 38 linhas, 13 registros operacionais e um usuário. Esses resultados locais não significam que houve publicação, execução do CI remoto ou implantação no servidor.

Continuam pendentes:

- Fase 2: encerramento + cobrança na mesma transação, pagamentos, saldo, recibos e ajustes compensatórios.
- Fase 3: indicadores financeiros, relatórios e fechamento de caixa.
- Fase 4: homologação empresarial, versão publicada e implantação no servidor, HTTPS confiável, supervisão sem login e destino externo de backup validado.
- Definições da empresa: categorias e tarifas oficiais, reentrada no mesmo dia, saída com saldo, pagador, descontos/isenções e cobrança de embarcações.

Não há cobrança ou recebimento fictício apresentado como resultado da operação, nem integração de escrita com equipamentos Control iD nesta fase.
