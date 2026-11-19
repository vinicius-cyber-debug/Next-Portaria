# Setores e liberação individual de saída

## Estado da entrega

O portal possui cadastro dos 23 setores informados, vínculo de funcionários, líder e substituto por setor, liberação individual de **15 minutos**, revogação antecipada e histórico. Os vínculos organizacionais não escrevem permissões na central nem bloqueiam funcionários. Não foram inventados responsáveis ou atribuídos setores aos cadastros reais.

A integração física fica desativada por padrão. A homologação física anterior, documentada em [TESTE-SAIDA-INDIVIDUAL.md](TESTE-SAIDA-INDIVIDUAL.md), comprovou entrada preservada, liberação temporária de saída e retorno ao bloqueio usando outro mecanismo de ensaio. Ela **não comprova** o novo modo de autorização online por tentativa, a prioridade da regra manual frente aos grupos herdados ou a recusa em contingência. Esses pontos exigem teste acompanhado antes de habilitar um funcionário real.

## Fluxo no portal

1. **Administração → Setores e líderes**: selecionar o setor, seu líder e um substituto opcional. Ambos precisam de usuário ativo de Operação, Diretoria ou Administração. O perfil deve manter a permissão detalhada de liberar saída.
2. Vincular funcionários importados da central aos setores. “Recepção” e “Recepção de Pescados” são setores diferentes. As áreas físicas de destino continuam em seu cadastro próprio.
3. Um administrador pode solicitar **Preparar controle** para um funcionário, com justificativa. É uma ação física explícita, separada do vínculo de setor. O serviço cria uma regra manual exclusiva desse funcionário, da catraca e do sentido de saída configurados. Não altera grupos, fotos, cadastro ou entrada.
4. Com operador e liberação manual disponíveis, validar entrada, saída pendente e recusa sem comunicação. Conferir também produção/expedição, grupos herdados e os horários em que o controle deve valer. A versão inicial prepara a exigência manual durante todo o horário da regra base; não publica automaticamente o calendário de expediente 07:30–11:00 / 13:30–17:00. Não habilitar em operação até aprovar essa política com a empresa.
5. **Confirmar homologação** registra as três evidências obrigatórias e quem confirmou. O serviço confere a identidade estável e a regra lida da central. Somente então é possível conceder liberações.
6. **Central de Acesso → Liberações de saída**: líder/substituto escolhe um funcionário de seu setor e informa justificativa. Prazo fixo de 15 minutos a partir do relógio do PostgreSQL. O funcionário deve realizar uma nova identificação na saída.
7. O serviço aprova apenas o evento pendente de autorização manual desse funcionário e desse leitor. A confirmação da central é exibida separadamente de uma passagem física: autorização não comprova giro.
8. Líder/substituto do setor ou administrador pode revogar a janela antes do vencimento. Mudança de setor revoga as liberações anteriores. Desativação do responsável, retirada da permissão, bloqueio/inativação do funcionário ou mudança da identidade impedem novos comandos.
9. **Remover controle** desabilita a concessão, revoga janelas e solicita ao serviço a remoção da regra que ele próprio criou. A remoção só é declarada concluída após leitura de confirmação. Não altera regras anteriores ou de outros funcionários.

Portaria pode consultar funcionários e janelas de todos os setores, sem conceder saídas nem receber a auditoria de configuração/integração. Operação/Diretoria só consulta funcionários, janelas e histórico dos setores em que é líder/substituto. Administração configura e supervisiona todos. Financeiro e Consulta não ganham poder de liberar por sobreposição de permissões.

## Expiração, falhas e reinícios

Não é criada uma regra semanal de **liberação temporária**. A janela fica no PostgreSQL; a regra física exige autorização manual. Cada tentativa passa novamente por validade, situação do funcionário, setor, autoridade do emissor e identidade nativa. A decisão é limitada ao evento positivo de autorização pendente, ao equipamento configurado e ao giro de saída. Não há `allow=both`, evento zero ou acionamento genérico de porta.

Sem serviço ou comunicação, novas tentativas não recebem aprovação automática. Isso depende de a catraca realmente recusar no modo offline, motivo da homologação obrigatória. A restauração da conexão não renova o prazo; janelas vencidas permanecem vencidas inclusive depois de oito dias ou reinício. O serviço não sincroniza permissões semanais que possam reaparecer.

O registro de envio é gravado **antes** do comando externo. Se houver queda, timeout ou resposta inconclusiva, ele fica “confirmação pendente” e o mesmo evento nunca é reenviado automaticamente. Uma leitura posterior pode confirmar a autorização. A revogação impede decisões futuras; não desfaz um giro já autorizado. A aplicação mantém pequena margem antes do vencimento para não despachar no limite do prazo.

A sincronização e o modelo/firmware/serial, leitores, áreas, sentido e configuração online da central são conferidos. Cadastro histórico `isCurrentlyOnline` não é utilizado como prova de conexão. Configuração inválida desativa esta integração sem derrubar o restante do portal. A saúde do serviço aparece no painel; ela não substitui a confirmação individual do evento.

## Atualização do servidor

