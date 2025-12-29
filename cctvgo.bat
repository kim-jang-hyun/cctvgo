@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: 창 제목 설정
title CCTVGO 통합 관제 모니터링

:: 창 크기 고정 (가로 80, 세로 25)
mode con: cols=80 lines=25

:: 로그 폴더 생성
if not exist "logs" mkdir logs
set MAIN_LOG=logs\main_execution.log

:: --- 중복 실행 방지: 기존 프로세스 강제 종료 ---
echo =====================================================
echo   기존 프로세스 정리 및 시스템 초기화 중...
echo =====================================================
echo [%date% %time%] 시스템 재시작 (기존 프로세스 정리) >> %MAIN_LOG%

:: /F: 강제 종료, /IM: 이미지 이름 지정, /T: 자식 프로세스까지 종료
taskkill /F /IM ffmpeg.exe /T >nul 2>&1
taskkill /F /IM cloudflared.exe /T >nul 2>&1
taskkill /F /IM cctvgo-service.exe /T >nul 2>&1
timeout /t 2 > nul
echo 기존 프로세스 종료 완료.
echo.

echo =====================================================
echo   CCTVGO 통합 관제 시스템 시작 (백그라운드 모드)
echo   시작 시간: %date% %time%
echo =====================================================
echo [%date% %time%] 시스템 시작 >> %MAIN_LOG%

:: FFmpeg 스트림 모니터 실행
echo [1/3] FFmpeg HLS 스트리밍 준비 중...
:: start /b를 사용하여 새 창 없이 실행하고 로그는 별도 저장
start /b "FFmpeg_Master" cmd /c "%~dp0start_ffmpeg.bat >> %~dp0logs\ffmpeg_master.log 2>&1"
timeout /t 3 > nul

:: Cloudflare Tunnel 실행
echo [2/3] Cloudflare Tunnel 보안 연결 중...
:: start /b를 사용하여 새 창 없이 실행하고 로그는 별도 저장
start /b "Cloudflare" cmd /c "%~dp0cloudflare\start_tunnel.bat >> %~dp0logs\tunnel.log 2>&1"
timeout /t 3 > nul

:: CCTVGO Service 실행
echo [3/3] CCTVGO 메인 서비스 기동 중...
:: start /b를 사용하여 새 창 없이 실행하고 로그는 별도 저장
start /b "CCTVGO_Service" cmd /c "%~dp0cctvgo-service.exe >> %~dp0logs\service.log 2>&1"
timeout /t 3 > nul

echo.
echo -----------------------------------------------------
echo [현재 실행 프로세스 상태 점검]
echo -----------------------------------------------------

:monitor_loop
cls
echo =====================================================
echo   CCTVGO 시스템 작동 중 (이 창을 닫으면 종료됩니다)
echo   상세 로그: .\logs\ 폴더를 확인하세요.
echo =====================================================
echo.
echo [프로세스 명]          [상태]
echo -----------------------------------------------------

:: ffmpeg 체크 (여러 개일 수 있으므로 개수 표시)
:: 먼저 개수를 체크 (tasklist의 결과를 직접 변수에 담음)
set "FF_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq ffmpeg.exe" /nh ^| find /c "ffmpeg.exe"') do set "FF_COUNT=%%c"

:: 개수에 따라 출력 (if-else 구조 명확화)
if !FF_COUNT! gtr 0 (
    echo   - FFmpeg Streams     : 정상 작동 중 ^(!FF_COUNT!개^)
) else (
    echo   - FFmpeg Streams     : 오류: 작동 중지 ^^!^^!^^!
)

:: Cloudflare 체크
set "CF_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq cloudflared.exe" /nh ^| find /c "cloudflared.exe"') do set "CF_COUNT=%%c"

:: 개수에 따라 출력 (if-else 구조 명확화)
if !CF_COUNT! gtr 0 (
    echo   - Cloudflare Tunnel     : 정상 작동 중 ^(!CF_COUNT!개^)
) else (
    echo   - Cloudflare Tunnel     : 오류: 작동 중지 ^^!^^!^^!
)


:: Service 체크
set "CS_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq cctvgo-service.exe" /nh ^| find /c "cctvgo-service.exe"') do set "CS_COUNT=%%c"

:: 개수에 따라 출력 (if-else 구조 명확화)
if !CS_COUNT! gtr 0 (
    echo   - CCTVGO Service     : 정상 작동 중 ^(!CS_COUNT!개^)
) else (
    echo   - CCTVGO Service     : 오류: 작동 중지 ^^!^^!^^!
)

echo.
echo -----------------------------------------------------
echo 마지막 업데이트: !time! (30초마다 자동 갱신)
echo.
echo ※ 프로그램을 종료하시려면 우측 상단 [X] 버튼을 눌러주세요.
echo -----------------------------------------------------

:: 30초 동안 대기 (화면을 갱신하기 위한 시간 벌기)
timeout /t 30 /nobreak > nul

goto monitor_loop