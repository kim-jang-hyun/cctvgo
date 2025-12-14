@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion


echo ---------------------------------------------
echo [INFO] Starting ffmpeg script in new window...
cd /d %~dp0
start "FFmpeg HLS Stream" cmd /k "%cd%\start_ffmpeg.bat"

echo ---------------------------------------------
echo [INFO] Starting Cloudflare Tunnel in new window...
cd /d %~dp0\cloudflare
start "Cloudflare Tunnel" cmd /k "%cd%\cloudflare\start_tunnel.bat"

echo ---------------------------------------------
echo [INFO] Starting CCTVGO Service...
cd /d %~dp0
start "CCTVGO Service" cmd /k "%cd%\cctvgo-service.exe"

pause
