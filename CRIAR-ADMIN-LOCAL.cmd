@echo off
setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
echo NEXT PORTARIA - Administrador da base local de desenvolvimento
call npm run db:admin
if errorlevel 1 (
  echo ERRO: o cadastro nao foi confirmado. Confira a mensagem acima.
  pause
  exit /b 1
)
echo Abra http://127.0.0.1:5180 para entrar na base local.
pause
