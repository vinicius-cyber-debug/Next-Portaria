# Atualização de conexão, processo e credenciais

Revisão de 19/11/2026. Estas alterações não ativam permissões nas catracas e não substituem a homologação do servidor.

## Conexão permanente com a central

No servidor, a conexão de leitura fica em `<DataRoot>/integrations/idsecure.json`. O runner, os comandos de importação e o atualizador interativo usam esse destino. O desenvolvimento local continua usando `.porto-runtime/idsecure.json`; ambientes com banco e mídia explícitos precisam fornecer sua própria conexão e não herdam a instalação local.

O instalador preserva a configuração existente na pasta de dados. Quando só existe a conexão de uma release anterior, copia a configuração e o certificado fixado por fingerprint para a pasta permanente, sem acessar a central. Certificados são nomeados pelo conteúdo. Não substitui a confiança por outro certificado nem sobrescreve credenciais permanentes com uma cópia antiga.

A conexão da integração de saída só é redirecionada após conferir origem e identidade da central. Uma configuração física importada da release permanece desativada; uma configuração permanente conserva sua escolha explícita. Arquivos inválidos, origens divergentes e conflitos interrompem a preparação.

## Identificação da aplicação

O registro do processo passa a conferir executável, comando, pasta da aplicação e identidade de criação do processo. Um PID reaproveitado por outro programa não é tratado como a instância registrada. A parada usa a mesma conferência para preservar processos alheios. Identidade indisponível ou ambígua impede uma ação destrutiva.

Cada instância possui identificador próprio; a limpeza de um processo antigo não pode apagar o registro de seu substituto. O teste de inicialização do servidor após reiniciar o Windows continua sendo um aceite operacional separado.

Um bloqueio de recuperação `.lock.recovery` abandonado é tratado como estado ambíguo e exige conferência do operador. O sistema não remove esse bloqueio automaticamente nem encerra um processo cuja identidade não conseguiu confirmar. O registro da instância é adquirido antes de iniciar o serviço de integração.

## Proteção das senhas

Novas credenciais usam PBKDF2-SHA256 com 600 mil iterações. As contas existentes com 310 mil continuam aceitas. Após um login correto e autorizado, o hash legado é atualizado na mesma transação que cria a sessão.

Esse processo preserva a senha escolhida, sua data de alteração, a exigência de troca quando aplicável e as sessões existentes. O mínimo continua sendo oito caracteres. Senha incorreta não provoca migração. Reset, bloqueio ou alteração concorrente da conta impedem que uma verificação antiga sobrescreva o novo estado. Uma disputa entre dois logins pode exigir repetir o login, sem repetição automática de comandos.

Não existe conversão em lote que precise conhecer as senhas. Os parâmetros armazenados são validados antes da derivação; custos não suportados são recusados.

## Aplicação e retorno de versão

1. Fazer e verificar o backup antes de atualizar. Configurações e certificados também precisam de cópia protegida, além do banco e da mídia.
2. Instalar a release identificada pelo procedimento do servidor. A preservação de conexão é offline e mantém os arquivos anteriores.
3. Validar inicialização, acesso HTTPS e leitura da central. Não enviar senhas em argumentos, logs ou chat.
4. Conferir login de uma conta existente, troca/reset de senha e acompanhamento das integrações. Validar reinício sem login em uma janela de homologação do servidor.

**Retorno de versão:** depois que uma conta receber o hash de 600 mil iterações, uma release antiga que aceite somente 310 mil não conseguirá autenticá-la. Um rollback precisa usar código que leia ambos os custos. Não basta alterar o número de iterações no banco, e não se deve restaurar uma cópia antiga sobre movimentações novas para contornar essa incompatibilidade.

O destino externo de backup, a credencial válida da central e a homologação física continuam dependendo da configuração e dos testes do ambiente de destino.

## Evidência desta revisão

Em 19/11/2026, a suíte completa terminou com 359 testes aprovados, sem falhas ou casos ignorados, incluindo PostgreSQL isolado, HTTPS e vídeo. Tipagem, lint completo, formatação e compilações nativa e Cloudflare passaram. A derivação de senha foi conferida também no runtime workerd, com os dois custos suportados.

Antes da atualização local, o backup de banco e mídia foi recuperado em ambiente isolado e verificado: 45 tabelas, 649 arquivos e 650 referências. Essa cópia permanece no mesmo computador; ainda não comprova proteção externa. A aplicação atualizada iniciou e respondeu por HTTPS com o certificado validado. Não houve ativação de permissões físicas nem teste de reinício do servidor sem login.
