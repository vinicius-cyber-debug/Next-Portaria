# Next Portaria

Sistema de portaria e controle de acesso com React, Vinext, Cloudflare D1 (SQLite) e R2 privado. A interface mantém a identificação **Porto Gestão**. O acesso utiliza usuário e senha, com contas, permissões e sessões persistidas no banco.

## Funcionalidades

- Dashboard e Central de Acesso com pessoas presentes, visitas previstas, solicitações pendentes e permanências excedidas.
- Cadastro de pessoas, veículos e empresas; autorização de visitas por responsável e substituto; conferência de identidade em cada entrada.
- Entrada e saída de veículos, motoristas e acompanhantes, com movimentações independentes da presença de pessoas.
- Requisitos de segurança por pessoa e setor, validade, áreas restritas e bloqueio de novas entradas quando necessário.
- Portaria rápida e crachás com QR Code, validados no servidor.
- Conferência física de emergência, com registro de divergências.
- Ocorrências, anexos privados, acompanhamento e passagem de turno com ciência individual.
- Notificações internas, relatórios, CSV, impressão, auditoria e administração de usuários e permissões.
- Backup JSON operacional e backup completo criptografado da instalação local.

## Instalação e uso no Windows

Instale Node.js 22.13 ou superior com npm. Na pasta do projeto, execute no PowerShell:

```powershell
.\ATUALIZAR-PORTO-LOCAL.cmd
```

O atualizador instala dependências ausentes, coordena o backup de uma instalação existente, executa verificações, compila, aplica migrações locais e solicita o primeiro administrador quando necessário. Não existe senha padrão. Após entrar, cadastre os demais operadores em **Administração → Usuários**.

No uso diário:

```powershell
.\INICIAR-PORTO-LOCAL.cmd
```

O inicializador abre a compilação pronta em segundo plano e acessa `http://127.0.0.1:5173`. O computador servidor precisa permanecer ligado para atender os dispositivos da rede. Contas novas ou com senha redefinida exigem troca de senha antes de operar.

Consulte o [guia de operação local](docs/OPERACAO-LOCAL.md) para início automático no Windows, contas, HTTPS, backup e recuperação.

## Desenvolvimento

```powershell
npm ci
npm test
npm run check
npm run build
node scripts/setup-local.mjs
node scripts/create-local-admin.mjs
npm run dev -- --hostname 127.0.0.1
```

As migrações e o provisionamento utilizam somente o D1 local. A aplicação começa sem dados operacionais. O administrador configura setores, portarias, pessoas e parâmetros da unidade. Em uma instalação já utilizada, prefira o atualizador do Windows, que coordena a parada e o backup antes da compilação.

```powershell
npm run status
npm run stop
npm run start
npm run backup:full
```

Desenvolvimento e supervisor devem usar armazenamentos separados quando executados ao mesmo tempo. `npm run lint` executa a análise estática do código.

## Dados e recuperação

O banco e os objetos locais ficam em `.wrangler/state`. O supervisor usa `.porto-runtime` para status, logs e chave de recuperação; os backups completos ficam por padrão em `.porto-backups`. As ferramentas usam `.porto-tooling`, preparado por `scripts/runtime-env.mjs`. Dados, chaves, variáveis locais e diretórios de execução ficam fora do versionamento.

O backup JSON operacional não inclui contas, credenciais, permissões, auditoria histórica ou arquivos físicos dos anexos. O backup completo inclui a instalação, bancos e objetos, é criptografado e verifica uma restauração isolada. Guarde cópias externas e mantenha a chave de recuperação separada dos backups.

A base conserva compatibilidade com registros de versões anteriores. Recursos de embarcações e financeiro estão desativados na interface e na API; restaurar um backup não reativa esses módulos. As migrações D1 permanecem em `drizzle/` para preservar a integridade de instalações existentes.

## Arquitetura e limites

A [documentação de arquitetura](docs/ARQUITETURA.md) apresenta os módulos e suas responsabilidades. A aplicação atende uma unidade com múltiplas portarias. O estado operacional reúne os últimos 30 dias e registros abertos; o histórico anterior é consultado por páginas. As gravações exigem conexão e ainda validam o estado integral no servidor, portanto volumes maiores exigem medição de desempenho.

Anexos PNG, JPEG, WebP ou PDF de até 5 MiB ficam no R2 privado. A câmera de QR pelo celular exige HTTPS. As notificações são internas, sem envio por e-mail ou WhatsApp. Antes do uso oficial, valide perfis, rotina dos turnos e recuperação dos backups com a equipe responsável.
