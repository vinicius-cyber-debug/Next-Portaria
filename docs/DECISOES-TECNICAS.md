# Decisões técnicas — Next Portaria

Este documento explica a arquitetura atual e suas implicações. Os detalhes de módulos e arquivos estão em [Arquitetura](ARQUITETURA.md).

## D1/SQLite para os dados operacionais

A aplicação usa Cloudflare D1, baseado em SQLite, e mantém o mesmo modelo na instalação local executada com Wrangler. Essa organização permite trabalhar com persistência relacional, migrações e proteções de integridade sem introduzir outro mecanismo de banco na instalação local.

Drizzle define o esquema e gera migrações; o serviço usa a API D1 diretamente. Entidades operacionais combinam corpo JSON e colunas derivadas indexadas, enquanto usuários, sessões, permissões, auditoria e comandos possuem tabelas próprias.

**Limite:** o escopo atual atende uma unidade. Comandos de gravação ainda carregam e validam o estado integral no servidor; crescimento de volume exige avaliar esse custo antes de ampliar o uso.

## Permissões verificadas no servidor

O controle combina o perfil base com capacidades específicas, como operar portaria, consultar auditoria ou exportar dados. Em `lib/access.mjs`, `canWithCapabilities` exige usuário ativo, autorização do perfil e a capacidade correspondente ao comando. Uma capacidade adicional não contorna a restrição do perfil base.

O servidor também filtra campos e coleções antes de responder. Ocultar um botão na interface não substitui autorização. A política de módulos bloqueia funcionalidades retiradas inclusive para administradores.

**Desafio tratado:** manter consultas, sincronização e exportações sujeitas às mesmas fronteiras de acesso. Os testes de acesso, API e política de módulos ajudam a verificar essas regras.

## Regras de domínio separadas do transporte

As transições de negócio ficam em `lib/domain.mjs` e as regras de acesso físico em `lib/physical-access.mjs`. Esses módulos não dependem de React, HTTP ou bindings Cloudflare. O serviço fornece estado, comando, autor e instante da operação.

Essa separação permite exercitar regras com entradas controladas. A API também possui testes com SQLite e um adaptador D1.

**Limite:** `lib/server.ts`, `lib/domain.mjs` e `app/port-app.tsx` ainda concentram responsabilidades extensas. Extrações devem preservar o comportamento transacional e acompanhar funcionalidades.

## Revisões e idempotência nas gravações

A API combina revisão esperada, chave de idempotência e proteções do banco para evitar sobrescritas concorrentes e repetição de comandos concluídos. Autor e horário são fixados no servidor, e as operações deixam histórico de auditoria.

**Desafio tratado:** várias pessoas podem operar sobre informações relacionadas. Uma repetição de requisição ou uma tela desatualizada precisa ser tratada pelo servidor.

## Histórico paginado e sincronização incremental

A carga operacional mantém registros abertos, referências e histórico recente de 30 dias, com até 100 eventos de auditoria. Consultas antigas usam paginação; a sincronização aplica mudanças por revisão e solicita novo estado quando necessário.

**Trade-off:** a consulta de contingência pode usar a cópia já carregada, mas gravações exigem conexão. Não existe fila de gravações offline.

## Demonstração separada da operação

A demonstração abre sem login, usa dados fictícios e mantém alterações somente na memória da aba. Isso permite conhecer a interface sem instalar o serviço ou expor uma base operacional.

A instalação com persistência usa contas individuais, autenticação no servidor e armazenamento privado. A demonstração apresenta os fluxos visuais; não substitui a validação da instalação operacional.

## Recuperação com finalidades distintas

O backup JSON operacional e a cópia completa criptografada atendem a necessidades diferentes, detalhadas no [guia de operação](OPERACAO-LOCAL.md). A recuperação conserva registros históricos, enquanto a política atual mantém módulos retirados indisponíveis.

**Desafio tratado:** preservar a possibilidade de restauração sem reativar funcionalidades fora do escopo atual.
