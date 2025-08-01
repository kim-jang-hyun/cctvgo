@echo off
cd /d "%~dp0"

setlocal

:: 사용자 설정값
set RTSP_URL=rtsp://localhost:8554/cctvgo
set OUTPUT_DIR=hls
set STREAM_FILE=stream.m3u8
set RETRY_DELAY=5

:: 출력 디렉토리 비우기
del /Q "%OUTPUT_DIR%\*.ts"
del /Q "%OUTPUT_DIR%\*.m3u8"

:loop
echo ---------------------------------------------
echo [INFO] Trying TCP first... (%time%)
ffmpeg -re -fflags nobuffer -rtsp_transport tcp -i %RTSP_URL% -c:v copy -c:a copy -f hls -hls_time 2 -hls_list_size 5 -hls_flags delete_segments %OUTPUT_DIR%\%STREAM_FILE%

if not %ERRORLEVEL%==0 (
    echo [WARN] TCP failed or stopped. Trying UDP... (%time%)
    ffmpeg -re -fflags nobuffer -rtsp_transport udp -i %RTSP_URL% -c:v copy -c:a copy -f hls -hls_time 2 -hls_list_size 5 -hls_flags delete_segments %OUTPUT_DIR%\%STREAM_FILE%
)

echo [INFO] ffmpeg ended. Waiting %RETRY_DELAY% seconds before restart... (%time%)
timeout /t %RETRY_DELAY% /nobreak >nul
goto loop