# Operação local — Next Portaria

A instalação usa o computador como servidor local. O banco, as contas e os arquivos ficam persistidos em `.wrangler/state`; outros computadores e celulares precisam alcançar esse servidor para operar.

## Preparar e atualizar no Windows

Instale Node.js 22.13 ou superior com npm. Encerre instâncias antigas de desenvolvimento antes de atualizar. No PowerShell, dentro da pasta do projeto:

```powershell
.\ATUALIZAR-PORTO-LOCAL.cmd
```

O atualizador encerra o supervisor, cria um backup completo quando existe armazenamento operacional, instala dependências ausentes, executa testes e TypeScript, compila, aplica migrações locais pendentes e inicia a compilação pronta. O procedimento preserva dados existentes e interrompe a execução diante de esquema parcialmente migrado.

Na primeira instalação, `scripts/create-local-admin.mjs` solicita nome, usuário, e-mail e senha do primeiro administrador em um terminal interativo. Não existe senha padrão. Se o provisionamento já foi realizado, entre com a conta existente. O script confere usuário, credencial e auditoria antes de declarar sucesso; preserve a mensagem de erro se essa etapa falhar.

## Abrir, consultar e parar

Para o uso diário:

```powershell
.\INICIAR-PORTO-LOCAL.cmd
```

A abertura inicia o Worker compilado em segundo plano e abre `http://127.0.0.1:5173`. Não repete instalação, testes, compilação ou migrações. Repetir o comando reutiliza o supervisor existente.

```powershell
npm run status
npm run stop
npm run start
npm run backup:full
```

O supervisor evita duas instâncias e reinicia o processo após falhas, com espera progressiva de até 60 segundos. O status fica em `.porto-runtime/status.json`, os eventos em `.porto-runtime/logs/` e o resultado do backup em `.porto-runtime/backup-status.json`. Um conflito de porta é informado sem encerrar processos desconhecidos.

## Iniciar após entrar no Windows

Instale o atalho para a conta atual:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-startup.ps1
```

O atalho usa um iniciador oculto em `.porto-runtime/launch.vbs`. A aplicação começa depois que essa conta entra no Windows. O mecanismo não oferece um serviço disponível antes do login. Se a pasta do projeto ou o caminho do Node mudar, reinstale o atalho.

Para remover a inicialização automática:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local-startup.ps1 -Remove
```

A remoção afeta o atalho; `npm run stop` encerra a execução atual.

## Contas e autenticação

Após entrar como administrador, use **Administração → Usuários** para cadastrar cada operador com usuário, senha inicial e perfil individual. A senha deve ter de 12 a 128 caracteres. Contas novas e senhas redefinidas exigem uma troca pessoal antes de liberar a operação.

A página **Minha senha** exige a senha atual e uma nova senha diferente. A troca encerra as sessões anteriores e mantém uma nova sessão para o acesso atual. Um administrador pode redefinir senhas esquecidas pela lista de usuários; não há recuperação automática por e-mail. Contas desativadas perdem o acesso.

As senhas são derivadas com PBKDF2-SHA256 e salt aleatório. A sessão dura oito horas, utiliza cookie HttpOnly/SameSite=Lax e recebe o atributo Secure em HTTPS. O banco conserva somente o hash do token de sessão. Cinco senhas incorretas bloqueiam temporariamente a conta por quinze minutos. Permissões, origem da solicitação e identidade são verificadas no servidor.

## Rede e HTTPS

No servidor, utilize `http://127.0.0.1:5173`. O supervisor escuta em `0.0.0.0:5173`; esse é o endereço de escuta, não um endereço para digitar no navegador. Em outro dispositivo, utilize o nome ou IP atual do computador servidor.

Por padrão, a API exige HTTPS fora de loopback. Para um ensaio local com certificado e chave PEM próprios, guardados fora do repositório:

```powershell
$env:PORTO_TLS_CERT_PATH = 'C:\certificados\porto-cert.pem'
$env:PORTO_TLS_KEY_PATH = 'C:\certificados\porto-key.pem'
$env:PORTO_BIND_HOST = '127.0.0.1'
$env:PORTO_PUBLIC_HOST = 'localhost'
$env:PORTO_PORT = '8443'
npm run start:secure
```

Encerre o supervisor antes de usar a mesma persistência com esse comando. O certificado deve incluir o nome ou IP acessado e ter cadeia confiável nos dispositivos clientes. O script verifica certificado, chave, validade e endereço, mas não configura a confiança do Windows. Para um endereço de rede, ajuste os hosts e o certificado de acordo com a instalação.

O arquivo opcional `.dev.vars`, ignorado pelo Git, pode conter `PORTO_ALLOW_HTTP_LAN="true"` para permitir HTTP temporário somente nos intervalos IPv4 privados `10.x.x.x`, `172.16.x.x` a `172.31.x.x` e `192.168.x.x`. O supervisor carrega esse arquivo quando ele existe. Login, sessão e permissões continuam obrigatórios. Para encerrar a exceção, configure a opção como `false` ou remova-a e reinicie a aplicação.

A câmera de QR pelo celular depende de HTTPS e da permissão do navegador. Em HTTP, use digitação, colagem ou leitor USB que funcione como teclado. O acesso externo ao computador exige infraestrutura de rede, certificado e disponibilidade definidos para a instalação.

