# Pessoas autorizadas, barcos e saídas produtivas

Na **Central de Acesso → Pessoas e autorizações**, administrador ou diretoria revisa o cadastro e a segurança e concede autorização prévia com setores permitidos, validade opcional e justificativa. O perfil também precisa da permissão `accessManage`. A portaria confere a identidade em cada entrada; a autorização não ignora pessoa inativa, bloqueios, requisitos vencidos ou restrição de setor. Quem não tem autorização continua pelo fluxo de solicitação e aprovação.

## Barcos e presença incerta

A autorização pode usar **Barcos · saída sem confirmação**. A entrada é registrada com horário real, mas fica em **Saída não confirmada**, separada das presenças confirmadas. A portaria também pode indicar essa condição em uma presença já aberta, com justificativa. Não se cria horário de saída presumido.

Uma nova entrada exige justificar a reconciliação anterior. O registro antigo fica `unconfirmed_closed`, com autor/data da reconciliação e `leftAt: null`. Uma saída realmente observada pode ser registrada normalmente. A lista de emergência inclui presenças incertas com identificação explícita; não as declara fisicamente presentes.

## Funcionários e período produtivo

**Saída produtiva** registra período informado pelo operador, motivo e horário do servidor. Não exige nova aprovação. O funcionário fica fora da lista de presentes e da lista inicial de emergência, com a permanência vinculada ao histórico de saídas e retornos. A ação **Retorno** exige identidade e elegibilidade atual, incluindo autorização vigente; não permite retorno duplicado ou em ordem cronológica inválida. A saída definitiva permanece uma ação distinta.

## Diretório iDSecure

O leitor acessa a **central iDSecure**, não os comandos das catracas. Estão permitidas somente autenticação, consulta paginada de pessoas e consulta individual para foto/flags. Não há abertura de portas, cadastro biométrico, alteração de permissões nem escrita na origem.

O vínculo é `(sourceId, idDevice)`; `id` é apenas a referência atual usada na consulta. Inteiros de 64 bits não passam por arredondamento. Nomes iguais não são fundidos automaticamente. São importados nome, matrícula quando não aparenta documento completo, final do CPF, flags de origem e foto raster. Senhas, templates biométricos e demais dados do detalhe são descartados. Cadastros novos começam como funcionário **com segurança pendente e sem autorização local**. A classificação e empresa devem ser revisadas; a origem não identifica necessariamente o vínculo empregatício da empresa.

Reimportações preservam nome/empresa/classificação/segurança/autorização revisados localmente, atualizam o vínculo, flags e fotos. Ausência numa leitura completa bloqueia novas entradas sem apagar o histórico. Registro de origem inativo ou em lista de bloqueio continua impedido mesmo se o cadastro local estiver ativo. Bloqueio, inatividade ou ausência revoga autorização prévia local; uma reativação da origem não a concede novamente. Falha na leitura completa não confirma alterações parciais de cadastros. Falha isolada de foto mantém a foto anterior e é contada no relatório; pode ser repetida depois.

Fotos ficam fora da raiz pública, com chave pelo SHA-256. A rota `/api/people/:id/photo` exige sessão ativa e `documentView`, usa `private, no-store` e não expõe uma pasta pública. Fotos também entram no backup completo PostgreSQL com conferência de tamanho/hash e teste de recuperação.

### Configuração privada por instalação

Não versionar credenciais, certificados privados ou fotos. Criar `.porto-runtime/idsecure.json` com acesso restrito à conta do serviço e administradores responsáveis:

```json
{
  "origin": "https://IP_INTERNO:30443",
  "sourceId": "idsecure-main",
  "username": "CONFIGURAR_LOCALMENTE",
  "password": "CONFIGURAR_LOCALMENTE",
  "fingerprint256": "SHA256_DO_CERTIFICADO_VERIFICADO",
  "certificatePath": "CAMINHO_ABSOLUTO_DO_CERTIFICADO_PEM",
  "mode": "read_only"
}
```

O transporte exige HTTPS de rede privada, cadeia confiada pelo certificado fornecido e fingerprint correspondente. Verificar o certificado por um canal confiável antes de cadastrar; não desativar TLS globalmente. Usar uma conta de leitura se a central permitir esse perfil. `sourceId` deve permanecer estável nas atualizações.

```powershell
node --experimental-strip-types scripts/import-idsecure.mjs --preview
# Antes da primeira aplicação: parar a aplicação e criar backup completo verificado.
npm run stop
npm run backup:postgres
node --experimental-strip-types scripts/import-idsecure.mjs --apply
npm start
```

O relatório mostra apenas contagens. A importação confirma os cadastros em transação sob a mesma revisão operacional, grava auditoria de integração e publica o delta para clientes conectados. Não exige nova migração SQL: os novos campos são aditivos nos registros JSON do PostgreSQL.

Esta entrega não consome eventos das catracas automaticamente. Modelo, firmware, sentido físico e confirmação de passagem ainda precisam ser validados antes de mapear eventos para presença. Uma autorização liberada pelo equipamento não comprova uma passagem.

Referências oficiais: [integração iDSecure](https://www.controlid.com.br/docs/idsecure-pt/integracao/), [regras de acesso](https://www.controlid.com.br/docs/idsecure-pt/acesso/).
