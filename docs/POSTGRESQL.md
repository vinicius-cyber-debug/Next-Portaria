# PostgreSQL e armazenamento privado

O ambiente nativo utiliza PostgreSQL 17 e Node.js. A interface, as regras de acesso e a API sao preservadas. O armazenamento de arquivos e independente do banco e do codigo. O modo D1/SQLite continua disponivel para compatibilidade; nao compartilha dados automaticamente com PostgreSQL.

## Preparar uma instalacao Windows

Obtenha os binarios oficiais do PostgreSQL 17 no instalador ou arquivo ZIP indicado em https://www.postgresql.org/download/windows/. O instalador EDB da versao 17 e testado em Windows Server 2019 e 2022. Nao use uma versao principal diferente sem ensaiar compatibilidade e recuperacao.

Com as dependencias Node instaladas, adapte os caminhos e execute:

```powershell
node --experimental-strip-types scripts/postgres-local.mjs init --bin 'C:\Ferramentas\PostgreSQL17\bin' --data-root 'D:\NextPortariaData' --port 55432
```

O comando prepara um cluster proprio, restrito a `127.0.0.1`, com autenticacao SCRAM. Gera credenciais aleatorias, aplica as migracoes e cria um papel de aplicacao sem privilegios administrativos. Nao substitui uma instalacao PostgreSQL de terceiros nem apaga um cluster existente. Uma preparacao reconhecida e incompleta pode ser retomada; arquivos pendentes devem ser preservados.

As senhas de conexao ficam em arquivos privados, nunca no Git nem em argumentos de processo. `postgres.json` possui a conexao de aplicacao; a credencial administrativa separada e usada apenas por migracoes, importacao e recuperacao.

## Diretorios permanentes

No diretorio escolhido em `--data-root`:

| Caminho | Conteudo |
| --- | --- |
| `postgres/` | Cluster PostgreSQL. Nao copiar com o processo ativo para simular backup. |
| `media/` | Objetos privados. Nunca publicar como diretorio estatico. |
| `backups/` | Backups criptografados e verificados. |
| `admin.json` | Credencial administrativa de infraestrutura, com acesso restrito. |
| `recovery.key` | Chave dos backups; guardar copia externa separada dos arquivos criptografados. |

O codigo aponta para esses caminhos por `.porto-runtime/postgres.json`, ignorado pelo Git. Ao trocar a pasta da versao, reaplique a configuracao privada com os mesmos diretorios e permissões. Nao reconfigure um cluster novo sobre os dados existentes.

## Migrar SQLite existente

1. Encerre a aplicacao e crie o backup completo SQLite anterior a migracao.
2. Prepare um PostgreSQL novo e vazio.
3. Informe o arquivo SQLite operacional real:

```powershell
node --experimental-strip-types scripts/migrate-sqlite-to-postgres.mjs --offline --sqlite 'C:\Projeto\.wrangler\state\v3\d1\miniflare-D1DatabaseObject\BANCO.sqlite'
```

A origem e aberta somente para leitura. A importacao usa uma transacao, preserva credenciais, sessoes, revisoes, ordenacao e auditoria e compara todas as linhas das 19 tabelas operacionais por checksum. Um destino que ja possui registros e recusado. Objetos R2 locais, quando presentes, sao copiados para o armazenamento privado e conferidos. O relatorio privado fica em `.porto-runtime/sqlite-migration.json`.

O relatorio nao substitui um ensaio funcional. Confira login, presente/ausente, permissoes, historico e abertura de anexo antes de ativar outra instalacao. O SQLite original deve permanecer preservado para contingencia.

## Operacao local

```powershell
npm run postgres:status
npm run db:setup
npm run db:admin
npm run dev:local
```

`dev:local` inicia o cluster se necessario e abre o ambiente em `http://127.0.0.1:5180`. O administrador migrado utiliza a senha anterior. O cadastro interativo cria uma conta somente quando ainda nao existe administrador utilizavel.

Para executar a compilacao Node:

```powershell
npm run build
npm start
```

`npm run status` informa a situacao da aplicacao. `npm run stop` encerra somente o processo registrado desta copia, apos conferir sua identidade. O banco continua separado; `npm run postgres:stop` encerra o cluster. Use a parada do banco apenas depois da aplicacao.

