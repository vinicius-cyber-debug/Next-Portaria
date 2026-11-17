# Qualidade e regressões de segurança

Atualização de desenvolvimento: 11/11/2026. Esta alteração não implica publicação ou atualização do servidor.

## Autorização e auditoria

`lib/access-policy.mjs` concentra a matriz base de comandos e a política de manutenção dos cadastros. `lib/access.mjs` aplica as capacidades individuais e a visibilidade dos dados. A interface consulta essas funções; a API e o domínio continuam validando as operações no servidor.

A portaria não pode converter um funcionário em visitante, motorista, fornecedor ou prestador para contornar a autorização. Um override de capacidade não amplia a autoridade do perfil base. Um responsável com `accessManage` revogado também não pode fazer a reclassificação. A portaria pode continuar corrigindo o nome e marcar um visitante como prestador pendente de revisão; não pode reverter essa pendência para recuperar privilégios de visitante.

Eventos de documentos e mídias exigem `documentView`, além de `auditView`. A mesma política de visibilidade é aplicada ao estado inicial, à consulta paginada da auditoria e às atualizações incrementais. Revogar `auditView` retira a coleção da sincronização e impede a consulta ao histórico.

`tests/security-regressions.test.mjs` executa esses cenários pela API em duas fixtures independentes: SQLite/D1 e PostgreSQL real. Confere também a persistência dos dados após as tentativas negadas e a continuidade das alterações legítimas.

## Organização e tipagem

- `app/port-app.tsx` coordena sessão, navegação e sincronização. Formulários, visão geral, relatórios e administração ficam nos módulos `portal-*` correspondentes.
- `lib/operational-types.ts` define os contratos operacionais e de sessão; `app/portal-types.ts` descreve os dados usados na interface. Campos de extensão usam `unknown` e exigem refinamento antes do uso. Não há `any` explícito nos fontes de `app/` e `lib/`.
- `app/use-paged-records.ts` centraliza a consulta paginada, cancelamento e descarte de resultados de filtros anteriores. `app/use-clock.ts` atualiza os rótulos dependentes de tempo sem depender de uma revisão nova do banco.
- `app/private-image.tsx` mantém as imagens autenticadas fora do otimizador público. A exceção de lint fica somente nesse componente, com texto alternativo obrigatório; não desativa a regra no restante do projeto.
- `tests/support/sqlite-fixture.mjs` substitui os adaptadores D1 duplicados. Os testes PostgreSQL usam bancos e papéis temporários, removidos ao terminar.

O código de `app/` e `lib/` é formatado com Prettier. A alteração de formatação torna as funções legíveis e ocupa parte considerável do diff; não representa uma reescrita das regras de negócio.

## Estilos

`app/globals.css` é a folha de estilos compartilhada. O conteúdo antes carregado por `app/design-system.css` foi incorporado mantendo a ordem da cascata. Foram retiradas 56 declarações substituídas por outras do mesmo seletor e contexto, além de sete regras vazias. As condições responsivas e de impressão permanecem.

A verificação local comparou os estilos computados com a folha anterior em Central de Acesso, Visitantes, Cadastros e Relatórios, nas larguras 390, 768 e 1366 px: nenhuma diferença nas propriedades comparadas. O teste visual existente também percorre os formulários, os módulos e os estados responsivos.

## Verificações e CI

```powershell
npm ci
npm run lint
npm run format:check
npm run check
npm test
npm run build
npm run test:ui
```

O lint executa o repositório completo com `--max-warnings=0`. A formatação não substitui a checagem de tipos nem os testes.

Com PostgreSQL de teste disponível, `npm test` inclui a importação iDSecure e as regressões de autorização e auditoria. A fixture lê `PORTO_TEST_POSTGRES_CONFIG` ou a configuração local; cria seus próprios bancos e não usa o banco operacional como base de testes. Sem PostgreSQL configurado, os casos dependentes dele são marcados como ignorados. No job PostgreSQL do CI a configuração é obrigatória e o serviço PostgreSQL 17 é provisionado pelo workflow.

Após o build nativo, as verificações de navegador são:

```powershell
npm run test:access:browser
npm run test:monitor:browser
npm run test:visitor-face:browser
npm run test:porto:browser
$env:PORTO_TEST_VIDEO_BROWSER='true'
$env:PORTO_TEST_HTTPS='true'
node --experimental-strip-types --test tests/postgres.test.mjs
Remove-Item Env:PORTO_TEST_VIDEO_BROWSER, Env:PORTO_TEST_HTTPS
$env:PORTO_E2E_MANAGE_SERVER='true'
npm run test:hmr
Remove-Item Env:PORTO_E2E_MANAGE_SERVER
```

Os navegadores usam dados e credenciais fictícios, portas locais e integrações desabilitadas ou simuladas. Esses testes não provisionam rostos, não alteram usuários reais nem enviam comandos às catracas. As evidências locais ficam em `.porto-tooling/`, fora do versionamento.

`.github/workflows/quality.yml` verifica tipos, lint completo, formatação, testes e builds em Windows e Linux. O job PostgreSQL executa toda a suíte, incluindo iDSecure, seguido dos fluxos de navegador, mídia privada, HTTPS e recarregamento automático.

### Evidências locais de 11/11/2026

| Verificação | Resultado |
| --- | --- |
| Lint completo | Nenhum erro ou aviso |
| Tipagem, formatação e build nativo | Aprovados |
| Suíte completa, com PostgreSQL e os dois casos opcionais de navegador/HTTPS habilitados | 281 aprovados, nenhuma falha ou teste ignorado |
| Interface responsiva e acessibilidade automática | 139 verificações aprovadas |
| Comparação de estilos antes/depois | 12 telas/larguras, nenhuma diferença nas propriedades comparadas |
| Acesso regular e saídas não confirmadas | 8 capturas, sem erros de navegador ou violações automáticas WCAG |
| Monitor com eventos simulados | 6 capturas, sem erros de navegador ou violações automáticas WCAG |
| Câmera e foto privada do visitante | 3 capturas, sem erros de navegador ou violações automáticas WCAG |
| Fluxo Porto sobre HTTPS | 27 capturas e fluxo aprovados |
| Recarregamento automático | Alteração recebida sem perder o estado React |

Esses resultados são de execução local em Windows. O workflow foi atualizado; sua execução remota depende da publicação das alterações no GitHub.

Os avisos de dependências receberam atualização e avaliação em 17/11/2026. A auditoria atual retornou zero alertas conhecidos. Versões, evidências e pendências de credencial, recuperação e implantação estão em [Prontidão operacional](PRONTIDAO-OPERACIONAL.md). Esse resultado não é uma declaração de ausência de outras vulnerabilidades.
