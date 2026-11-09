# Eventos das catracas no painel inicial

**Visão geral → Movimentação das catracas** consulta os últimos eventos da central iDSecure. Exibe foto privada quando houver vínculo, nome, instante do evento, equipamento, área informada e resultado original, como acesso autorizado, pendente ou negado.

Conforme definido para esta etapa, são apresentados **eventos da central**, sem afirmar confirmação de giro. A liberação não comprova passagem; a área informada não comprova o sentido físico. O painel não cria entradas/saídas nem altera a presença operacional. Essa conciliação depende de validação de modelo/firmware, configuração de sentido e teste físico de entrada/saída.

## Consulta e falhas

- O navegador consulta a cada 3 segundos enquanto o painel está visível. Ao retornar à aba, consulta novamente.
- Uma consulta compartilhada por processo limita a frequência de acesso à central; vários usuários não disparam uma consulta externa cada um. Há timeout no transporte e no navegador.
- A fonte é o `GET /api/access/monitor` utilizado pela própria interface iDSecure. A janela retornada é definida pela central; não é um arquivo completo de passagens. Eventos idênticos repetidos por vínculos de câmera são agrupados por equipamento/log. Conflitos de identidade invalidam a consulta.
- O cache é temporário. Não existe novo arquivo de logs ou histórico local durável nesta etapa. Reiniciar a aplicação consulta a janela atual novamente; o histórico completo permanece sob responsabilidade da central.
- Em falha, a interface conserva os últimos eventos com o horário da última consulta recebida e mostra indisponibilidade. Não apresenta a conexão como atualizada. Falhas comuns aguardam 10 segundos antes da nova tentativa; credencial recusada/configuração ausente aguardam 60 segundos.
- Alterações de um mesmo log substituem o estado mostrado na próxima janela. O horário ASP.NET usa os milissegundos UTC, sem aplicar o offset exibido duas vezes.

## Privacidade e configuração

A rota local `GET /api/integrations/idsecure/monitor` exige sessão ativa e `documentView`, com nova conferência da permissão após a leitura da rede. A resposta é `private, no-store`. Não retorna CPF, cartão, endereço de câmera, informações livres ou credenciais. As fotos continuam protegidas pela rota privada de pessoas.

O vínculo de eventos usa o `idUser` da central como referência ao **registro mutável** do usuário (`directory.recordId`). Não deve ser comparado ao `idDevice` imutável de outra pessoa. Quando não há vínculo confiável, o evento permanece com o nome informado pela central e sem foto local.

Reutiliza o arquivo privado descrito em [ACESSOS-RECORRENTES-IDSECURE.md](ACESSOS-RECORRENTES-IDSECURE.md), com HTTPS e certificado fixado. A execução pelo perfil local instalado carrega `.porto-runtime/idsecure.json`. Instalações que fornecem PostgreSQL inteiramente por variáveis de ambiente também precisam definir `PORTO_IDSECURE_CONFIG` com o caminho absoluto desse arquivo. Isso impede que bancos isolados de QA ativem uma integração real por descoberta implícita.

Não há migração SQL nem gravação de movimentos por essa consulta. O adaptador permite somente leitura de pessoas/fotos e monitor, além da autenticação. Não são chamados endpoints de liberação, configuração de hardware ou escrita na central.

## Verificação

```powershell
node --experimental-strip-types --test tests/turnstile-monitor.test.mjs
npm run test:monitor:browser
```

O navegador de QA usa banco descartável e eventos/fotos sintéticos, com destino privado real desabilitado. Verifica atualização periódica, desconexão/recuperação, pausa de aba oculta, remoção dos eventos após revogação, expansão móvel, acessibilidade e larguras de 360 a 1366 pixels.

Referência oficial para a etapa futura: [Monitor Control iD — confirmação de giro, desistência e associação ao log](https://www.controlid.com.br/docs/access-api-pt/monitor/introducao-ao-monitor/).
