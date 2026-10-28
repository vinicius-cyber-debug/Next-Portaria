@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
echo PORTO GESTAO - Atualizacao LOCAL manual
where node >nul 2>&1 || goto :falha
where npm >nul 2>&1 || goto :falha
node scripts/local-service.mjs stop
if errorlevel 1 goto :falha
echo Antes de continuar, outros servidores npm run dev devem estar encerrados.
if exist ".wrangler\state\v3\d1" (
  echo Criando backup completo antes da atualizacao...
  node scripts/full-backup.mjs create --offline
  if errorlevel 1 goto :falha
)
if not exist "node_modules\wrangler\bin\wrangler.js" (
  call npm ci
  if errorlevel 1 goto :falha
)
call npm test
if errorlevel 1 goto :falha
call npm run check
if errorlevel 1 goto :falha
call npm run build
if errorlevel 1 goto :falha
node scripts/setup-local.mjs
if errorlevel 1 goto :falha
node scripts/create-local-admin.mjs
if errorlevel 1 goto :falha
node scripts/local-service.mjs start
if errorlevel 1 goto :falha
echo Atualizacao concluida. http://127.0.0.1:5173
exit /b 0
:falha
echo ERRO: atualizacao interrompida. Confira a mensagem acima.
echo Nao apague a base nem o backup para contornar erros.
pause
exit /b 1
