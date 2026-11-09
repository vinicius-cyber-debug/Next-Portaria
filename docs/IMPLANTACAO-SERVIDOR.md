# Implantação controlada no Windows Server

Este pacote prepara a execução no servidor; sua publicação não instala nem altera o servidor remotamente. A referência desta instalação é Windows Server 2019, IP `192.168.0.2`, HTTPS `8443`, rede `192.168.0.0/24`. Confirme esses dados na inspeção. O destino externo de backup ainda precisa ser definido pela empresa.

Na candidata `0.8.0-rc.1`, Gestão do Porto inclui cobrança por acesso, adiantamentos e saída quitada. Leia [as regras](GESTAO-PORTO.md) e execute o [aceite empresarial](HOMOLOGACAO-PORTO.md). O instalador exige `-Homologacao` para versões `-rc.N`; esse sinalizador não comprova o aceite nem autoriza utilizar a base operacional em testes. As tarefas e o serviço possuem nomes reservados: não tente instalar uma segunda instância paralela na mesma máquina sem planejar esses nomes e a infraestrutura.

## Pré-requisitos

- PowerShell como administrador, Node.js 22.13+ e binários completos PostgreSQL 17 (bin/lib/share), em pastas permanentes. O pacote usa o PostgreSQL indicado sem reinstalar nem alterar serviços de terceiros.
- Certificado PEM válido cobrindo o IP por SAN e chave correspondente. Para cadeia corporativa, forneça a cadeia completa. Certificados internos devem ser distribuídos como confiáveis aos computadores e celulares pela TI; um alerta ignorado no navegador não comprova câmera/QR ou HTTPS confiável.
- Compartilhamento UNC em outra máquina para os backups e outra pasta restrita para a chave de recuperação. Não use o próprio servidor ou seu disco como destino externo.
- A tarefa de backup usa SYSTEM. Em domínio, libere na outra máquina a conta do computador, por exemplo `DOMINIO\SERVPESCA$`, e valide acesso à pasta de chave. Em grupo de trabalho/NAS sem essa autenticação, a TI deve preparar uma identidade adequada antes da ativação; o pacote falha na verificação de acesso em vez de declarar proteção externa inexistente.
- Todos os processos da instalação anterior encerrados para backup/importação. O instalador recusa portas ocupadas e tarefas/regras homônimas não reconhecidas. Não encerra processos de terceiros.

Use o ZIP da release e confira seu SHA-256. Ele contém somente arquivos versionados, manifesto com commit e hashes, scripts e documentação; não contém senhas, banco, mídia privada, node_modules ou certificados. As dependências são instaladas pelo lockfile e compiladas no servidor.

## Inspeção e comando

Extraia o pacote em `C:\NextPortaria-Pacote`. No terminal do servidor:

```powershell
cd C:\NextPortaria-Pacote
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server\VERIFICAR-SERVIDOR.ps1

$parametros = @{
  ExternalBackupPath = '\\OUTRA-MAQUINA\Backups\NextPortaria'
  RecoveryKeyDirectory = '\\OUTRA-MAQUINA\ChavesRestritas\NextPortaria'
  NodePath = 'C:\NextPortaria-Instalacao\tools\node-v22.23.4-win-x64\node.exe'
  PostgresBin = 'C:\Ferramentas\PostgreSQL17\pgsql\bin'
  CertificatePath = 'C:\NextPortaria-Instalacao\tls\certificate.pem'
  PrivateKeyPath = 'C:\NextPortaria-Instalacao\tls\private.key'
}
.\server\INSTALAR-SERVIDOR.ps1 @parametros -PreflightOnly
```

**Substitua os exemplos de compartilhamento e confirme os nomes reais dos PEM. Não existe destino padrão.** O preflight confere sistema, ferramentas, portas, instalação anterior, compartilhamentos, certificado e integridade do pacote. As sondagens de escrita criam e removem apenas um arquivo de teste em cada compartilhamento.

Se houver banco legado, acrescente antes da instalação os caminhos reais encontrados na inspeção:

```powershell
$parametros.LegacySqlite = 'C:\NextPortaria-Instalacao\app\.wrangler\state\v3\d1\miniflare-D1DatabaseObject\ARQUIVO-REAL.sqlite'
$parametros.LegacyStateRoot = 'C:\NextPortaria-Instalacao\app\.wrangler\state'
```

Execute a instalação no mesmo terminal interativo:

```powershell
.\server\INSTALAR-SERVIDOR.ps1 @parametros
```

