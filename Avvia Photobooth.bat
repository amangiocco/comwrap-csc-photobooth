@echo off
rem Doppio clic: apre il prompt e avvia il server del photobooth (con il servizio di stampa).
rem La finestra resta aperta con i messaggi del server; per fermarlo: Ctrl+C oppure chiudi la finestra.
chcp 65001 >nul
title Photobooth Comwrap Roma - server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non e' installato: scaricalo da https://nodejs.org ^(versione 20 o successiva^) e riprova.
  pause
  exit /b 1
)

rem gia' acceso? due server sugli stessi dati si pesterebbero i piedi: apro solo l'admin
curl -s -m 3 http://localhost/api/health | find "ok" >nul 2>nul
if not errorlevel 1 (
  echo Il photobooth e' gia' acceso: apro l'admin.
  start http://localhost/admin
  timeout /t 3 >nul
  exit /b 0
)

if not exist node_modules (
  echo Prima installazione delle dipendenze, attendi...
  call npm install
  if errorlevel 1 (
    echo Installazione non riuscita.
    pause
    exit /b 1
  )
)

rem apre l'admin nel browser qualche secondo dopo l'avvio
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start http://localhost/admin"

call npm start

echo.
echo Il server si e' fermato.
pause
