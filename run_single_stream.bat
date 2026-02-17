:: 파일명: run_single_stream.bat

@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: 이 스크립트는 네 개의 인수를 받습니다:
:: %1=RTSP_URL, %2=OUTPUT_DIR, %3=STREAM_FILE, %4=RETRY_DELAY

set "RTSP_URL=%1"
set "OUTPUT_DIR=%~2"
set "STREAM_FILE=%~3"
set "RETRY_DELAY=%4"
set OUTPUT_FILE=!OUTPUT_DIR!\!STREAM_FILE!

:: package 폴더의 cctvgo-ffmpeg.exe 경로 설정
set "FFMPEG_EXE=%~dp0ffmpeg\bin\cctvgo-ffmpeg.exe"

echo RTSP_URL: !RTSP_URL!
echo OUTPUT_DIR: !OUTPUT_DIR!
echo STREAM_FILE: !STREAM_FILE!
echo RETRY_DELAY: !RETRY_DELAY!
echo OUTPUT_FILE: !OUTPUT_FILE!


:: 워커 스크립트의 무한 루프 시작
:single_loop
echo ---------------------------------------------
echo [%date% %time%][INFO] [!STREAM_FILE!] Trying TCP first...

:: 1. TCP 시도
"!FFMPEG_EXE!" -fflags +genpts+nobuffer+flush_packets -rtsp_transport tcp -i !RTSP_URL! -c:v copy -an -f hls -hls_time 1 -hls_list_size 3 -hls_flags delete_segments+discont_start+independent_segments !OUTPUT_FILE!
if not errorlevel 0 (
    echo [WARN] [!STREAM_FILE!] TCP failed or stopped "(Error: !ERRORLEVEL!)".
    echo [%date% %time%] "Trying UDP..."

    :: 2. UDP 시도
    "!FFMPEG_EXE!" -fflags +genpts+nobuffer+flush_packets -rtsp_transport udp -i !RTSP_URL! -c:v copy -an -f hls -hls_time 1 -hls_list_size 3 -hls_flags delete_segments+discont_start+independent_segments !OUTPUT_FILE!
)

echo [%date% %time%][INFO] [!STREAM_FILE!] cctvgo-ffmpeg ended. Waiting !RETRY_DELAY! seconds before restart...

timeout /t !RETRY_DELAY! /nobreak >nul
goto single_loop