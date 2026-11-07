# Redesign Enterprise Minimalista

Data: 07/11/2026. Branch: `feat/enterprise-minimal-ui`, baseada em `06eeba5` (preparação Control iD e estabilidade PostgreSQL). O redesenho não constitui uma versão já implantada no servidor.

## Auditoria antes da implementação

| Área | Estrutura encontrada e decisão |
| --- | --- |
| Navegação | `PortApp`, navegação por estado `Page`, sem alteração de URL; menu filtrado por perfil/capacidade. Preservar identificadores e destinos. |
| Telas | Visão geral, Central, visitantes, veículos, ocorrências/turnos, notificações, pessoas/frota/empresas, relatórios, auditoria, administração e senha. |
| Administração | Unidade, usuários/permissões, backup/contingência, continuidade, permissões detalhadas e setores. |
| Central | Operação, emergência, indicadores, crachás/leitor QR, segurança/validade; ficha única, histórico, requisitos e correção de saída. |
| Formulários/diálogos | Solicitação, veículo, aprovação, entrada/saída, recusa/revogação, correção, cadastros, usuários/senhas, ocorrência/evidências, turno, setor, requisitos, restauração e impressão. Ações e confirmações continuam nos componentes operacionais existentes. |
| Duplicação | Três implementações de botão/campo/diálogo; regras repetidas de sidebar, tabela e tipografia; sobreposições de CSS reduziam textos a 8–11 px. |
| Responsividade | Breakpoints sobrepostos em 1250/1050/780/700/540 px, tabela móvel própria na Central; menu desktop sem recolhimento. |
| Estados | Paginação assíncrona, erros com tentativa novamente, sincronização, desconexão com bloqueio de escrita, sessão/senha/permissão, salvamento, conflitos preservando campos, toasts e estados vazios já existentes. Preservados. |
| Oportunidades | Extrair a estrutura da aplicação e primitivas de apresentação, sem reestruturar domínio/API ou a persistência. Consolidar propriedades compartilhadas e manter CSS especializado/impresso. |

As imagens de referência orientaram paleta, densidade e organização. Os números, tendências, fotografias e suposta câmera ao vivo nelas não foram introduzidos como informações reais.

## Design System e componentes

`app/design-system.css` concentra tokens e padrões de tela: navy `#102542`, ação `#2563EB`, fundo `#F5F7FB`, superfície branca, borda `#E2E8F0`; raios de 8/12 px, sombras discretas, espaçamentos de 4–24 px e transições de 160 ms. O cinza secundário foi ajustado de `#64748B` para `#5B6B82` para passar também sobre o fundo claro, não somente sobre branco. Verde, âmbar e vermelho têm superfícies claras e textos mais escuros para contraste.

Títulos 25–26 px, seções 17–20 px, texto 14 px, secundário 13 px, labels/captions 12–13 px e números 28–30 px. Inter é a primeira opção da pilha; Segoe UI é o fallback local do Windows. Não há download de fonte externa. Lucide e BrandMark existentes foram mantidos. Nenhuma biblioteca de componentes foi adicionada; `axe-core` é dependência de desenvolvimento para análise automática de acessibilidade.

Componentes reutilizáveis:

- `AppShell`, `Sidebar` e `Topbar` em `app/app-shell.tsx`: menu 220/68 px no desktop, drawer de 260 px até 900 px, perfil inferior, busca e breadcrumbs.
- `PageHeader`, `StatCard`, `Button`, `StatusBadge`, `EmptyState`, `SearchField`, `FormField`, `FormSection`, `DataTable`, `LoadingState` e `ModalFrame` em `app/ui.tsx`.
- `ModalFrame` é a base também dos diálogos de confirmação. A escolha de confirmar, as condições obrigatórias e os comandos permanecem nos módulos de origem.

Foram removidas as propriedades duplicadas de `globals.css` que passaram a pertencer ao Design System, e estilos de banners sem uso. Regras específicas de módulos e impressão foram mantidas. A refatoração dos grandes módulos de negócio não foi incluída neste trabalho visual.

## Mudanças por tela

