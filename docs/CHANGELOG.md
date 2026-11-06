# Notas das versões

## 0.7.0 — mídias privadas e pacote de servidor

- Fotos e vídeos em ocorrências com partes de 5 MiB, SHA-256, pausa e retomada após recarga.
- Player privado com intervalos HTTP; limites de tamanho, pendências, arquivos por ocorrência e armazenamento.
- Retenção configurável por administrador, desativada inicialmente, com auditoria e limpeza repetível.
- Pacote gerado de tag Git com commit e manifesto SHA-256, sem dados nem credenciais.
- Scripts Windows Server para PostgreSQL automático, aplicação LocalService sem login, HTTPS restrito à sub-rede, backup externo e recuperação verificada antes da ativação.
- Ensaios no navegador incluem envio interrompido, retomada, reprodução na aplicação compilada e gateway HTTPS. Implantação real, confiança do certificado nos clientes e destino externo dependem do ambiente da empresa.

## 0.6.0 — PostgreSQL e desenvolvimento nativo

- Execução nativa Node.js com PostgreSQL 17 e portas de persistência e armazenamento.
- Migrações versionadas com checksum, importação SQLite em transação e comparação de todas as linhas.
- Preservação de contas, hashes de senha, sessões e auditoria da base local existente.
- Arquivos privados fora da pasta do código; estrutura de metadados e vínculos para mídias.
- Gravação de arquivos por fluxo com limite e SHA-256; a interface antiga mantém seu limite de 5 MiB.
- Backup criptografado conjunto com restauração e conferência em banco separado.
- Comandos de manutenção reconhecem o provedor configurado e preservam a alternativa D1.
- Correção de carregamento RSC e hidratação; HMR no navegador preserva estado React. CI Linux, Windows e PostgreSQL aprovado na publicação.

Esta preparação ainda não inclui interface de upload de vídeo, armazenamento S3 remoto, transcodificação, agendamento de backup, HTTPS ou serviço Node no servidor da empresa.

## v0.5.0

Versão de portaria e controle de acesso com operação local no Windows.

- Cadastro de pessoas, veículos e empresas; solicitação e autorização de visitas por responsável e substituto.
- Registro de entradas e saídas, crachás com QR Code, requisitos de segurança e controle de áreas restritas.
- Dashboard, consulta de presentes, interface para celular e conferência física de emergência.
- Ocorrências com anexos, passagem de turno, notificações internas, relatórios e auditoria.
- Contas individuais, perfis, permissões e troca de senha pessoal.
- Histórico paginado e sincronização de alterações por revisão.
- Inicialização local em segundo plano e backup completo criptografado, com verificação por restauração isolada.

A instalação persistente exige provisionamento do primeiro administrador. Consulte o [guia de operação local](OPERACAO-LOCAL.md) para instalação, atualização e recuperação.
