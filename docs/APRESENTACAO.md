# Demonstração com dados fictícios

Abra `http://127.0.0.1:4175/Next-Portaria/` neste computador. A demonstração inicia como **Marina Rocha · demonstração**, sem senha ou conta real. O aviso superior identifica dados fictícios e alterações restritas à aba.

O ambiente não utiliza o PostgreSQL operacional, os funcionários reais, suas fotos ou a central iDSecure. As consultas são respondidas na própria aba, com uma API de memória que recusa destinos externos. O monitor tem avatares ilustrativos e gera um evento fictício novo a cada 12 segundos; a tela consulta a simulação a cada 3 segundos. Os eventos não alteram as presenças.

## Roteiro sugerido

1. **Visão geral:** apresente os indicadores e o painel das catracas. Aguarde alguns segundos para mostrar a chegada de um evento fictício sem recarregar a página.
2. **Central de Acesso → Operação:** mostre pessoas presentes, pendências, autorizações e movimentações recentes. Abra uma solicitação pendente e demonstre a aprovação.
3. **Pessoas e autorizações:** busque **Beatriz Monteiro (fictícia)** e registre a entrada com conferência de identidade; ela já possui autorização prévia.
4. Busque **Renata Lima (fictícia)** e registre o **Retorno** da saída produtiva. O período e o motivo já estão preenchidos no histórico.
5. Busque **Eduardo Sousa (fictício)**, com saída por barco não confirmada. Registre uma nova entrada, justificando a reconciliação anterior, sem inventar o horário da saída.
6. Apresente **Visitantes**, **Veículos**, **Ocorrências e turnos** e **Relatórios**, todos com dados fictícios.

Use **Reiniciar demo**, na faixa superior, para voltar aos exemplos iniciais. Atualizar ou fechar a aba também descarta as alterações feitas na demonstração.

Para iniciar novamente após encerrar o processo:

```powershell
npm run build:demo
npm run demo:present
```

O sistema operacional continua em `http://127.0.0.1:5180/`, com sua base preservada. Não utilizar esse endereço durante a apresentação se o objetivo for mostrar apenas dados fictícios.
