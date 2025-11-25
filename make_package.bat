@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo ---------------------------------------------
echo [INFO] Installing frontend dependencies...
cd /d "%~dp0\frontend"
echo [DEBUG] Current Directory 1: %CD%
call npm run build

echo ---------------------------------------------
echo [INFO] Installing backend dependencies...
cd /d "%~dp0\backend"
echo [DEBUG] Current Directory 2: %CD%
pkg %CD%\server.js --targets node18-win-x64 --output ./package/cctvgo-service.exe

pause
