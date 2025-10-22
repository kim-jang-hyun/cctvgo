:: 파일명: start_ffmpeg.bat

@echo off
chcp 65001 > nul
cd /d "%~dp0"

setlocal enabledelayedexpansion

:: 사용자 설정값
set RETRY_DELAY=5
set STREAM_CONFIG_FILE=cctv.txt
set SINGLE_STREAM_SCRIPT=run_single_stream.bat
set BASE_DIR=hls

:cleanup
echo ---------------------------------------------
echo [INFO] Cleaning up old HLS segments and directories...
set "CLEANUP_SUCCESS=0"

if exist "%BASE_DIR%\" (
    echo [INFO] Attempting to remove old HLS directory and its contents...
    rmdir /S /Q "%BASE_DIR%" 2>nul
    
    if not exist "%BASE_DIR%\" (
        echo [INFO] "%BASE_DIR%" directory successfully removed.
    ) else (
        echo [WARN] Could not remove "%BASE_DIR%". Check for locked files or permissions.
    )
)

echo ---------------------------------------------

:main_loop
echo [INFO] Starting all FFMPEG stream monitors... (%time%)
set "PROCESS_COUNT=0"

:: 설정 파일을 읽고 순번을 사용하여 출력 정보를 자동 생성
for /f "tokens=1 delims=, eol=#" %%a in ('type "%STREAM_CONFIG_FILE%"') do (
    
    set "RTSP_URL=%%a"

    :: 순번 증가 (자동 생성 로직)
    set /a PROCESS_COUNT+=1
    set "STREAM_NAME=stream!PROCESS_COUNT!"
    set "OUTPUT_DIR=!BASE_DIR!\!STREAM_NAME!"
    set "STREAM_FILE=!STREAM_NAME!.m3u8"

    :: 출력 디렉토리 생성
    if not exist "!OUTPUT_DIR!\" mkdir "!OUTPUT_DIR!"
    echo [INFO] Launching Monitor "!PROCESS_COUNT!: !RTSP_URL! -> !OUTPUT_DIR!\!STREAM_FILE!"

    :: 실행할 워커 스크립트의 경로를 변수에 저장 (파일 경로가 안전하도록)
    set "WORKER_PATH=%~dp0!SINGLE_STREAM_SCRIPT!"

    :: 워커 파일 (run_single_stream.bat)을 백그라운드로 실행합니다.
    start "Monitor !PROCESS_COUNT! - !STREAM_NAME!" !WORKER_PATH! "!RTSP_URL!" "!OUTPUT_DIR!" "!STREAM_FILE!" "!RETRY_DELAY!"
)


echo ---------------------------------------------
echo [INFO] All %PROCESS_COUNT% stream monitors started in background.
echo [INFO] 이 창을 닫으면 모든 스트림도 종료됩니다.
pause