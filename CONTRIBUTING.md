# Como contribuir

Obrigado pelo interesse no Next Portaria. Correções, melhorias na documentação e propostas de evolução são bem-vindas.

## Antes de começar

- Consulte o [README](README.md), a [arquitetura](docs/ARQUITETURA.md) e o [roadmap](docs/ROADMAP.md).
- Para mudanças de escopo ou de arquitetura, abra uma issue explicando o problema e a proposta antes de implementar.
- Para vulnerabilidades, siga a [política de segurança](SECURITY.md).

## Preparar o ambiente

Use Node.js 22.13 ou superior, npm e Git:

```powershell
git clone https://github.com/vinicius-cyber-debug/Next-Portaria.git
cd Next-Portaria
npm ci
npm run dev:demo
```

Para enviar alterações, trabalhe em uma branch no seu fork. A demonstração usa dados fictícios e não persiste alterações. Consulte o [guia de operação](docs/OPERACAO-LOCAL.md) para testar a instalação com persistência.

## Relatar um problema

Informe o comportamento esperado, o resultado observado, os passos para reproduzir, a versão ou commit e o ambiente. Use somente dados fictícios em exemplos e capturas.

## Enviar um pull request

1. Mantenha a mudança focada em um problema.
2. Preserve o estilo dos arquivos existentes e atualize a documentação afetada.
3. Inclua testes quando alterar regras de negócio, autorização, API, sincronização ou recuperação.
4. Execute as verificações abaixo e descreva os resultados no PR:

```powershell
npm test
npm run check
npm run lint
npm run build
npm run build:demo
```

A integração contínua verifica testes, tipos e compilações no Linux e no Windows.

Alterações no banco devem incluir uma nova migração e verificação de atualização de uma base existente. Preserve migrações distribuídas e a compatibilidade dos backups. Verifique permissões no servidor, inclusive nas consultas e exportações.

Descreva no PR o problema, a solução e como validou a mudança. Para alterações visuais, inclua capturas com dados fictícios. Não envie bancos operacionais, backups, senhas, tokens ou dados pessoais.

## Licença

As contribuições ao projeto são distribuídas sob a [licença MIT](LICENSE).
