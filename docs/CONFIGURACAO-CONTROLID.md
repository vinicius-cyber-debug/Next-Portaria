# Conexão Control iD pelo portal

A instalação PostgreSQL possui a área **Administração → Control iD**, exclusiva para administradores ativos. Ela configura a central **iDSecure**, usada na leitura dos funcionários e dos eventos. Os leitores individuais e as permissões físicas continuam no fluxo de integração/homologação próprio.

## Configurar

1. Informe o endereço HTTPS da central, incluindo a porta, e o usuário.
2. Informe a senha atual da central no campo protegido. Em uma conexão existente, o campo vazio preserva a senha se o endereço e o usuário forem os mesmos.
3. Na primeira conexão, envie o certificado público em formato PEM. Confirme o certificado com a equipe responsável pela central. Em uma atualização, deixar o certificado vazio preserva o existente; um certificado ausente ou expirado pode ser substituído nessa tela.
4. Use **Testar conexão**. O teste autentica e consulta a configuração da central, sem enviar regras ou alterar catracas.
5. Use **Salvar conexão**. O sistema valida novamente antes de salvar. Aguarde o intervalo indicado se tiver acabado de testar.

O identificador da integração é definido na primeira configuração e preservado depois, para manter os vínculos dos funcionários. A tela mostra fingerprint SHA-256, validade do certificado e o horário do último teste efetuado durante a edição. A configuração salva não comprova conectividade contínua; consulte também o estado e a atualização dos eventos no painel.

## Proteção e continuidade

- A senha e os tokens não são devolvidos pela API, gravados na auditoria ou armazenados no navegador.
- Endereços exigem HTTPS e IPv4 privado. O servidor valida o certificado fixado e não oferece opção para ignorar a validação TLS.
- O teste de conexão respeita limite de concorrência e intervalo mínimo. Falhas de autenticação da central são diferenciadas da expiração da sessão do portal.
- O salvamento confere versão, sessão e perfil administrativo novamente. Alterações concorrentes não sobrescrevem uma configuração mais recente.
- A configuração permanece na pasta de dados do servidor. No desenvolvimento local, mantém o destino `.porto-runtime/idsecure.json`.
- Após salvar, o monitor descarta a sessão e os eventos em cache e passa a usar a configuração nova, sem reiniciar a aplicação. Respostas antigas em voo são descartadas.
- A área configura a leitura da central. Se houver integração física de saída ativa, a aba permite consultar a configuração e a manutenção fica a cargo do servidor.

Banco e arquivos da configuração têm persistências distintas. Inclua a pasta privada de integrações e os certificados no plano de recuperação protegido do servidor. Não copie senhas, tokens ou o conteúdo do arquivo de configuração para chamados ou chat.

## Verificação

Os testes usam uma central HTTPS fictícia e bancos isolados. A aplicação real exige que o administrador informe e valide a credencial atual diretamente na tela; a implantação da área não realiza tentativas automáticas contra a central real.