| Tela | Resultado |
| --- | --- |
| Global | Menu recolhível com títulos nas ações, drawer com Escape e foco contido, rolagem própria, cabeçalho compacto, busca também no celular e atalho Ctrl/Cmd+K, sincronização e perfil acionável. |
| Central | Remoção do banner, ações no cabeçalho ligadas à solicitação/veículo/leitor existentes, quatro indicadores clicáveis, filtros e consulta prioritários, ações de autorização/entrada/saída diretamente nas linhas com as mesmas permissões e confirmações. |
| Movimentações | Lista dos últimos cinco eventos de entrada/saída disponíveis na janela operacional. Cada timestamp físico vira um evento; aprovações não são tratadas como presença. A ficha abre a partir de cada evento. |
| Emergência/indicadores/QR/requisitos | Recursos preservados e padronizados, sem mudanças nas conferências, validações de identidade, câmeras ou permissões. |
| Visitantes/veículos | Tabelas mais legíveis, busca/filtros, placas em monoespaçado, status com texto e cor, ações acessíveis; Veículos também filtra o período de entrada, aproveitando a consulta existente. Rolagem horizontal fica restrita à tabela. |
| Cadastros e formulários | Campos/ajudas padronizados, agrupamento de identificação, autorização e operação; confirmação de desativação preservada. |
| Ocorrências/turnos | Prioridades diferenciadas, listas/evidências, histórico e passagem de turno com o mesmo padrão visual. Uploads privados existentes preservados. |
| Relatórios/auditoria | Filtros legíveis, tabelas com região rolável acessível por teclado; exportação/impressão continuam dependentes de capacidade. |
| Administração/senha | Cards, formulários, usuários, perfis, situações, backup e setores padronizados. |

O fechamento por clique acidental no fundo do diálogo foi retirado; fechar/cancelar e Escape continuam disponíveis, respeitando a proteção contra fechamento durante salvamento. Valores de formulário não são gravados no navegador. Foco retorna à ação de origem, e o conteúdo ao fundo fica `inert` durante os diálogos.

Os diálogos são montados por portal no `body`, fora da área de trabalho. Na impressão do relatório/crachá/contingência, isso permite ocultar o shell completo sem ocultar o documento ou deixar uma página vazia antes dele; a rolagem bloqueada do modal também é liberada no meio de impressão. A revisão inclui confirmação de que o cabeçalho do documento aparece na primeira área visível de impressão em desktop e celular.

## Verificação reproduzível

```powershell
npm run check
npm run lint:ui
npm test
npm run build
npm run build:demo
npm run test:ui
```

`test:ui` compila a demonstração e inicia sua prévia de produção isolada em `127.0.0.1:4173/Next-Portaria/`, abre Chromium/Edge headless, captura evidências em `.porto-tooling/ui-review` e encerra o processo que ele próprio iniciou. Usa os componentes reais e uma API em memória, sem carregar credenciais ou conectar no banco operacional. As chamadas de API de rede são bloqueadas no navegador de teste. Usar a versão compilada evita interferência de atualizações de CSS/HMR na captura.

Se a demonstração já estiver aberta:

```powershell
$env:PORTO_UI_MANAGE_SERVER='false'
npm run test:ui
```

Também é possível indicar `PORTO_UI_OUTPUT`, `PORTO_PLAYWRIGHT_CHANNEL` e `PORTO_UI_WIDTHS` (por exemplo, `1366,390` para uma revisão focada). No Linux, instalar o Chromium de testes antes com `npx playwright install --with-deps chromium`.

O workflow Quality ganhou um job específico de UI/acessibilidade e guarda screenshots/relatório como artifact. A aprovação remota deste novo job depende da publicação da branch.

Cobertura visual: 1920×1080, 1366×768, 768×1024, 430×844, 390×844 e 360×844. Módulos principais em todas as larguras; formulários, abas da Central, confirmação de autorização, menu recolhido/móvel e busca. Administração detalhada, cadastros, ocorrências, passagem de turno e senha também são inspecionados em desktop e celular.