Para a candidata de homologação, acrescente explicitamente `-Homologacao -EnablePorto` ao comando na instalação selecionada. `EnablePorto` grava `portoEnabled` no `current.json`; a tarefa `RUN-SERVER.ps1` carrega essa opção no ambiente sem depender do PowerShell ou do login. O padrão permanece desativado, e uma atualização preserva a habilitação anterior. Para desativar, pare a tarefa, altere somente `portoEnabled` para `false` no arquivo de controle e reinicie a tarefa. Nenhum dado do módulo é apagado.

O administrador existente é preservado. Se não houver administrador, informe a senha diretamente no terminal, sem chat, argumentos ou arquivo. Em uma execução pelo Codex sem terminal interativo, o provisionamento falha e a ativação é interrompida; abra um terminal interativo para concluir. Uma falha deixa os diretórios e dados preparados para diagnóstico, sem apagá-los. Não repita a instalação sobre a mesma release nem reinicialize o cluster: investigue o ponto da falha e continue a preparação existente.

## O que o instalador configura

- Release identificada em `C:\NextPortaria-Instalacao\releases\VERSAO-COMMIT`, com dependências, testes, tipos e compilação.
- Dados permanentes em `C:\NextPortaria-Dados`: PostgreSQL, mídia, chave, logs e backups locais. A cópia legada permanece preservada.
- Antes de importar SQLite: backup completo criptografado com restauração verificada, na outra máquina, e chave exportada separadamente. Antes de atualizar PostgreSQL: backup conjunto verificado e cópia externa conferida, antes das migrações.
- Cluster próprio em loopback `127.0.0.1:55432`, serviço automático `NextPortaria-Postgres` como NetworkService. Aplicação com papel PostgreSQL restrito; credencial administrativa fica fora do acesso da aplicação.
- Tarefa de boot `NextPortaria-App` como LocalService, sem login e com reinício após falha. Front-end compilado em loopback `5180`; gateway HTTPS no IP/porta informados, valida host e restringe a sub-rede. A API usa a URL HTTPS real e não confia em cabeçalhos enviados pelo cliente para habilitar HTTP.
- Regra própria `NextPortaria-HTTPS` apenas para o IP/porta, sub-rede e perfis Domain/Private. PostgreSQL não é exposto na rede.
- `NextPortaria-Backup` às 02h: pausa a aplicação, cria backup criptografado, restaura para verificar, copia ao compartilhamento e testa novamente a recuperação da cópia externa. Depois retoma a aplicação. `last-backup.json` registra a última verificação. A primeira execução real como SYSTEM precisa passar antes da ativação.
- `NextPortaria-Retencao` às 01h. Ambas as rotinas possuem bloqueio contra manutenção simultânea. Sem política definida, os arquivos completos são conservados.

## Operação e atualização

```powershell
Start-ScheduledTask -TaskName NextPortaria-App
Stop-ScheduledTask -TaskName NextPortaria-App
Get-ScheduledTask -TaskName 'NextPortaria-*' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName NextPortaria-App
Start-ScheduledTask -TaskName NextPortaria-Backup
Get-Content C:\NextPortaria-Instalacao\last-backup.json
Get-Service NextPortaria-Postgres
```

Não pare o PostgreSQL para parar apenas a interface. Endereço esperado após implantação e validação: `https://192.168.0.2:8443`. Logs em `C:\NextPortaria-Dados\logs`. `current.json` identifica a release ativa; desenvolver e publicar no GitHub não altera esse ponteiro automaticamente.

Para atualizar, escolha uma tag estável, baixe seu pacote, pause a aplicação e execute o instalador com as mesmas pastas e destino externo. Ele prepara uma nova pasta e preserva a anterior. Migrações têm checksum e são aditivas. Não faça `git pull` no código ativo. Voltar somente o ponteiro exige compatibilidade do esquema; não restaure um backup antigo automaticamente após já receber novas movimentações.

A recuperação completa é documentada em [PostgreSQL](POSTGRESQL.md); exige banco e pasta novos. Guarde a release correspondente e a chave fora do pacote criptografado. O instalador não apaga backups antigos nem define sozinho a política de retenção deles.

## Aceite no servidor

O pacote testa HTTPS/API no próprio servidor, mas o aceite final ainda exige: acesso de outro computador na sub-rede; certificado confiável no celular; câmera QR; upload/reprodução no aparelho real; reinício do Windows com aplicação acessível **antes de qualquer login**; resultado do backup externo e recuperação. Esses ensaios não foram executados remotamente por este chat.
