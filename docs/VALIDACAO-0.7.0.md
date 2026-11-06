# Validação — 0.7.0

Ambiente local em 6/11/2026: Windows, Node.js 24.13.1, PostgreSQL 17.11, Edge com Playwright. Os testes usam contas, bancos e arquivos isolados; não recebem a senha pessoal do administrador.

- Suíte geral: 171 testes, 169 aprovados e dois testes de navegador/HTTPS reservados à execução específica, sem falhas.
- Execução específica PostgreSQL, navegador e HTTPS: inclui todos os testes reservados, reprodução de MP4 real e envio na interface compilada, com interrupção da segunda parte, recarga e retomada sem reenviar a primeira.
- Doze solicitações simultâneas respeitam o limite de três envios pendentes, sem esgotar o pool de conexões. Revalidação usa a conexão da transação.
- Conteúdo disfarçado, SHA incorreto, tamanho excessivo, acesso sem sessão, dono diferente, revogação de permissão e logout durante o corpo são recusados.
- Conteúdo privado entrega intervalos HTTP, HEAD e 416 para intervalo inválido. O gateway valida certificado/SAN, host, origem e cookie Secure.
- Retenção sem exclusão automática por padrão; política confirmada, vencimento imediato do acesso, limpeza repetível e auditoria exercitados.
- Backup QA criptografado restaura banco, imagem e vídeo; corrupção do pacote é detectada.
- TypeScript e lint dos módulos novos/alterados de persistência, armazenamento, mídia e scripts aprovados. O lint global possui pendências históricas e não é declarado limpo.
- Scripts PowerShell analisados pelo parser; não foram registrados serviços, tarefas nem regras de firewall nesta máquina de desenvolvimento.

## Preservação da base local

Antes da migração de mídias foi criado e restaurado para verificar o backup de 6/11/2026 às 18:47 UTC. A migração aplicou somente novas tabelas/colunas; as 19 tabelas operacionais mantiveram os mesmos checksums, 13 registros operacionais e um usuário com sua credencial preservada. SQLite e backups anteriores foram mantidos.

A linha de base original misturava CRLF do esquema SQLite com LF dos templates. A reconstrução somente leitura da origem reproduziu exatamente o checksum gravado, e sua normalização foi comparada ao SQL versionado. Esses bytes originais foram arquivados em `database/postgres/legacy/001_core.sql`, preservados por `.gitattributes`. O migrador aceita essa origem apenas se o hash arquivado e o SQL normalizado forem iguais; uma divergência real continua bloqueando. Novas aplicações usam LF estável entre Windows e Linux.

## Limites do aceite

O pacote deve ser executado pelo Codex/terminal do servidor. Nenhuma implantação remota, confiança de certificado em aparelhos reais, reinício sem login, acesso externo à máquina ou cópia para compartilhamento da empresa foi comprovada neste ambiente. O destino externo ainda não foi definido. O instalador exige esse destino e a chave separada e testa a execução real do backup antes de iniciar a aplicação.

Não houve teste em celular físico, transcodificação, recuperação contínua por WAL ou carga sustentada com grande histórico. Os resultados do workflow do GitHub pertencem ao commit publicado e devem ser consultados na revisão da release.
