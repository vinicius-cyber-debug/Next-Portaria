# Validacao local — 0.6.0

Data: 5 de novembro de 2026. Ambiente: Windows, Node.js 24.13.1, PostgreSQL 17.11, driver pg 8.23.1. Esta validacao e local; nao houve implantacao no servidor da empresa nem publicacao desta versao no GitHub.

## Dados preservados

- Backup completo SQLite criado e restaurado para verificacao antes da migracao.
- Importacao da origem aberta somente para leitura: 19 tabelas, 38 linhas ao todo, incluindo 13 registros operacionais, 1 usuario, sua credencial e 20 eventos de auditoria.
- Todas as linhas comparadas por SHA-256, preservando hashes de senha, revisao e ordenacao.
- Segunda conferencia apos reiniciar o PostgreSQL confirmou os mesmos registros e checksums.
- A repeticao da carga ficticia foi recusada e as linhas existentes permaneceram iguais.

## Aplicacao e integridade

- Suite geral: 164 testes aprovados, nenhum teste ignorado nesta maquina.
- Revalidacao posterior dos procedimentos de backup e PostgreSQL: 16 testes aprovados.
- TypeScript aprovado; lint dos novos modulos de persistencia, armazenamento, operacao PostgreSQL e respectivos testes aprovado.
- Compilacao nativa PostgreSQL e compilacao alternativa D1/SQLite aprovadas.
- Compilacao Node iniciou em loopback: pagina HTTP 200 com titulo correto, sessao sem autenticacao HTTP 401.
- Comandos de status e parada reconheceram e encerraram o processo proprio, preservando o PostgreSQL.
- Conexao de aplicacao sem superusuario e sem permissao de alterar auditoria.

Os testes PostgreSQL usam bancos, papeis e arquivos de QA separados. Exercitam login real, CSRF, solicitacao, aprovacao, identidade, entrada, busca paginada, conflito de revisao, rollback integral, ultimo administrador e auditoria imutavel.

## Arquivos e recuperacao

- Anexo PNG sintetico enviado e recuperado pela API autenticada; acesso sem sessao recusado.
- Arquivo binario sintetico de 8 MiB gravado por fluxo e vinculado a metadados de midia, com tamanho e SHA-256 conferidos. Esse teste nao valida codec ou reproducao de video.
- Upload de teste acima da cota foi interrompido sem publicar arquivo parcial.
- Backup QA criptografado restaurou banco, anexo e midia em outro banco e outra pasta; verificacao detectou adulteracao posterior do pacote.
- Backup real da base PostgreSQL tambem foi criado e restaurado para verificacao: 22 tabelas. Esta base local ainda nao possui anexos operacionais, portanto o ensaio real nao continha objetos; a recuperacao com objetos foi validada no QA.
- A chave de recuperacao permanece separada do pacote criptografado.

## Limites desta entrega

Em 6 de novembro, o timeout RSC de desenvolvimento foi corrigido atualizando Vinext/Vite e React compativel, usando a CLI do Vite para desenvolvimento e compilacao. O ensaio Playwright em Edge confirmou hidratacao, clique com estado React e alteracao automatica do componente mantendo esse estado. O teste `npm run test:hmr` passou a fazer parte da verificacao PostgreSQL no CI. O modo nativo e o modo Cloudflare usam caches Vite separados dentro de node_modules.

A estrutura de banco e armazenamento foi preparada para midias. A interface de upload de videos, retomada de envio, codecs, miniaturas e transcodificacao ainda nao foram implementados. O envio antigo continua limitado a 5 MiB.

Nao houve teste em celular fisico, medicao de capacidade em historico grande, configuracao S3 remota ou prova de carga sustentada. A validacao integral de estado ainda existe nas gravacoes.

Backups PostgreSQL desta etapa sao manuais e exigem parar a aplicacao. Copia externa, agendamento, HTTPS e servico Node sem login pertencem a implantacao no servidor. O workflow recebeu um job de PostgreSQL, mas sua execucao no GitHub ainda depende da publicacao do codigo.
