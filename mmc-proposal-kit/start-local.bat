@echo off
setlocal
cd /d "%~dp0server"
if not exist package.json (
  echo ERROR: server folder or package.json was not found.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies for this computer...
  call npm install
  if errorlevel 1 goto :error
) else (
  echo Rebuilding native SQLite module for this computer...
  call npm rebuild better-sqlite3
  if errorlevel 1 goto :error
)
if not exist .env (
  copy .env.example .env >nul
  powershell -NoProfile -Command "(Get-Content .env) -replace '^JWT_SECRET=.*','JWT_SECRET=mmc-local-development-secret-change-me' | Set-Content .env"
  echo Created server\.env
)
call npm run migrate
if errorlevel 1 goto :error
echo.
echo MMC server is starting at http://localhost:4000
echo Open the procurement portal at http://localhost:4000/procurement/index.html
echo Press Ctrl+C to stop the server.
echo.
call npm start
exit /b 0
:error
echo.
echo Installation or native module build failed. Make sure Node.js 20 or newer is installed.
pause
exit /b 1
