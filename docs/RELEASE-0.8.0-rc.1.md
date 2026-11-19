# v0.8.0-rc.1 — Gestão do Porto por acesso

Versão candidata para homologação. Não substitui o aceite empresarial nem comprova instalação no servidor.

## Comportamento

A tabela física da Frigopesca foi confirmada como preço por acesso. Novos acessos têm valor único, sem acréscimo à meia-noite. Registros anteriores por diária conservam a modalidade e a tarifa contratada. O administrador pode preencher um rascunho com os dez valores terrestres da foto e publicar uma versão após conferência; migrações não cadastram preços automaticamente.

O financeiro identifica a empresa pagadora e recebe adiantamentos antes da saída. A portaria só registra saída com saldo zero; encerramento e cobrança definitiva são atômicos. Há recebimentos parciais, recibos internos para impressão, descontos/isenções autorizados, estornos compensatórios, indicadores por período/categoria/empresa, CSV e fechamento imutável de lotes de caixa. Recebimentos e fechamento são de Financeiro/Administrador; ajustes são de Diretoria/Administrador, com justificativa.

Esta candidata também contém a fundação do Porto, o refinamento visual das telas operacionais, as correções de estabilidade PostgreSQL e a preparação isolada de integração Control iD. Não inclui comunicação de escrita com equipamento real.

## Validação local

- Suíte geral: 229 testes aprovados e dois cenários reservados para execução separada em navegador.
- Fluxo do Porto em HTTPS: 27 capturas, seis larguras, sem erros de navegador, overflow ou violações automáticas WCAG; recibo impresso sem a aplicação ao fundo.
- Cobertura financeira em PostgreSQL real: adiantamentos, concorrência, saída/cobrança atômica, bloqueio por dívida, permissões, descontos, estornos, recibos, relatórios, caixa e recuperação criptografada com cobranças encerradas.
- Tipos e lint direcionado aprovados; compilação nativa aprovada. A base de desenvolvimento existente foi conferida por hashes e permaneceu preservada.
- Scripts PowerShell verificados por análise sintática. Reinício do Windows, identidades de tarefas, firewall, certificado confiável e backup externo precisam ser validados no servidor real.

O lint global do repositório possui pendências anteriores; esta entrega utiliza os comandos direcionados de lint e os trabalhos do CI. Não declara o repositório inteiro sem pendências de lint.

## Atualização

Use o pacote com manifesto e SHA-256. Antes de migrar uma base anterior, pare somente a aplicação reconhecida e produza backup completo com recuperação verificada. As migrações `004_porto.sql` e `005_porto_financeiro.sql` são aditivas; os arquivos aplicados anteriormente não são editados. O esquema possui bloqueios para saídas sem cobrança/quitação e para registros financeiros mutáveis.

O módulo é desativado por padrão. No servidor, `-EnablePorto` persiste a habilitação em `current.json`, lida pela tarefa sem login. A candidata exige `-Homologacao`. Não utilize banco, mídia ou tarefas da instalação ativa para um ensaio sem planejamento.

O backup externo e a pasta da chave de recuperação continuam sem destino informado pela empresa. A atualização no servidor permanece condicionada à definição desses caminhos e ao aceite de portaria, financeiro, diretoria e TI.

Consulte [regras e operação](GESTAO-PORTO.md), [roteiro de homologação](HOMOLOGACAO-PORTO.md), [implantação Windows](IMPLANTACAO-SERVIDOR.md) e [texto para o Codex no servidor](PROMPT-ATUALIZACAO-PORTO.md).