## Backup completo e recuperação

O backup JSON da tela Continuidade é um recurso operacional separado. O backup completo inclui bancos locais SQLite/D1, usuários, hashes de senha, permissões, sessões, auditoria, configuração, objetos R2, anexos, `.dev.vars` quando presente, compilação, migrações, código e manifestos de dependências. Não inclui `node_modules`, estado auxiliar das ferramentas nem a chave de recuperação dentro da própria cópia.

O supervisor cria uma cópia ao iniciar quando ainda não há backup validado e depois a cada 24 horas, mesmo sem navegador aberto. Durante a cópia, encerra o Worker para manter banco e objetos no mesmo ponto e o reinicia ao terminar. Falhas permitem nova tentativa após uma hora. As cópias antigas não são excluídas automaticamente.

O destino padrão é `.porto-backups/`. Para usar outro disco ou uma pasta privada, defina `PORTO_BACKUP_DIRECTORY` no ambiente da conta Windows e reinicie o supervisor. O destino precisa estar acessível sem interação. Mantenha uma cópia externa: um backup no mesmo disco não protege contra a perda desse disco.

Os arquivos e o manifesto são compactados e criptografados com AES-256-GCM. A chave de 256 bits fica em `.porto-runtime/recovery.key`. As pastas privadas recebem acesso limitado à conta atual e ao SYSTEM no Windows. Guarde uma cópia segura da chave fora do computador, separada dos backups. A chave original é necessária para recuperar cada cópia; ela não é a senha de um usuário.

Antes de indicar `verified`, a rotina restaura a cópia em uma pasta isolada, verifica SHA-256 dos arquivos, executa `integrity_check` nos SQLite, compara conteúdo e quantidade das tabelas e verifica objetos R2 e anexos referenciados. A verificação técnica deve ser complementada por um ensaio de uso após mudanças de infraestrutura.

Criar uma cópia manual com todos os servidores já encerrados:

```powershell
node scripts/full-backup.mjs create --offline
```

Verificar uma cópia existente sem alterar os dados operacionais:

```powershell
node scripts/full-backup.mjs verify --backup "D:\Backups\next-portaria-copia" --key "E:\Cofre\recovery.key"
```

Restaurar em uma pasta nova, sem sobrescrever a instalação atual:

```powershell
node scripts/full-backup.mjs restore --backup "D:\Backups\next-portaria-copia" --key "E:\Cofre\recovery.key" --destination "C:\Next-Portaria-Recuperado"
```

A pasta recuperada contém `.wrangler/state`, configuração local e compilação. Instale Node compatível e execute `npm ci` nessa pasta para reinstalar as dependências da mesma versão. Em seguida, inicie com `npm run start`.

Para ensaiar a restauração no mesmo computador, use a pasta recuperada separada e defina `$env:PORTO_PORT = '5187'` nessa sessão antes de iniciar. Acesse `http://127.0.0.1:5187` e encerre o ensaio ao terminar. Duas instâncias não devem compartilhar o mesmo armazenamento.

Se quiser manter a chave original para backups futuros da máquina recuperada, copie-a com acesso privado para `.porto-runtime/recovery.key` antes da primeira rotina. Caso contrário, o supervisor gera uma nova chave para cópias futuras; os backups antigos continuam exigindo a chave anterior. Reinstale o atalho de inicialização e confira login, perfis, histórico e abertura de um anexo antes de substituir a instalação operacional.

## Diretórios locais

| Caminho | Finalidade |
| --- | --- |
| `.wrangler/state` | Bancos e objetos operacionais persistentes. |
| `.porto-runtime` | Controle do supervisor, logs, status e chave de recuperação. |
| `.porto-backups` | Backups completos criptografados, no destino padrão. |
| `.porto-tooling` | Diretórios auxiliares de Wrangler e Miniflare, preparados por `scripts/runtime-env.mjs`. |
| `.dev.vars` | Configuração opcional e segredos locais. |

Esses caminhos ficam fora do versionamento. Preserve o armazenamento, as chaves e as cópias de recuperação durante atualizações. Mantenha qualquer restauração em diretório próprio.

## Problemas comuns

- **Comando não reconhecido:** no PowerShell, use o prefixo `.\` para os inicializadores.
- **Compilação ausente:** execute `ATUALIZAR-PORTO-LOCAL.cmd`; a abertura diária utiliza a compilação existente.
- **Dependência ou binário ausente:** com a aplicação encerrada, execute `npm ci` e o atualizador. A instalação exige acesso ao registro de pacotes.
- **Porta ocupada:** consulte `npm run status` e encerre a instância anterior conhecida.
- **Esquema parcial ou falha no primeiro administrador:** preserve a base, o backup e a mensagem de erro para conferência; uma exclusão do banco não é um procedimento de reparo.
- **Troca de senha pendente:** conclua a definição da senha pessoal para liberar a operação.
- **Dados ausentes:** confirme a pasta utilizada e a presença de `.wrangler/state` antes de iniciar outra instalação.
- **Backup com falha:** confira espaço, permissões, destino, chave e anexos; uma rotina com status de falha não equivale a um backup verificado.

O [README](../README.md) apresenta as funcionalidades e a [arquitetura](ARQUITETURA.md) detalha os módulos técnicos.
