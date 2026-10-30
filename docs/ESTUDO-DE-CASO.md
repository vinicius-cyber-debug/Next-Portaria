# Next Portaria — estudo de caso

**Autor:** [Vinicius Maia](https://www.linkedin.com/in/viniciusmaia001/) · Desenvolvedor Full Stack

[Experimentar demonstração](https://vinicius-cyber-debug.github.io/Next-Portaria/) · [Vídeo de 40 segundos](assets/fluxo-visita.mp4) · [Arquitetura](ARQUITETURA.md)

## Problema e proposta

Uma rotina de portaria envolve decisões relacionadas: quem solicita uma visita, quem pode autorizá-la, em qual período a pessoa pode entrar, como confirmar sua presença e como consultar o histórico depois.

O Next Portaria reúne esse fluxo em uma aplicação web com visitantes, pessoas, veículos, responsáveis, permissões, ocorrências, auditoria e recuperação de dados.

## Minha participação

> Desenvolvi a aplicação completa de forma independente, da interface às regras de negócio, passando pela API, persistência e testes. Meu principal desafio foi transformar a rotina de trabalho da portaria em regras claras e consistentes, mantendo autorização, presença e histórico alinhados em cada etapa.

A participação no desenvolvimento original foi informada por Vinicius Maia. O estudo de caso e os materiais de apresentação desta etapa foram preparados com assistência de IA.

O trabalho abrange a interface React, os fluxos operacionais, as permissões por perfil, a integração com D1/SQLite e R2 e a validação automatizada do comportamento.

## Principal desafio: modelar a lógica de trabalho

O desafio vai além de cadastrar visitantes: cada operação precisa respeitar o estado atual do registro, o papel de quem executa a ação e a validade da autorização.

| Situação | Tratamento na aplicação |
| --- | --- |
| Uma solicitação aguarda decisão | Responsável ou substituto decide a autorização. |
| A pessoa chega à portaria | O operador confere a identidade e registra a entrada dentro do período autorizado. |
| A visita está em andamento | A presença é acompanhada até o registro da saída. |
| A mesma requisição é repetida ou o estado mudou | O servidor usa idempotência, revisão esperada e proteções de integridade. |
| É necessário entender o ocorrido | O histórico de auditoria registra as ações e alterações. |

As regras de domínio ficam separadas da interface e do transporte HTTP. Permissões e filtragem de dados são aplicadas no servidor. Essas fronteiras permitem testar regras sem depender de interação manual com a tela.

Consulte as [decisões técnicas](DECISOES-TECNICAS.md) para persistência, sincronização, permissões e recuperação, incluindo os limites atuais.

## Resultados verificados

Em **30/10/2026**, a suíte do commit [f8c52af](https://github.com/vinicius-cyber-debug/Next-Portaria/commit/f8c52af43fa4e8125cdb60ff2d824cb0d2c16814) foi executada no Windows com Node.js 24.13.1:

| Indicador | Resultado |
| --- | --- |
| Arquivos de teste | 16 |
| Testes executados | 154 |
| Testes aprovados | 154 |
| Falhas | 0 |
| Cancelados, ignorados ou pendentes | 0 |
| Verificação de tipos | `npm run check` concluída sem erros |

A suíte inclui regras de negócio, API, autenticação, permissões, sincronização, backup e restauração. Há também [verificações de qualidade no GitHub Actions](https://github.com/vinicius-cyber-debug/Next-Portaria/actions/workflows/quality.yml), com execução no Linux e no Windows.

Esses números registram uma execução da suíte; não representam cobertura de código, desempenho sob carga ou garantia de ausência de defeitos. O projeto **ainda não está em uso operacional**. Não foram medidos ganhos de produtividade, redução de incidentes ou resultados financeiros.

## Como reproduzir a validação

```powershell
git clone https://github.com/vinicius-cyber-debug/Next-Portaria.git
cd Next-Portaria
git checkout f8c52af43fa4e8125cdb60ff2d824cb0d2c16814
npm ci
npm test
npm run check
```

Para testar a versão atual, use a branch `main`; a contagem pode mudar conforme a suíte evoluir.

## Fluxo demonstrado

O [vídeo](assets/fluxo-visita.mp4) apresenta uma sequência de capturas reais da interface, com legendas e sem áudio:

1. Solicitação de Alex Demo, visitante fictício, com responsável e período definidos.
2. Autorização pelo responsável.
3. Conferência de identidade e registro da entrada.
4. Consulta do visitante no estado **No local**.
5. Registro de saída.
6. Consulta do estado **Finalizado**.
7. Auditoria com solicitação, autorização, entrada e saída do mesmo registro.

A verificação manual também confirmou o bloqueio de entrada antes do período autorizado. A demonstração mantém alterações somente na memória da aba e não exercita a persistência operacional. Os testes automatizados complementam a demonstração visual.

## Próxima etapa

Validar o sistema em um piloto autorizado, com critérios definidos antes do uso: correção dos fluxos, clareza para o operador, recuperação de backup e comportamento com registros simultâneos. Qualquer resultado de operação deve ser medido e autorizado antes de ser publicado.