O ambiente nativo ainda requer configurar HTTPS e execucao como servico na maquina de producao. O supervisor Wrangler legado e o antigo iniciador HTTPS D1 nao supervisionam o processo Node/PostgreSQL. Esta preparacao local nao instala automaticamente um servico no servidor da empresa.

## Atualizacao e migracoes

`ATUALIZAR-PORTO-LOCAL.cmd` reconhece PostgreSQL e delega a `ATUALIZAR-POSTGRES-LOCAL.cmd`: para a aplicacao registrada, cria backup verificado, instala as dependencias do lockfile, executa testes e tipos, compila e aplica migracoes. Nao inicia a nova versao automaticamente apos atualizar; confira o resultado e abra a aplicacao.

O esquema PostgreSQL esta em `database/postgres/`. Crie um novo arquivo SQL numerado para cada alteracao. Arquivos aplicados nunca devem ser editados: `portaria_migrations` registra o SHA-256 e rejeita divergencias. `drizzle/` e `db/schema.ts` descrevem exclusivamente o modo SQLite legado; `db:generate` nao gera migracoes PostgreSQL.

## Imagens e videos

Os anexos atuais continuam na API autenticada existente, com limite de 5 MiB e tipos PNG, JPEG, WebP e PDF. O PostgreSQL guarda os metadados; os bytes ficam em `media/` e sao lidos atraves da API.

As tabelas `media_assets` e `media_links` preparam a evolucao: chave do objeto, nome, MIME, tamanho, SHA-256, estado do envio, responsavel, datas e campos opcionais de duracao e dimensoes. Um arquivo so pode ficar `ready` com tamanho e hash definidos. A camada de arquivos suporta gravacao em fluxo, limite de bytes e checksum sem carregar o video inteiro na memoria.

A tela de envio de videos, retomada de uploads, validacao de codecs, miniaturas, transcodificacao, reproducao por intervalos e politica de retencao ainda serao implementadas na atualizacao de midia. A estrutura nao torna videos grandes aceitos pela rota antiga.

O provedor instalado e disco privado. A porta `ObjectStore` permite implementar S3 posteriormente; o provedor S3 remoto ainda nao foi configurado.

## Backup e recuperacao conjunta

Encerre a aplicacao antes de copiar banco e arquivos:

```powershell
npm run stop
npm run backup:full
```

No modo PostgreSQL, `backup:full` utiliza o novo procedimento. O JSON da tela Continuidade continua sendo apenas uma copia operacional parcial; nao substitui esta recuperacao.

O backup usa `pg_dump`, inclui os objetos privados, criptografa banco e arquivos e valida os checksums. Antes de declarar `verified`, restaura em um banco temporario e compara todas as tabelas, imagens e midias referenciadas. O banco temporario e removido ao encerrar o ensaio. Uma falha nao substitui nem remove backups anteriores.

O pacote contem os dados e arquivos, nao o instalador, binarios do PostgreSQL ou codigo da aplicacao. Guarde tambem a release correspondente, a versao do PostgreSQL, a configuracao de infraestrutura e a chave externa. Nesta etapa o destino e local e o acionamento e manual; agendamento e copia externa precisam ser configurados na implantacao.

Para verificar novamente:

```powershell
node --experimental-strip-types scripts/backup-postgres.mjs verify --backup 'D:\NextPortariaData\backups\COPIA'
```

Para recuperar sem sobrescrever a base em uso:

```powershell
node --experimental-strip-types scripts/backup-postgres.mjs restore --backup 'D:\NextPortariaData\backups\COPIA' --database next_portaria_recuperado --media-root 'D:\NextPortariaRecuperado\media'
```

Banco e pasta precisam ser novos. Em outro servidor, prepare primeiro um cluster PostgreSQL 17 e sua configuracao, e forneca `--key` com a chave original. Depois da conferencia, a ativacao exige apontar a configuracao privada para o banco e a pasta recuperados; o comando nao troca a instalacao ativa.

## Limites atuais

O modelo operacional em JSON e a validacao integral de estado foram mantidos nesta migracao para preservar o comportamento. PostgreSQL nao elimina esse custo: medir historicos grandes e dividir as operacoes continua sendo trabalho futuro. O backup conjunto desta etapa tem uma janela de parada, e ainda nao existe configuracao de recuperacao continua por WAL.
