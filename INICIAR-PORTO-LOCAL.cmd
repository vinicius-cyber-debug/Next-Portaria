@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul

echo =============================================================
echo  NEXT PORTARIA - Servidor LOCAL compilado
echo =============================================================
echo.
where node >nul 2>&1 || (
  echo ERRO: Node.js nao encontrado. Instale Node.js 22.13+ e reabra o terminal.
  goto :falha
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)"
if errorlevel 1 (
  echo ERRO: Node.js precisa estar na versao 22.13 ou superior.
  node --version
  goto :falha
)
node scripts/local-service.mjs start
if errorlevel 1 goto :falha
echo Servidor em segundo plano. Esta janela pode ser fechada.
echo Para parar: node scripts/local-service.mjs stop
echo Para atualizar: ATUALIZAR-PORTO-LOCAL.cmd
start "" "http://127.0.0.1:5173"
exit /b 0

:falha
echo.
echo ERRO: a inicializacao foi interrompida. Confira a mensagem acima.
echo Confira .porto-runtime\status.json e .porto-runtime\logs.
pause

exit /b 1
