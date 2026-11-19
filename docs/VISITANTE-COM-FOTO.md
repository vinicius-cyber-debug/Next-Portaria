# Foto e autorização inicial de visitante na portaria

Regra definida: **o porteiro pode autorizar ao cadastrar**, exclusivamente para a entrada inicial pela portaria. Outros setores continuam pelo fluxo de solicitação e aprovação.

## Funcionamento implementado

No **Novo acesso**, o perfil de portaria com `gateOperate` e `documentView` inicia com **Autorizar acesso inicial somente na portaria** marcado. Administrador também pode selecionar essa opção. Ao utilizá-la:

1. Informe visitante, empresa e contato da unidade.
2. Abra a webcam, fotografe e confira a imagem. Também é possível escolher uma foto; o navegador reprocessa a imagem em JPEG. Câmera exige HTTPS ou loopback local e permissão do navegador. A câmera é desligada após capturar, trocar de etapa ou fechar o formulário.
3. Informe motivo e validade. O setor e os responsáveis de aprovação ficam indisponíveis neste modo; a autorização não concede acesso a outro setor.
4. Confirme a identidade e a autorização inicial. Foto e conferência são obrigatórias.
5. O sistema registra a autorização lógica, o autor, a validade e a foto privada, sem inventar uma entrada ou passagem física.

Sem essa opção, a solicitação continua aguardando a aprovação do responsável. O porteiro pode cancelar sua própria liberação inicial enquanto ainda não houve entrada, com justificativa; administrador pode cancelar qualquer liberação inicial. Não é permitido transferir a pessoa/foto ou ampliar o setor dessa autorização por correção de registro.

## Estado da integração física

**O envio e o reconhecimento facial real ainda não estão habilitados.** A tela apresenta `faceEnrollment.status = pending_integration`, e nunca declara cadastro facial concluído. A autorização no Next Portaria não significa que a catraca já recebeu ou aceitou a foto.

O destino foi identificado em consulta somente leitura à central. A preparação privada está em `.porto-runtime/visitor-face.json`, fora do Git, com equipamento, modelo e firmware fixados e `hardwareWritesEnabled: false`. O plano recusa mudança de destino/firmware, desativação dos bloqueios e autorização expirada, revogada ou sem elegibilidade atual. Não existe fallback para outros equipamentos.

```powershell
node --experimental-strip-types scripts/visitor-face-plan.mjs
```

O comando consulta o plano e imprime apenas destino e contagens; não envia foto nem comanda hardware. Não há cadastro real em expedição, produção ou portaria nesta etapa.

Para habilitar o envio automático, falta implementar e homologar o adaptador de escrita da central e sua regra específica de visitantes: cadastro sem grupos/permissões herdados, aceitação/qualidade da foto nos leitores vinculados, validade e revogação, consulta de confirmação e prova de que os demais equipamentos recusam o visitante. Não assumir que HTTP 200 ou foto armazenada confirma uma permissão sincronizada. O modo somente leitura do adaptador existente permanece preservado.

## Armazenamento e verificações

Fotos ficam no armazenamento privado existente. A captura aceita JPEG com menos de 2 MB, dimensões entre 160 e 1920 pixels e limite de pixels; essas verificações não substituem a análise facial do fabricante. O arquivo é vinculado à visita com SHA-256, proprietário conferido pelo servidor e acesso condicionado a sessão e `documentView`. A API não aceita hash/foto arbitrários no comando enviado pelo navegador. A auditoria registra referências e autoria, sem embutir a imagem.

Os backups completos incluem os arquivos, os vínculos e a conferência de hash da foto vinculada à visita. A restauração JSON exige que o armazenamento privado também esteja disponível; o JSON não contém as fotos. A fotografia permanece no histórico com o controle de acesso dos documentos, conforme a política de retenção aplicável à instalação.

A demonstração trata a captura e o envio de formulário somente na memória da aba, sem banco real ou equipamento. Não representa uma sincronização biométrica real.

Referência oficial: [Cadastro facial por fotos — API Linha de Acesso](https://www.controlid.com.br/docs/access-api-pt/reconhecimento-facial/cadastro-facial/). O equipamento pode recusar imagem por pose, nitidez, enquadramento ou face duplicada; essas respostas precisam ser tratadas pelo futuro adaptador de escrita homologado.
