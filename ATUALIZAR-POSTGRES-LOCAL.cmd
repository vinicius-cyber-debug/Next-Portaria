@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
echo NEXT PORTARIA - Atualizacao PostgreSQL
call npm run stop
if errorlevel 1 goto :falha
call npm run postgres:start
if errorlevel 1 goto :falha
call npm run backup:postgres
if errorlevel 1 goto :falha
call npm ci
if errorlevel 1 goto :falha
call npm test
if errorlevel 1 goto :falha
call npm run check
if errorlevel 1 goto :falha
call npm run build
if errorlevel 1 goto :falha
call npm run db:setup
if errorlevel 1 goto :falha
echo Atualizacao concluida. Inicie com INICIAR-DESENVOLVIMENTO.cmd ou npm start.
exit /b 0
:falha
echo ERRO: atualizacao interrompida. Preserve o banco, os arquivos e o backup.
exit /b 1
