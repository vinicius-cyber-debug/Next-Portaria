# Continuação pelo Codex no servidor

Use este texto no Codex aberto **no servidor**, após o aceite da homologação e a definição de backup externo. A candidata não deve substituir automaticamente uma instalação operacional. Não informe senhas no chat.

```text
Prepare a atualização do Next Portaria para v0.8.0-rc.1, candidata de Gestão do Porto por acesso. Não confunda esta versão com uma release estável já homologada.

1. Inspecione Windows, Node, PostgreSQL, current.json, portas, tarefas NextPortaria-*, certificado e instalação ativa. Preserve bancos, arquivos, usuários e chaves. Não encerre processos de terceiros e não execute git pull sobre o código ativo.
2. Leia docs/GESTAO-PORTO.md, docs/HOMOLOGACAO-PORTO.md e docs/IMPLANTACAO-SERVIDOR.md do pacote identificado. Confira a tag, o commit, o SHA-256 do ZIP e o manifesto interno. Não copie configuração privada para o GitHub ou chat.
3. Confirme com a empresa a instalação de homologação e a janela de trabalho. As tarefas e o serviço possuem nomes reservados; não instale outra instância paralela na mesma máquina sem planejar a infraestrutura.
4. Identifique destino UNC em OUTRA máquina para o backup e pasta separada/restrita para a chave. Eles ainda não foram definidos nesta preparação. Não invente caminhos nem use o próprio servidor como destino externo. Se faltarem, faça a inspeção e pare antes de migrar ou substituir a instalação ativa.
5. Prepare o comando concreto do instalador com os caminhos reais encontrados. A referência de rede é 192.168.0.2:8443 e sub-rede 192.168.0.0/24; confira no servidor. Certificado precisa cobrir o endereço e ser confiável nos clientes. A candidata exige -Homologacao; -EnablePorto persiste a habilitação para execução sem login.
6. Em janela autorizada, pare somente a aplicação reconhecida. Produza backup completo criptografado com recuperação verificada ANTES de aplicar as migrações 004 e 005. Use o instalador do pacote e preserve a pasta de dados. Uma falha de backup, integridade, migração, compilação ou permissões deve interromper a ativação.
7. Valide login preservado, empresa pagadora, tarifas por acesso, solicitação/aprovação/entrada, adiantamento parcial, bloqueio de saída, quitação, saída com cobrança única, recibo, ajustes autorizados, relatórios e caixa. Não publique automaticamente valores na base operacional. A tabela da foto pode preencher um rascunho para conferência e publicação pelo administrador.
8. Teste backup e recuperação da cópia externa sob a identidade real da tarefa. Valide HTTPS, firewall restrito e aplicação/PostgreSQL após reiniciar, sem usuário conectado e sem PowerShell aberto. Não simule o reinício nem o aceite empresarial.
9. Registre endereço, versão/commit, pastas, tarefas/serviço, estado do backup, resultado do roteiro de homologação e pendências. Não declare produção liberada enquanto o aceite não estiver completo.
```

O pacote instala dependências do lockfile e compila no servidor. Não contém banco, mídia privada, certificados, chaves, senhas ou `node_modules`. A documentação inclui os comandos de iniciar/parar e o procedimento de recuperação em banco/pasta novos.
