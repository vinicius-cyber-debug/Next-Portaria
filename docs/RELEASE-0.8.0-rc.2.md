# Next Portaria v0.8.0-rc.2

Candidata para homologação no Windows Server, com as melhorias de operação acumuladas desde a v0.8.0-rc.1.

## O que mudou

- **Visitantes.** Indicadores filtram a lista por situação. No celular, cada registro exibe os dados e as ações em uma ficha. Entrada ou saída ganha destaque conforme a situação e a permissão do operador.
- **Relatórios.** Oito tipos disponíveis para visitantes e acessos, veículos na portaria, frota própria, saída de materiais, ocorrências, passagens de turno, saídas sem entrada e conferências de emergência. Impressão e CSV usam o recorte selecionado e respeitam as permissões do usuário.
- **Logística.** Registro de saída e retorno da frota com hodômetro e vistoria privada por fase. Saídas de materiais aceitam referência à nota fiscal existente. [Frota e materiais](FROTA-MATERIAIS.md)
- **Control iD.** Administração configura e testa a conexão de leitura. O painel distingue o horário da consulta do horário do evento. A autorização exibida pela central ainda precisa de conferência física de giro e sentido. [Configuração](CONFIGURACAO-CONTROLID.md) · [Monitor](MONITOR-CATRACAS.md)
- **Acesso e segurança.** Autorizações recorrentes, importação de funcionários e fotos, autorização inicial com foto e fluxo individual de saída por setor. A liberação individual ainda exige homologação no equipamento. O envio facial exige implementação e homologação. Na inicialização, a aplicação verifica a identidade dos processos. Os hashes antigos são atualizados após autenticação válida. [Liberação individual](LIBERACAO-SAIDA.md) · [Foto do visitante](VISITANTE-COM-FOTO.md) · [Atualização segura](ATUALIZACAO-SEGURA.md)

## Evidências de desenvolvimento

- A suíte do código que antecede a preparação da candidata registrou 396 testes aprovados e zero falhas. Dois cenários opcionais, de reprodução de MP4 e gateway HTTPS, ficaram fora daquela execução.
- A revisão de interface de Visitantes e Relatórios passou em 88 verificações automatizadas em 360, 390 e 1366 px, incluindo filtros, ações por situação e impressão.
- Inicialização automática após reiniciar o Windows sem login, recuperação do backup externo e acesso em aparelho real compõem o aceite no servidor de destino.

## Atualização no servidor

1. Confira o SHA-256 do ZIP com o arquivo `.sha256` e extraia o pacote em uma pasta separada. O arquivo `release-manifest.json` identifica a tag, o commit e os hashes dos arquivos.
2. A partir da pasta extraída, execute a inspeção somente leitura. Ela pode ser feita antes da escolha do destino externo.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\server\VERIFICAR-SERVIDOR.ps1
   ```

3. Defina um compartilhamento UNC fora do servidor para os backups e uma pasta restrita separada para a chave. O instalador exige os dois parâmetros também em `-PreflightOnly`. O destino externo de backup permanece pendente.
4. Siga o guia de implantação para validar o pacote na instalação de homologação com `-Homologacao`. Antes de aplicar migrações, confirme a recuperação do backup externo e a cópia protegida das configurações de conexão e dos certificados. Esta candidata acrescenta as migrações `006_exit_access.sql` e `007_fleet_media.sql` à base da rc.1. [Implantação Windows Server](IMPLANTACAO-SERVIDOR.md)
5. Confirme a inicialização sem login depois de reiniciar o servidor, a leitura da central e o acesso HTTPS nos aparelhos autorizados. Gestão do Porto exige aceite empresarial antes da ativação em produção. [Homologação do Porto](HOMOLOGACAO-PORTO.md)

Após a atualização de um hash de senha, uma versão anterior que aceite somente o custo antigo deixa de autenticar essa conta. Planeje o retorno com código compatível com os dois custos e preserve as movimentações registradas desde o backup. [Orientação de retorno](ATUALIZACAO-SEGURA.md)