1. Usar uma release revisada e identificada. O empacotador existente só inclui arquivos da tag; alterações locais não entram no ZIP até serem publicadas. Nenhuma publicação ou implantação é efetuada implicitamente por este módulo.
2. Parar somente a aplicação Next Portaria. Fazer o backup completo PostgreSQL + armazenamento privado e verificar a restauração antes de migrar. O instalador existente faz essa verificação e preserva a pasta de dados. Manter a chave separada; o destino externo da empresa continua obrigatório.
3. Aplicar a migração `006_exit_access.sql` pelo migrador do projeto. Ela cria as tabelas e setores sem alterar cadastros existentes. Aplicar novamente os privilégios de aplicação; auditoria e comandos ficam sem UPDATE/DELETE.
4. Copiar `server/exit-access.example.json` para `<DataRoot>\integrations\exit-access.json`, inicialmente com `enabled:false`. Preencher identidade da origem, caminho privado das credenciais/certificado e os identificadores **conferidos no ambiente de destino**. Não copiar caminhos ou números de QA. A conta do serviço precisa ler esses arquivos; proteger com as mesmas ACLs dos dados. Nunca colocar senhas no Git ou em comandos do navegador.
5. Depois do teste controlado, habilitar a conexão no arquivo e reiniciar a aplicação. Isso liga o serviço, mas não prepara/ativa automaticamente todos os funcionários. Cada preparo e confirmação continua sendo uma ação explícita no portal.
6. `server/RUN-SERVER.ps1` lê a configuração de saída da pasta permanente de dados. `scripts/server-process.mjs` inicia e encerra o serviço junto ao processo HTTPS. A tarefa **NextPortaria-App** já definida no instalador executa no início do Windows com conta de serviço, sem login; a integração não cria outra tarefa nem interfere em serviços alheios. Conferir a tarefa, a execução após reinício e a conta no servidor real. Esse servidor ainda precisa receber a atualização.
7. O backup completo inclui setores, vínculos, janelas, tentativas e histórico. Credenciais/certificados de conexão e a configuração da integração são arquivos operacionais separados: preservar e proteger sua cópia em procedimento de recuperação. Restauração JSON parcial é recusada se já houver vínculos/histórico de saída. Em recuperação completa, primeiro isolar a conexão com a central, revisar configuração e janelas, só depois subir uma única instância.

Em desenvolvimento PostgreSQL, usar `PORTO_EXIT_CONFIG` ou `.porto-runtime/exit-access.json`. `npm run exit:worker` acompanha um servidor de desenvolvimento; em produção o processo HTTPS já inicia o serviço internamente. Um bloqueio no banco garante uma única instância ativa. Não usar o terminal de desenvolvimento como supervisão de produção.

Parar/iniciar no servidor continua pelos comandos operacionais existentes da tarefa NextPortaria-App, com parada conjunta para backup. Parar a aplicação interrompe novas aprovações; não equivale a remover o controle físico. Para retirar a exigência individual, usar **Remover controle** e aguardar a confirmação enquanto o serviço e a central estão disponíveis.

## Homologação automatizada

`tests/exit-access.test.mjs` usa PostgreSQL isolado e cobre setores, perfis, origem/sessão, autoridade por setor, substitutos, concorrência/idempotência, prazo do banco, revogação, perda de autoridade, expiração após oito dias, reinício e envio ambíguo sem repetição, imutabilidade e remoção.

`tests/exit-gateway.test.mjs` usa central HTTPS fictícia com certificado fixado. Confere regra manual individual, identidade estável, leitor/sentido, recusa de evento zero/entrada/fora do prazo, confirmação, preservação de regras alheias e ausência de escrita no adaptador de importação.

`npm run test:exit:browser` abre a aplicação compilada em HTTPS com PostgreSQL e central fictícia. Exercita cadastro de responsáveis/vínculo, preparo/homologação, concessão, evento recebido pelo serviço sem navegador executando a integração, substituto/revogação, falta de conexão, restrição de setor e Portaria sem concessão. Valida desktop, tablet, celulares de 390/360 px e acessibilidade automática. Evidências em `.porto-tooling/exit-review`. O CI executa esses testes e guarda as capturas. Testes simulados não substituem a homologação física acompanhada.

## Conferência local em 14/11/2026

- Suíte completa: 306 testes aprovados, nenhum ignorado, incluindo reprodução de vídeo e HTTPS. Os 21 testes específicos do módulo também foram executados após os últimos ajustes.
- Compilação, tipos, lint completo sem avisos e formatação verificados. Fluxo no navegador conferido em sete capturas, sem violações de acessibilidade automática.
- Antes da migração local, backup criptografado verificado por recuperação real: 37 tabelas, 649 arquivos, 650 referências. Relatório privado em `.porto-tooling/exit-local-backup.json`. Essa cópia é local; o destino externo da empresa continua pendente.
- Migração 006 aplicada somente à base local: 23 setores, nenhum vínculo físico criado, inventário das tabelas anteriores preservado. Nenhum responsável real foi escolhido automaticamente.
- Arquivo privado `.porto-runtime/exit-access.json` preparado com `enabled:false`. Identidade, leitores, sentido, sincronismo e conexão da central real conferidos sem enviar regras ou permissões. Relatório privado em `.porto-tooling/exit-readiness.json`.
- Usuário informou que não está disponível para teste físico: a integração permanece desativada. Homologação na catraca, política de horários, publicação identificada e atualização do servidor seguem pendentes. Os dados de teste ficaram apenas em bases e centrais isoladas, removidas após as verificações.
