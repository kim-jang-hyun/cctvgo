@echo off
chcp 65001 > nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

set RETRY_DELAY=5
set STREAM_CONFIG_FILE=cctv.txt
set SINGLE_STREAM_SCRIPT=run_single_stream.bat
set BASE_DIR=hls

:: 폴더 정리 (기존 코드 유지)
if exist "%BASE_DIR%\" rmdir /S /Q "%BASE_DIR%" 2>nul

echo [%date% %time%][INFO] Starting all FFMPEG stream monitors...
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
    echo [%date% %time%][INFO] Launching Monitor "!PROCESS_COUNT!: !RTSP_URL! -> !OUTPUT_DIR!\!STREAM_FILE!"
    
    :: /b 옵션으로 창 숨기고 로그 파일 생성
    set "STREAM_URL=!RTSP_URL!"
    start /b "Stream_!PROCESS_COUNT!" cmd /c "%~dp0!SINGLE_STREAM_SCRIPT! ^"!OUTPUT_DIR!^" ^"!STREAM_FILE!^" ^"!RETRY_DELAY!^" >> ^"%~dp0logs\stream_!PROCESS_COUNT!.log^" 2>&1"
)
echo ---------------------------------------------
echo [%date% %time%][INFO] All %PROCESS_COUNT% stream monitors started in background.
