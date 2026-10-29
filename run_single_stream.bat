:: 파일명: run_single_stream.bat

@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: 이 스크립트는 세 개의 인수를 받습니다 (RTSP_URL은 & 등이 깨지지 않도록 환경 변수 STREAM_URL로 전달됩니다):
:: %1=OUTPUT_DIR, %2=STREAM_FILE, %3=RETRY_DELAY

set "RTSP_URL=!STREAM_URL!"
set "OUTPUT_DIR=%~1"
set "STREAM_FILE=%~2"
set "RETRY_DELAY=%3"
set OUTPUT_FILE=!OUTPUT_DIR!\!STREAM_FILE!

:: package 폴더의 cctvgo-ffmpeg.exe 경로 설정
set "FFMPEG_EXE=%~dp0ffmpeg\bin\cctvgo-ffmpeg.exe"

:: 주소에는 카메라 비밀번호가 들어 있어 로그에 남기지 않는다
echo RTSP_URL: (보안을 위해 표시하지 않음)
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