A análise axe usa regras WCAG 2 A/AA, 2.1 AA e 2.2 AA; validação adicional confere overflow da página/diálogos, foco, Escape, busca, filtros e conclusão de autorização apenas nos dados fictícios. Isso não substitui homologação humana com leitores de tela, dispositivos e câmeras reais.

Os testes PostgreSQL/HTTPS/vídeo existentes podem ser executados separadamente em bases QA descartáveis:

```powershell
$env:PORTO_TEST_VIDEO_BROWSER='true'
$env:PORTO_TEST_HTTPS='true'
node --experimental-strip-types --test tests/postgres.test.mjs
```

## Limites e próxima etapa

- Nenhuma API, regra de negócio, migração, credencial ou dado operacional foi alterado.
- O servidor `192.168.0.2:8443` não recebeu esta branch. A base inclui os commits ainda em revisão da PR #5; revisar/organizar essa dependência antes de uma nova versão estável.
- A dívida de lint dos módulos anteriores continua registrada. As novas primitivas, shell e script têm verificação específica; o lint global não é apresentado como aprovado.
- A demonstração não testa permissão de câmera, equipamento Control iD ou todos os navegadores/dispositivos físicos. Autorizações/permissões continuam cobertas pelos testes existentes de domínio/API.
- Próxima evolução recomendada: homologação com operadores, teclado/leitor de tela e celulares reais; revisão da branch e depois versão de servidor com os procedimentos de backup já definidos. O destino externo de backup continua pendente de definição.

## Resultado local da entrega

| Verificação | Resultado |
| --- | --- |
| TypeScript | Aprovado (`npm run check`). |
| Lint das novas primitivas, shell e teste visual | Aprovado (`npm run lint:ui`), sem erros ou avisos. |
| Lint de estabilidade | Aprovado (`npm run lint:stability`). |
| Testes gerais | 196 testes: 194 aprovados, dois testes de navegador reservados, nenhuma falha. |
| PostgreSQL + navegador/HTTPS | 18 aprovados, nenhum ignorado: vídeo privado real, HTTPS, concorrência e recuperação em bases QA. A verificação final também aprovou o login móvel servido pela aplicação nativa, sem overflow ou violações axe. |
| Builds | Aplicação nativa de produção e demonstração aprovadas. |
| UI | 125 verificações aprovadas sobre a demonstração compilada em seis resoluções, incluindo prévia de impressão; sem overflow da página/diálogo, erros JS ou violações automáticas axe nas telas analisadas. O resultado final está em `relatorio.json`. |
| Recarregamento automático | Aprovado: alteração recebida pelo navegador e contador React preservado, sem recarga da página. Uma execução inicial excedeu o prazo de inicialização durante verificações concorrentes; a repetição após a rodada visual passou. |
| Dados de desenvolvimento | Verificados os hashes da migração: 19 tabelas, 38 linhas, 13 registros operacionais e um usuário preservados; conexão sem superusuário e sem permissão de atualizar auditoria. |
| Lint global | 61 erros e 13 avisos em código anterior; continua pendente. O baseline registrado antes do redesign era 64 erros e 13 avisos. O bundle gerado de `dist-demo` foi excluído do lint, assim como o build `dist` já era excluído; o código-fonte da demonstração continua sendo analisado. |

As capturas, a galeria `comparacao.html` e `relatorio.json` ficam em `outputs/NextPortaria-redesign`, ao lado da pasta do repositório no workspace desta entrega. O relatório automático reproduzível de futuras execuções fica em `.porto-tooling/ui-review` por padrão. Ambos contêm somente dados fictícios da demonstração.

Os builds ainda avisam sobre o tamanho de um bundle da demonstração e a classificação estática de rotas pelo vinext. Não houve alteração da classificação de rotas ou introdução de carregamento remoto de fontes. Divisão adicional do bundle pode ser avaliada depois com medição em ambiente de produção.

## Arquivos da alteração

