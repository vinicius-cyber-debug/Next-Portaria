@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
echo NEXT PORTARIA - Banco local de desenvolvimento
where node >nul 2>&1 || goto :falha
where npm >nul 2>&1 || goto :falha
if not exist "node_modules\wrangler\bin\wrangler.js" (
  call npm ci
  if errorlevel 1 goto :falha
)
call npm run build
if errorlevel 1 goto :falha
call npm run db:setup
if errorlevel 1 goto :falha
echo.
echo Banco local preparado. Dados existentes preservados.
echo PostgreSQL usa os diretorios permanentes da configuracao privada.
echo O modo SQLite legado utiliza .wrangler\state.
echo Para carga ficticia em uma base vazia: npm run demo:local
echo Para criar seu administrador: CRIAR-ADMIN-LOCAL.cmd
echo Para abrir o ambiente: INICIAR-DESENVOLVIMENTO.cmd
exit /b 0
:falha
echo ERRO: preparacao interrompida. Nenhuma base deve ser apagada para contornar erros.
exit /b 1
