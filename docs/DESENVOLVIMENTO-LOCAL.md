# Desenvolvimento com banco local

Com `.porto-runtime/postgres.json` configurado, este ambiente usa PostgreSQL e armazenamento privado permanentes, conforme [POSTGRESQL.md](POSTGRESQL.md). O administrador migrado mantem a senha anterior. Sem essa configuracao, permanece o modo D1/SQLite local descrito abaixo. Nenhum desses ambientes compartilha automaticamente o banco de producao.

## Preparar

Com Node e npm disponiveis, execute `CONFIGURAR-DESENVOLVIMENTO.cmd`. Ele compila o aplicativo e aplica somente as migracoes locais pendentes. Repetir a preparacao preserva os registros existentes. Pare o ambiente de desenvolvimento antes de preparar novamente; em bases utilizadas, faca backup antes de atualizar.

Para incluir cadastros e movimentos ficticios em uma base vazia:

```powershell
npm run demo:local
```

A carga e explicita e recusa uma base que ja possui operacoes. Nao apague o banco para repetir essa carga. As visitas possuem horarios relativos ao instante da carga; as autorizacoes podem vencer durante os testes.

## Criar a conta

Com o desenvolvimento e os demais processos desta base encerrados, execute `CRIAR-ADMIN-LOCAL.cmd` em um terminal interativo. Defina nome, usuario, e-mail e senha diretamente no terminal. Nao existe senha padrao e a carga ficticia nao cria contas. Se o administrador ja foi criado, utilize a conta existente. O primeiro acesso pode solicitar a troca pessoal de senha. Se ocorrer `SQLITE_BUSY` na conferencia final, encerre os processos e repita o comando: uma conta ja gravada nao sera duplicada.

## Desenvolver

Execute `INICIAR-DESENVOLVIMENTO.cmd`, ou `npm run dev:local`. Abra `http://127.0.0.1:5180`. O servidor de desenvolvimento escuta apenas no loopback desta maquina e recarrega o codigo durante o desenvolvimento. O terminal deve continuar aberto; `Ctrl+C` encerra o ambiente.

Esta execucao utiliza a API, autenticacao e banco reais do ambiente local. A demonstracao `npm run dev:demo` continua separada: usa memoria da aba e nao testa persistencia.

## Onde os dados ficam

- `.wrangler/state`: SQLite/D1 e objetos R2 desta copia do projeto; permanece apos fechar o navegador ou reiniciar o desenvolvimento.
- `.porto-runtime`: estado privado e chave dos backups completos, quando criados.
- `.porto-backups`: copias criptografadas, no destino padrao.

Essas pastas e as configuracoes privadas sao ignoradas pelo Git. Mantenha esta copia em uma pasta permanente. Atualizar o codigo no GitHub nao envia os cadastros ficticios ao servidor, e o banco do servidor nao e compartilhado com este computador.

Os comandos de preparacao e desenvolvimento usam o mesmo caminho `.wrangler/state`. Nao execute simultaneamente o supervisor de operacao e o servidor de desenvolvimento sobre essa mesma base.

## Verificacoes e backup

```powershell
npm run check
npm test
```

Para fazer uma copia completa, encerre o desenvolvimento e outros processos que utilizem esta base. Depois execute:

```powershell
$env:PORTO_PORT = '5180'
node scripts/full-backup.mjs create --offline
```

Guarde tambem a chave de recuperacao conforme [OPERACAO-LOCAL.md](OPERACAO-LOCAL.md). Uma pasta de dados ignorada pelo Git precisa de backup proprio.
