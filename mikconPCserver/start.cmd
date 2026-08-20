@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.5 or newer from https://nodejs.org
  echo Then paste this again.
  exit /b 1
)
node -e "var v=process.versions.node.split('.').map(Number); if (v[0]<22 || (v[0]===22 && v[1]<5)) process.exit(1)"
if errorlevel 1 (
  echo Node 22.5 or newer is required.
  node -v
  echo Install from https://nodejs.org
  exit /b 1
)
call npm run up
exit /b %ERRORLEVEL%
