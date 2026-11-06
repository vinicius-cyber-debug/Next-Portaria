# Fotos, vídeos e retenção — 0.7.0

Na instalação PostgreSQL, abra uma ocorrência já registrada e use **Fotos e vídeos → Adicionar foto ou vídeo**. Os anexos antigos PDF/imagens continuam disponíveis. O módulo novo aceita MP4, WebM, PNG, JPEG e WebP; os arquivos são privados e exigem sessão e permissão de documentos. Anexar exige também permissão de gerenciar ocorrências, dentro do perfil base.

## Limites e retomada

- Vídeo: 256 MiB; imagem: 10 MiB; até 20 arquivos por ocorrência.
- Até três envios pendentes por usuário; partes de 5 MiB; envios incompletos vencem em 24 horas.
- Cota inicial do módulo: 20 GiB, incluindo reservas de envios pendentes; cada parte exige manter 1 GiB livre no disco.
- Para retomar após falha, pausa ou fechamento da página, selecione o mesmo arquivo no mesmo navegador e clique em **Enviar ou retomar**. Nome, tamanho, tipo e data do arquivo identificam o envio; o SHA-256 de cada parte já recebida também é comparado antes de pular essa parte.
- Se o armazenamento local do navegador não estiver disponível, o envio continua possível, mas a retomada após fechar a página fica indisponível. A lista de pendentes permite cancelar esses envios.

O servidor verifica proprietário, permissões atuais, ordem, tamanho, assinatura de formato e hashes. Só publica o arquivo após concluir todas as partes. Partes repetidas com o mesmo hash são idempotentes. Uma alteração de acesso durante envio é revalidada antes de confirmar a gravação.

O player usa requisições HTTP de intervalo e não carrega o vídeo inteiro na memória do servidor. A aplicação não converte codecs: recomenda-se MP4 com H.264/AAC para aparelhos que aceitem esse formato. WebM também está disponível, conforme o navegador. Não há geração de miniaturas nem transcodificação nesta versão.

## Retenção

O padrão conserva os arquivos. Administradores podem definir de 1 a 3650 dias no detalhe de uma ocorrência, em **Retenção de fotos e vídeos da unidade**. A confirmação informa que a política vale para todos os arquivos desse módulo, inclusive os existentes. Voltar ao campo vazio não recupera arquivos já removidos.

Ao vencer, o arquivo fica indisponível imediatamente. A rotina diária marca a exclusão, registra auditoria e remove o objeto; falhas físicas de remoção são retomadas na próxima execução. A rotina também limpa partes concluídas/canceladas e envios vencidos. Cadastros e auditoria são preservados.

No desenvolvimento, execute `npm run media:retention`. No servidor preparado pelo pacote, a tarefa `NextPortaria-Retencao` executa às 01h. Backup e retenção usam o mesmo bloqueio de manutenção no Windows para evitar cópias concorrentes com remoções. Arquivos órfãos de uma falha excepcional de processo/commit podem exigir inspeção manual; a rotina não varre e apaga arquivos sem vínculo indiscriminadamente.

A política do módulo não elimina arquivos de backups já existentes. Defina separadamente a conservação e o descarte dos backups da empresa. O JSON operacional não transporta as mídias; use o backup completo PostgreSQL para recuperar banco e arquivos juntos.

## Validação e limites

Os ensaios usam banco, contas e arquivos de QA separados. Incluem MP4 real, envio interrompido na segunda parte, recarga da aplicação, retomada sem reenviar a primeira parte, reprodução na interface, acesso sem sessão, SHA inválido, conteúdo disfarçado, revogação de permissão, intervalos HTTP, retenção e restauração criptografada. Não houve teste em celular físico nem carga sustentada com grande volume de vídeos.
