# Prontidão operacional

Revisão local de 17/11/2026. Este registro distingue verificações de desenvolvimento de aceite no servidor e nos equipamentos reais. Não substitui a homologação da empresa.

## Segurança e dependências

A auditoria inicial retornou 29 alertas: um crítico, dez altos, dezessete moderados e um baixo. Após atualização do lockfile, `npm audit --json` retornou zero alertas conhecidos, incluindo dependências de desenvolvimento. Esse resultado retrata a base de avisos consultada nessa data; não comprova ausência de vulnerabilidades.

| Pacote | Versão validada |
| --- | --- |
| Next.js e eslint-config-next | 16.4.6 |
| vinext | 1.4.6 |
| Vite | 8.3.8 |
| Cloudflare Vite plugin | 1.70.0 |
| Wrangler | 4.164.0 |
| Cloudflare Workers types | 5.20261117.1 |
| drizzle-kit | 0.31.11 |

Os overrides corrigem as dependências transitivas `miniflare → sharp` (0.35.5), `satori → fflate` (0.7.5) e `@esbuild-kit/core-utils → esbuild` (0.25.12). A geração de uma migração SQLite em diretório isolado passou, sem conectar a banco ou alterar as migrações do projeto. Os builds PostgreSQL e Cloudflare passaram. O CI passa a executar `npm audit --audit-level=high`, além de lint completo, tipos e testes.

Verificações locais após as atualizações:

- Suíte completa: 308 testes aprovados, nenhuma falha ou caso ignorado, com PostgreSQL e testes opcionais de vídeo no navegador e HTTPS habilitados. A execução final limitou a concorrência a dois arquivos; a primeira execução simultânea com o build apresentou um bloqueio de pasta temporária ao encerrar o teste do supervisor. O caso isolado e a suíte final passaram.
- Integração iDSecure: 20 testes aprovados, incluindo recusa de senha igual ao usuário e classificação das respostas HTTP 400/401/403 de autenticação, contra central fictícia.
- Tipos, lint completo, formatação e os dois builds aprovados.
- Interface: 11 capturas com busca, seleção, navegação responsiva e formulário; nenhum erro de navegador ou violação automática de acessibilidade encontrada.
- Recarregamento automático: alteração recebida sem perder o estado React. A primeira inicialização, com recompilação das dependências após a troca do lockfile, excedeu o limite de 120 segundos do teste; a repetição isolada passou. O tempo de partida com cache vazio ainda deve entrar na avaliação de desempenho.
- Aplicação local reiniciada: página inicial HTTP 200 e API de sessão HTTP 401 sem autenticação, com certificado HTTPS validado. Integração física desativada.

Foram consultados os avisos oficiais do Next.js [GHSA-2464-fhr4-w9xw](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw) e [GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j). A atualização inclui as correções indicadas pelo fornecedor.

## Credencial da central: pendente

A substituição não está comprovada. O procedimento interativo recusou a senha informada por ser igual ao usuário, antes de fazer uma requisição de autenticação. Nenhuma nova credencial foi salva e o procedimento não altera a senha na central.

O cliente de integração também rejeita esse tipo de credencial antes de acessar a rede. Respostas HTTP 400 durante o login e HTTP 401/403 são apresentadas como falha de autenticação, com etapa e código HTTP, sem expor senha, token ou corpo da resposta. Esses casos têm regressão contra uma central fictícia.

Para concluir:

1. Alterar a senha diretamente no portal da central, se necessário, e confirmar que a nova credencial permite login.
2. No terminal da instalação, executar `npm run integration:idsecure:credentials`. Informar a credencial atual somente nesse terminal; os campos de senha mostram asteriscos.
3. Aguardar a confirmação de conexão validada e configuração atualizada. Em caso de erro, o arquivo anterior é preservado.
4. Reiniciar a aplicação e verificar a consulta do monitor. Não habilitar a integração física como parte da troca de credencial.

A busca específica pela credencial obsoleta em campos de senha não encontrou correspondências nos 264 arquivos versionáveis examinados nem nas alterações dos 28 commits disponíveis localmente. Encontrou referências na configuração privada da integração e em duas cópias privadas de arquivos do frontend da central. Os caminhos detalhados ficam em `.porto-tooling/credential-location-audit.json`, fora do Git. Essa inspeção não abrange arquivos cifrados, binários, outros computadores, histórico remoto não disponível ou o próprio histórico do chat.

Na configuração local examinada, as permissões de arquivo do Windows permitem acesso ao usuário da instalação e ao sistema, sem permissão ampla para os demais usuários. Essa verificação não comprova as permissões da instalação no servidor. O arquivo continua contendo a credencial obsoleta; ignorá-lo no Git e restringir seu acesso não substituem a rotação na central.

## Pendências para aceite

| Prioridade | Situação verificada | Próximo critério de aceite |
| --- | --- | --- |
| Segurança | Pacotes atualizados; proteção contra credencial igual ao usuário; credencial nova não validada | Validar credencial segura no terminal e confirmar consultas após reiniciar |
| Recuperação | Há restaurações locais verificadas; destino externo não definido | Definir destino e chave separada; recuperar banco, fotos, vídeos e configurações em ambiente isolado |
| Operação contínua | Instalador e tarefas de servidor preparados; aplicação local responde por HTTPS | Executar pacote no servidor e comprovar acesso antes de login após reinício, incluindo recuperação de falhas |
| Controle físico | Integração física permanece desativada; testes isolados cobrem janela individual e falhas | Concluir calendário de segunda a sábado, 07h30–11h e 13h30–17h; homologar novo mecanismo com operador e contingência disponíveis |
| Publicação | Código de trabalho ainda sem nova release; referência identificada permanece v0.8.0-rc.1 | Revisar e publicar commit, tag, migrações e pacote correspondentes; registrar versão instalada |
| Eventos | Monitor consulta a central; autorização permanece distinta de passagem física | Persistir histórico/cursor, recuperar desconexões sem duplicidade e validar giro e sentido reais |
| Mídias e sincronização | Vídeos têm limites, retomada, cotas e retenção testados | Uniformizar política das fotos importadas, conferir arquivos abandonados e definir sincronização periódica |
| Desempenho e gestão | Existem testes de concorrência e busca com 650 cadastros fictícios | Medir carga representativa, latências, simultaneidade e falhas com metas acordadas |

O backup PostgreSQL atual reúne banco e objetos de mídia. As configurações e certificados de execução exigem preservação separada; não estão comprovados como parte de uma recuperação externa completa. O teste do supervisor em uma pasta temporária deste computador não comprova inicialização do servidor Windows sem login.

As evidências detalhadas de execução local ficam em `.porto-tooling/`, que é ignorado pelo Git. Não anexar arquivos de configuração, certificados privados ou credenciais à release.
