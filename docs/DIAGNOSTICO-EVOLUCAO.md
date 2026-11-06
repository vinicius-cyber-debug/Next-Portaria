# Diagnóstico da evolução — fase 1

Inspeção de 6/11/2026, partindo de `main` em `bdfe2fd` (v0.7.0). Esta entrega segue a orientação de manter Control iD encaminhado enquanto o responsável verifica os equipamentos. Não houve conexão com hardware nem alteração do servidor em operação.

## Estado anterior verificado

- `origin/main` foi consultada com `git fetch`. As branches `feature/postgres-native` e `feature/server-media` não têm commits exclusivos além da main. A branch histórica de estudo de caso tem um commit divergente de documentação/README/vídeo, sem alteração de runtime.
- A consulta de PRs abertas não retornou resultados. A [PR #4](https://github.com/vinicius-cyber-debug/Next-Portaria/pull/4) foi integrada; o [workflow final](https://github.com/vinicius-cyber-debug/Next-Portaria/actions/runs/42276568868) passou. O caso 200/500 de uma tentativa anterior já havia sido corrigido na v0.7.0 para retornar 409 também antes do commit do comando.
- Baseline local executada: 172 testes, 170 aprovados e dois ensaios de navegador/HTTPS reservados a execução específica; nenhum teste falhou. TypeScript passou. O lint global apresentou **64 erros e 13 avisos**, portanto não está limpo; o workflow anterior não o exigia.

## Arquitetura e capacidades verificadas

| Área | Evidência no código/testes | Situação |
| --- | --- | --- |
| Interface | `port-app.tsx`, painéis de acesso, requisitos, ocorrências e administração | Aplicação React/Vinext existente, preservada. |
| API e regras | `server.ts`, `domain.mjs`, `physical-access.mjs`, testes de API/domínio | Autorização, validade, responsável/substituto, requisitos, presença e revogação implementados. |
| Identidade | `local-auth.ts`, sessões PostgreSQL, troca de senha e testes de concorrência | PBKDF2, tokens opacos, cookies e CSRF no servidor; capacidades não substituem o perfil base. |
| Auditoria | Gravação junto do comando, trigger imutável e privilégio de aplicação restrito | Implementada; preservar atomicidade e versão ao integrar hardware. |
| PostgreSQL | Adaptador parametrizado, transações em uma conexão, migrações `001`–`003` | Implementado. Registros operacionais seguem JSON com colunas/índices derivados; não há tabela de pessoa paralela a criar por conveniência. |
| Mídias | `media.ts`, armazenamento privado e backup conjunto | Implementadas na v0.7; revalidar após alterar infraestrutura transacional. |
| Pré-cadastro | `VISITOR_REQUEST`, datas, atribuição, aprovação e cancelamento | Existe como fluxo autenticado. Não existe portal público de convites. |
| Notificações | `continuity.ts`, avisos internos e leitura por destinatário | Implementadas para tipos existentes; e-mail/WhatsApp não configurados. |
| Equipamentos | Busca transversal por integrações, filas, dispositivos e webhooks | Não havia driver, cadastro de dispositivos, eventos físicos, fila durável nem reconciliação com catracas. |
| Operação | Scripts de HTTPS, serviço PostgreSQL e tarefas Windows; recuperação criptografada | Existem no pacote. A imagem enviada comprova acesso à tela; não comprova backend, versão, boot sem login, backup externo ou comunicação com hardware no servidor. |

O monólito compartilha regras entre PostgreSQL nativo e D1/SQLite legado. Recursos Node são selecionados por runtime no build; alterações do integrador devem preservar essa fronteira e recusar recursos indisponíveis no provedor legado.

## Concentração e duplicação

Medição da baseline: `port-app.tsx` tem cerca de 91 kB, `domain.mjs` 70 kB, `server.ts` 60 kB, `v3-panels.tsx` 42 kB e `access-panels.tsx` 39 kB. O número reduzido de linhas esconde funções grandes: `handleApi` concentra aproximadamente 31 kB, e o formulário operacional e a composição principal da interface têm cerca de 27 kB cada.

Os testes SQLite repetem adaptadores/fixtures em vários arquivos. Nesta entrega foi criado um fixture PostgreSQL comum aos novos testes; não foi feita uma reescrita ampla dos testes antigos. API e mídia duplicavam o ciclo transacional e agora compartilham o mesmo executor. Ferramentas administrativas de migração/backup ainda possuem transações próprias e devem ser extraídas em incremento específico, preservando a compatibilidade dos iniciadores Node.

O lint anterior concentra erros de `any`, refs/pureza/estado em effects e aliases de `this`. Uma reformatação geral ou desativação dessas regras não é parte da correção de concorrência. A dívida permanece documentada; os módulos novos e os componentes transacionais alterados ganham lint obrigatório próprio no CI.

## Problemas tratados nesta fase

1. **Erro perde classificação entre camadas:** o erro normalizado voltava a passar pelo normalizador do lote, perdendo metadados como `DUPLICATE`. `PostgresError` conserva SQLSTATE interno e códigos públicos estáveis; detalhes do driver/credenciais não são devolvidos ao cliente.
2. **Rollback oculta a falha original:** a exceção do rollback substituía serialização, deadlock ou erro de autorização. O executor preserva a falha inicial e descarta a conexão se não conseguir desfazer a transação.
3. **Uso tardio da conexão:** um statement delimitado à transação podia sobreviver à devolução do cliente ao pool. O escopo agora é invalidado ao encerrar o callback; uso após commit/rollback falha antes de executar SQL.
4. **Erros na transação de mídia:** usavam um ciclo separado e podiam virar 500 genérico. Usam agora o mesmo executor e encaminham conflitos à classificação existente da API.
5. **Cobertura insuficiente dos códigos reais:** os testes agora produzem `40001` e `40P01` com bloqueios reais, verificam rollback da auditoria e registros intermediários, repetição idempotente e liberação de pools.

Não foi adicionada retentativa automática de escrita. Após conflito, é necessário reavaliar o estado/revisão; após resultado de commit incerto, a repetição deve usar a mesma chave idempotente. Repetir somente o último SQL ou alterar a revisão automaticamente seria inseguro. A documentação PostgreSQL recomenda refazer a transação e sua lógica de decisão, não apenas um comando isolado. [Tratamento oficial](https://www.postgresql.org/docs/17/mvcc-serialization-failure-handling.html), [transações node-postgres](https://node-postgres.com/features/transactions).

## Arquivos e impactos

| Alteração | Arquivos | Impacto |
| --- | --- | --- |
| Classificação e executor transacional | `lib/persistence/postgres-errors.ts`, `transaction.ts`, `postgres.ts`, `lib/media.ts` | Infraestrutura PostgreSQL/mídia; contratos públicos D1 preservados. |
| Regressões e fixtures | `tests/postgres-transactions.test.mjs`, `postgres-stability.test.mjs`, `support/postgres-fixture.mjs` | Bancos/papéis de QA exclusivos, desmontados após fechar conexões. |
| Preparação desacoplada | `lib/integrations/*`, `scripts/simulate-access-devices.mjs`, `tests/integration-preparation.test.mjs` | Contrato e simulação; sem registro no runtime de produção ou conexão real. |
| Verificações | `package.json`, `.github/workflows/quality.yml` | Novos testes PostgreSQL e lint específico obrigatório; nenhuma dependência npm adicional. |
| Arquitetura | `INTEGRACAO-CONTROLID.md` | Modelo, migrações futuras, eventos, segurança e critérios de bancada propostos. |

**Migrações desta entrega: nenhuma.** Não se alterou SQL aplicado, banco operacional ou cadastro existente. Os novos testes criam seus próprios bancos e papéis aleatórios; a limpeza é restrita aos recursos que acabaram de criar. Não executar o SQL de fixtures numa base operacional.

## Resultados locais desta entrega

- Suíte geral final: **195 testes, 193 aprovados e dois reservados de navegador/HTTPS ignorados nessa execução; zero falhas**.
- Execução específica com navegador e gateway habilitados: **18 testes aprovados, zero ignorados**, incluindo os dois ensaios reservados, retomada na interface e recuperação de backup.
- Novos ensaios reais de estabilidade: oito casos aprovados, com vinte pares concorrentes, serialização, deadlock coordenado por bloqueios, unicidade, mídia, uso tardio de conexão e replay após encerrar/reabrir conexões.
- TypeScript, lint específico e build nativo PostgreSQL aprovados. O simulador executou sem conexão de hardware e sem mudança de banco.
- A conferência somente leitura da base local conservou as 19 tabelas operacionais e suas 38 linhas, incluindo 13 registros e um usuário; papel de aplicação sem superusuário e sem UPDATE de auditoria. Nenhuma migração foi aplicada nesta entrega.
- O lint global permanece com as 64 pendências verificadas na baseline; não foi declarado aprovado. A validação remota do incremento é registrada na PR, sem merge ou deploy automático.

## Executar e validar

```powershell
npm run check
npm run lint:stability
npm test
node --experimental-strip-types --test tests/postgres-stability.test.mjs
npm run integration:simulate
npm run build
```

Os testes PostgreSQL exigem a configuração privada de desenvolvimento ou `PORTO_TEST_POSTGRES_CONFIG`. Sem configuração, o caso de integração fica ignorado; o job PostgreSQL do CI fornece uma instância separada. Não usar credenciais/endereço da produção para executar os testes. O fixture exige criação de banco/papel somente na instância de testes e verifica que as conexões foram encerradas antes de remover o banco criado.

O relatório final desta fase deve distinguir testes executados, ignorados e limitações, incluindo o lint global que permanece pendente. Testes de simulação não atestam nenhum firmware. O próximo incremento recomendado é o esquema do integrador e a leitura em bancada, após obter as informações dos equipamentos. Operações de escrita e deploy permanecem fora desta entrega.
