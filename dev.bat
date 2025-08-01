@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion


echo ---------------------------------------------
echo [INFO] Installing frontend dependencies...
cd /d %~dp0\frontend
call npm install

echo ---------------------------------------------
echo [INFO] Installing backend dependencies...
cd /d %~dp0\backend
call generate-env.bat
call npm install

echo ---------------------------------------------
echo [INFO] Starting ffmpeg script in new window...
cd /d %~dp0
start "FFmpeg HLS Stream" cmd /k "%cd%\start_ffmpeg.bat"

echo ---------------------------------------------
echo [INFO] Starting Cloudflare Tunnel in new window...
cd /d %~dp0\cloudflare\customer_user1
start "Cloudflare Tunnel" cmd /k "%cd%\start_tunnel.bat"

echo ---------------------------------------------
echo [INFO] Starting frontend + backend servers...
cd /d %~dp0\backend
call npm run start:all

pause
