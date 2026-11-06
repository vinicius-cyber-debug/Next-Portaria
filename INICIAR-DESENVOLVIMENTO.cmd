@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
echo NEXT PORTARIA - Desenvolvimento com banco persistente
echo Acesso neste computador: http://127.0.0.1:5180
if exist ".porto-runtime\postgres.json" (
  echo Dados no PostgreSQL e no armazenamento privado configurados.
) else (
  echo Os dados ficam em .wrangler\state desta pasta.
)
echo Mantenha este terminal aberto. Para encerrar, use Ctrl+C.
call npm run dev:local
if errorlevel 1 (
  echo ERRO: confira se o banco foi preparado e se a porta 5180 esta disponivel.
  pause
  exit /b 1
)
