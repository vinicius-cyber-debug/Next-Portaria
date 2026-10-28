# Arquitetura — Next Portaria

Monólito de portaria e controle de acesso com interface React, rotas Vinext e persistência Cloudflare D1 (SQLite). Anexos e backups operacionais usam R2 privado. Na instalação local, Wrangler executa o Worker e mantém os dados em `.wrangler/state`.

## Fluxo de uma operação

```text
app/page.tsx → app/port-app.tsx e painéis React
    → HTTP /api/*
    → app/api/[...path]/route.ts
    → lib/server.ts
        → lib/local-auth.ts          credenciais e sessão
        → lib/access.mjs             permissões e campos visíveis
        → lib/module-policy.mjs      escopo operacional permitido
        → lib/domain.mjs
            → lib/physical-access.mjs regras de acesso físico
        → D1                         transação e auditoria
        → R2                         anexos privados
```

A rota entrega os bindings `DB` e `BUCKET` ao serviço. `lib/server.ts` valida transporte, origem, sessão, permissões e política de módulos; fixa autor e horário; executa o comando de domínio e grava as alterações. Revisão esperada, chave de idempotência e proteções do banco evitam sobrescrita concorrente e repetição de comandos concluídos. A resposta passa pela filtragem de acesso e de escopo antes de chegar ao navegador.

## Responsabilidades

| Arquivo ou pasta | Responsabilidade |
| --- | --- |
| `app/layout.tsx`, `app/globals.css` | Estrutura HTML, metadados e estilos compartilhados. |
| `app/port-app.tsx` | Composição da aplicação, sessão, navegação, formulários e estado operacional do cliente. |
| `app/access-panels.tsx` | Central de acesso, pessoas, setores, indicadores e emergência. |
| `app/v3-panels.tsx` | Portaria rápida, crachás, ocorrências, turnos, notificações, continuidade e permissões. |
| `app/v5-panels.tsx` | Responsáveis, requisitos, troca de senha e consultas paginadas. |
| `app/transport-notice.tsx` | Orientação quando o acesso exige HTTPS. |
| `lib/domain.mjs` | Transições e validação do estado sem acesso ao banco; conserva regras históricas necessárias à compatibilidade de backups. |
| `lib/physical-access.mjs` | Identidade, elegibilidade, requisitos, áreas restritas, presença e emergência. |
| `lib/module-policy.mjs` | Política de módulos ativos, bloqueio de operações retiradas e filtragem do estado operacional. |
| `lib/access.mjs` | Capacidades por perfil, restrições individuais e retirada de campos sem permissão. |
| `lib/server.ts` | Coordenação HTTP, autenticação, autorização, SQL, transações, auditoria e recursos privados. |
| `lib/local-auth.ts` | Validação de credenciais, derivação de senha com PBKDF2, tokens e cookies de sessão. |
| `lib/state-sync.ts` | Janela operacional, histórico paginado, mudanças por revisão e filtragem de consultas. |
| `lib/client-sync.mjs`, `lib/client-id.ts` | Aplicação imutável de mudanças e identificadores de requisição no cliente. |
| `lib/continuity.ts` | Backup JSON em R2, verificação, retenção e notificações internas. |
| `lib/full-backup.mjs` | Cópia criptografada e restauração completa da instalação local. |
| `scripts/local-service.mjs` | Supervisão do Worker compilado e agendamento de backup completo. |
| `worker/index.ts`, `vite.config.ts` | Entrada do Worker, compilação e configuração dos bindings Cloudflare. |
| `scripts/runtime-env.mjs`, `scripts/tool-environment.mjs` | Ambiente local das ferramentas e diretórios auxiliares em `.porto-tooling`. |
| `db/schema.ts`, `db/guards.sql`, `drizzle/` | Esquema Drizzle, proteções de integridade, migrações D1 e metadados. |
| `tests/` | Testes de regras, API, autenticação, sincronização e recuperação; a API é exercitada com SQLite e adaptador D1. |

Os nomes `v3` e `v5` dos painéis indicam etapas de evolução do mesmo aplicativo, não aplicações ou runtimes separados.

## Persistência e sincronização

`operational_records` armazena entidades por coleção e identificador, com corpo JSON e colunas derivadas indexadas. Configuração, usuários, credenciais, sessões, permissões, auditoria, comandos e mudanças possuem tabelas próprias. O serviço usa a API D1 diretamente; Drizzle define o esquema e gera migrações.

O carregamento operacional conserva registros abertos, cadastros de referência e histórico recente de 30 dias, com até 100 eventos de auditoria. Consultas anteriores usam paginação no servidor. A sincronização aplica mudanças por revisão e solicita novo estado quando necessário; o cliente mescla as mudanças sem modificar a cópia anterior. Os comandos de gravação ainda carregam e validam o estado integral no servidor.

## Política de módulos e compatibilidade

O escopo ativo inclui pessoas, visitantes, veículos, setores, requisitos, emergência, ocorrências, turnos, notificações e administração. Embarcações, atracações, tripulação, reservas de berços, financeiro, contratos e fechamento mensal estão desativados na interface e na API operacional.

`assertActiveCommand` rejeita comandos, destinos e parâmetros retirados. `assertActiveCollection` bloqueia consultas e exportações das coleções desativadas; a prévia mensal também é bloqueada. A resposta usa `MODULE_REMOVED`, inclusive para administradores. `activeState` conserva o formato estável das respostas, com coleções desativadas vazias e sem as configurações correspondentes.

A desativação não apaga o banco. `validateState` conserva a validação de relações e valores históricos para backup e restauração compatíveis. O executor histórico privado de `lib/domain.mjs` atende às amostras históricas de teste; o ponto público `execute` aplica a política atual. Restaurar uma cópia preserva os registros, mas mantém os módulos desativados.

Migrações distribuídas e seus metadados devem permanecer em `drizzle/`. Alterações de esquema exigem nova migração e validação de atualização de uma base existente. `scripts/setup-local.mjs` aplica somente migrações locais pendentes e interrompe a execução se encontrar um esquema parcial.

## Fronteiras e limites

- A interface depende de HTTP e funções de domínio compartilháveis. SQL, credenciais, bindings e recuperação do sistema de arquivos pertencem ao servidor ou às ferramentas locais.
- Domínio e acesso físico não dependem de React, HTTP, D1 ou R2. O serviço fornece estado, comando, autor e instante da operação.
- Permissões e política de módulos são verificadas no servidor, incluindo consultas, sincronização e exportações. Backups administrativos conservam o histórico para recuperação.
- `lib/server.ts`, `lib/domain.mjs` e `app/port-app.tsx` ainda concentram responsabilidades extensas. Extrações futuras devem acompanhar funcionalidades e preservar os testes transacionais.
- A aplicação atende uma unidade e exige conexão para gravar. A cópia carregada permite consulta de contingência, sem fila de gravações offline.

O [README](../README.md) apresenta as funcionalidades. O [guia de operação local](OPERACAO-LOCAL.md) descreve instalação, autenticação, rede e recuperação.