| Arquivos | Responsabilidade |
| --- | --- |
| `app/app-shell.tsx`, `app/ui.tsx`, `app/design-system.css` | Novos componentes e Design System. |
| `app/port-app.tsx`, `app/access-panels.tsx`, `app/v3-panels.tsx` | Adoção dos componentes, navegação, Central e organização dos formulários. |
| `app/globals.css`, `app/layout.tsx` | Consolidação dos estilos e carregamento do Design System. |
| `demo/main.tsx`, `demo/styles.css`, `demo/vite.config.ts` | Mesma interface na demonstração; banner não encobre os diálogos; prévia compatível com o endereço de produção. |
| `scripts/check-ui.mjs`, `package.json`, `package-lock.json` | Teste visual/acessibilidade, comandos npm e dependência de teste axe. |
| `.github/workflows/quality.yml` | Execução e evidências de UI no CI. |
| `eslint.config.mjs` | Exclui somente o bundle gerado de `dist-demo` da análise de código-fonte. |
| `tests/postgres.test.mjs` | Verificação de acessibilidade/overflow no login móvel servido por HTTPS em base QA. |
| `README.md`, `docs/REDESIGN-ENTERPRISE.md` | Auditoria, decisões, resultados e comandos de validação. |

## Refinamento solicitado após a revisão visual

Os quatro ajustes adicionais foram implementados na mesma branch local:

1. **Central objetiva:** painel inicial com movimentações recentes e resumos próximos de pendências e pessoas presentes. Autorizar e registrar saída usam as confirmações e permissões existentes. Os links dos resumos e os indicadores abrem a lista detalhada, sem obrigar a percorrer uma tabela antes de consultar os demais dados.
2. **Filtros recolhíveis:** busca e seletor de lista permanecem visíveis. Setor, portaria e tipo de pessoa ficam no botão Filtros, com contador dos critérios ativos. Recolher preserva os valores; limpar e voltar à visão operacional são ações explícitas.
3. **Mobile compacto:** indicadores com aproximadamente 96 px de altura e descrições auxiliares disponíveis para tecnologia assistiva; previews curtos, sem remover o acesso às listas completas. A identificação textual de entrada/saída permanece disponível no resumo móvel.
4. **Cadastros em etapas:** visitas, veículos e cadastros de pessoas/empresas/frota usam etapas curtas. Dados complementares e observações opcionais são expansíveis. Todos os campos permanecem montados e os valores são preservados ao voltar. O avanço verifica as restrições HTML da etapa; o envio final verifica todas as etapas. Enter e o menu de etapas não pulam campos obrigatórios. A API e o payload dos comandos foram mantidos.

Novos componentes: `app/access-overview.tsx` e `app/form-steps.tsx`. O segundo contém apenas navegação e validação nativa de formulário; nenhuma regra de autorização foi transferida do servidor. O toast de uma ação anterior não encobre os botões de um diálogo novo.

As verificações do navegador foram ampliadas para filtros recolhidos/expandidos, preservação de valores, validações de obrigatoriedade e e-mail, envio efetivo de visita e empresa somente na API fictícia em memória, acompanhamento de pessoas no fluxo de veículo, acesso aos campos de segurança e botões de formulário sem sobreposição. As novas evidências e a comparação desta rodada ficam em `outputs/NextPortaria-refinamento` no workspace. A homologação em dispositivos físicos e a implantação continuam sendo etapas posteriores.

Resultado da rodada: **139 verificações visuais aprovadas nas seis resoluções**, sem erros de navegador, overflow indevido ou violações automáticas axe nas telas analisadas; **194 testes gerais aprovados**, com dois testes de navegador executados na rotina específica. TypeScript e `lint:ui` aprovados. A dívida anterior de lint global permanece em 61 erros e 13 avisos. As capturas de antes foram preservadas na pasta de evidências; `comparacao.html` permite conferir lado a lado o desktop, o celular e as etapas do formulário.

A compilação final de produção e os **18 testes específicos de PostgreSQL/HTTPS/vídeo** passaram após o refinamento. A comparação dos hashes da base de desenvolvimento confirmou novamente 19 tabelas e 38 linhas preservadas, incluindo 13 registros operacionais e um usuário. O refinamento permanece local, sem commit/push ou implantação automática.
