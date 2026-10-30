@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: 창 제목 설정
title CCTVGO 통합 관제 모니터링

:: 창 크기 고정 (가로 80, 세로 25)
mode con: cols=80 lines=25

:: 로그 폴더 생성
if not exist "logs" mkdir logs
set LOG_DIR=%~dp0logs
set MAIN_LOG=%LOG_DIR%\main_execution.log

echo =====================================================
echo   기존 프로세스 정리 및 시스템 초기화 중...
echo =====================================================

:: --- [7일 이전 로그 삭제] ---
:: logs 폴더 안에서 7일이 지난 .log 파일을 찾아 삭제합니다.
forfiles /p "%LOG_DIR%" /m *.log /d -7 /c "cmd /c del @path" 2>nul

if %errorlevel% equ 0 (
    echo [시스템] 오래된 로그 정리 완료.
) else (
    echo [시스템] 삭제할 오래된 로그가 없습니다.
)
:: ------------------------------------------

:: --- 중복 실행 방지: 기존 프로세스 강제 종료 ---
echo [%date% %time%] 시스템 재시작 (기존 프로세스 정리) >> %MAIN_LOG%

:: /F: 강제 종료, /IM: 이미지 이름 지정, /T: 자식 프로세스까지 종료
taskkill /F /IM cctvgo-ffmpeg.exe /T >nul 2>&1
taskkill /F /IM go2rtc.exe /T >nul 2>&1
taskkill /F /IM cloudflared.exe /T >nul 2>&1
taskkill /F /IM cctvgo-service.exe /T >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq CCTVGO_NoSleep*" /T >nul 2>&1
:: 절전 모드 방지는 창 없이 실행되므로 PID 파일로 이전 프로세스를 찾아 종료
if exist "%LOG_DIR%\nosleep.pid" (
    for /f "usebackq" %%p in ("%LOG_DIR%\nosleep.pid") do taskkill /F /PID %%p /FI "IMAGENAME eq powershell.exe" >nul 2>&1
)
timeout /t 2 > nul
echo 기존 프로세스 종료 완료.
echo.

echo =====================================================
echo   CCTVGO 통합 관제 시스템 시작 (백그라운드 모드)
echo   시작 시간: %date% %time%
echo =====================================================
echo [%date% %time%] 시스템 시작 >> %MAIN_LOG%

:: 절전 모드 방지
echo [0/3] 절전 모드 방지 설정 중...
:: start /b로 이 창과 같은 콘솔에서 실행해, 이 창을 닫으면 함께 종료되게 한다
start /b "CCTVGO_NoSleep" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\prevent_sleep.ps1" "%LOG_DIR%\nosleep.heartbeat" >nul 2>&1

:: Camera video: the CCTVGO service runs go2rtc (go2rtc\go2rtc.exe) from cctv.txt.
:: Video goes from go2rtc directly to the viewer's browser (WebRTC), not through Cloudflare.

:: Cloudflare Tunnel 실행
echo [1/2] Cloudflare Tunnel 보안 연결 중...
:: Self-update cloudflared before starting the tunnel. On any failure the current exe is kept
:: and the tunnel starts as before (see utils\update_cloudflared.ps1, max ~1.5 min).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\update_cloudflared.ps1" "%~dp0cloudflare\cloudflared.exe" >> "%LOG_DIR%\tunnel.log" 2>&1
:: start /b를 사용하여 새 창 없이 실행하고 로그는 별도 저장
start /b "Cloudflare" cmd /c "%~dp0cloudflare\start_tunnel.bat >> %~dp0logs\tunnel.log 2>&1"
timeout /t 3 > nul

:: CCTVGO Service 실행
echo [2/2] CCTVGO 메인 서비스 기동 중 (카메라 영상 포함)...
:: start /b를 사용하여 새 창 없이 실행하고 로그는 별도 저장
start /b "CCTVGO_Service" cmd /c "%~dp0cctvgo-service.exe >> %~dp0logs\service.log 2>&1"
timeout /t 3 > nul

:: Windows Firewall: allow inbound to this folder's go2rtc.exe (asks UAC once, only if the rule is missing).
:: Runs in the background after the service starts, so an unanswered prompt never blocks video after a reboot.
:: If the user declines, CCTVGO still runs and we do not ask again (see logs\firewall.log, logs\firewall.declined).
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0utils\ensure_firewall.ps1" -InstallDir "%~dp0." -LogDir "%LOG_DIR%" >nul 2>&1


echo.
echo -----------------------------------------------------
echo [현재 실행 프로세스 상태 점검]
echo -----------------------------------------------------

:: 서비스와 영상은 뜨는 데 10초 이상 걸릴 수 있다. 처음 약 30초(5초 x 6회)는 없으면 "시작 중"으로 보고 자주 다시 확인한다
set "FAST_CHECKS=6"

:monitor_loop
cls
echo =====================================================
echo   CCTVGO 시스템 작동 중 (이 창을 닫으면 종료됩니다)
echo   상세 로그: .\logs\ 폴더를 확인하세요.
echo =====================================================
echo.
echo [프로세스 명]          [상태]
echo -----------------------------------------------------

:: go2rtc (video server) check
set "GO_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq go2rtc.exe" /nh ^| find /c "go2rtc.exe"') do set "GO_COUNT=%%c"

:: 등록된 카메라 수 (cctv.txt 에서 빈 줄과 # 주석을 뺀 줄 수)
set "CAM_COUNT=0"
for /f "delims=" %%a in ('powershell -NoProfile -Command "@(Get-Content -LiteralPath '%~dp0cctv.txt' -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }).Count"') do set "CAM_COUNT=%%a"

:: 개수에 따라 출력 (카메라가 0대면 영상이 없는 것이 정상)
if !GO_COUNT! gtr 0 (
    if !CAM_COUNT! equ 0 (
        echo   - 영상 서버 go2rtc   : 정상 작동 중 ^(등록된 카메라 없음 - 웹 화면 설정에서 추가^)
    ) else (
        echo   - 영상 서버 go2rtc   : 정상 작동 중 ^(카메라 !CAM_COUNT!대^)
    )
) else if !FAST_CHECKS! gtr 0 (
    echo   - 영상 서버 go2rtc   : 시작 중...
) else (
    echo   - 영상 서버 go2rtc   : 오류: 작동 중지 ^^!^^!^^!
)

:: Cloudflare 체크
set "CF_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq cloudflared.exe" /nh ^| find /c "cloudflared.exe"') do set "CF_COUNT=%%c"

:: 개수에 따라 출력 (if-else 구조 명확화)
if !CF_COUNT! gtr 0 (
    echo   - Cloudflare Tunnel   : 정상 작동 중 ^(!CF_COUNT!개^)
) else (
    echo   - Cloudflare Tunnel   : 오류: 작동 중지 ^^!^^!^^!
)

:: Service 체크
set "CS_COUNT=0"
for /f %%c in ('tasklist /fi "imagename eq cctvgo-service.exe" /nh ^| find /c "cctvgo-service.exe"') do set "CS_COUNT=%%c"

:: 개수에 따라 출력 (if-else 구조 명확화)
if !CS_COUNT! gtr 0 (
    echo   - CCTVGO Service     : 정상 작동 중 ^(!CS_COUNT!개^)
) else if !FAST_CHECKS! gtr 0 (
    echo   - CCTVGO Service     : 시작 중...
) else (
    echo   - CCTVGO Service     : 오류: 작동 중지 ^^!^^!^^!
)

:: 절전 모드 방지 체크 (PID 파일로 프로세스 생존 확인)
set "NS_OK=0"
set "NS_PID="
if exist "%LOG_DIR%\nosleep.pid" (
    for /f "usebackq" %%p in ("%LOG_DIR%\nosleep.pid") do set "NS_PID=%%p"
    if not "!NS_PID!"=="" (
        set "NS_COUNT=0"
        for /f %%c in ('tasklist /fi "PID eq !NS_PID!" /fi "IMAGENAME eq powershell.exe" /nh 2^>nul ^| find /c "powershell"') do set "NS_COUNT=%%c"
        if !NS_COUNT! gtr 0 set "NS_OK=1"
    )
)
if !NS_OK! gtr 0 (
    echo   - 절전 모드 방지     : 정상 작동 중
) else (
    echo   - 절전 모드 방지     : 오류: 작동 중지 ^^!^^!^^!
)

:: 하드웨어 자원 확인 (PowerShell 사용)0
:: 1. CPU 사용율 (정수)
for /f "delims=" %%a in ('powershell -NoProfile -Command "$v = (Get-Counter '\Processor(_Total)\%% Processor Time').CounterSamples.CookedValue; [Math]::Round($v)"') do set CPU_LOAD=%%a

:: 2. 가용 메모리 (MB)
for /f "delims=" %%a in ('powershell -NoProfile -Command "[Math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)"') do set FREE_MEM_MB=%%a

:: 3. 디스크 잔여 용량 (C: 기준, GB)
for /f "delims=" %%a in ('powershell -NoProfile -Command "[Math]::Round((Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq 'C:').FreeSpace / 1GB)"') do set DISK_FREE=%%a

:: 4. 네트워크 송신 속도 (Mbps)
for /f "delims=" %%a in ('powershell -NoProfile -Command "$n = Get-Counter '\Network Interface(*)\Bytes Sent/sec' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Sum; [Math]::Round(($n.Sum * 8) / 1MB, 2)"') do set NET_SENT=%%a

:: 5. 네트워크 스신 속도 (Mbps)
for /f "delims=" %%a in ('powershell -NoProfile -Command "$n = Get-Counter '\Network Interface(*)\Bytes Recv/sec' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Sum; [Math]::Round(($n.Sum * 8) / 1MB, 2)"') do set NET_RECV=%%a

:: [로그 파일 기록]
echo [%date% %time%] CPU:!CPU_LOAD!%% ^| Mem:!FREE_MEM_MB!MB ^| Disk:!DISK_FREE!GB ^| Net:!NET_SENT!Mbps ^| Net:!NET_RECV!Mbps >> "%LOG_DIR%\resource_usage.log"

:: [화면 출력]
echo.
echo [현재 시스템 상태]
echo   - CPU 사용율   : !CPU_LOAD! %%
echo   - 가용 메모리  : !FREE_MEM_MB! MB
echo   - 디스크 여유  : !DISK_FREE! GB
echo   - 네트웍 송신  : !NET_SENT! Mbps
echo   - 네트웍 수신  : !NET_RECV! Mbps
echo -----------------------------------------------------
echo.
echo -----------------------------------------------------
if !FAST_CHECKS! gtr 0 (
    echo 마지막 업데이트: [%date% %time%] ^(시작 확인 중, 5초마다 갱신^)
) else (
    echo 마지막 업데이트: [%date% %time%] ^(60초마다 자동 갱신^)
)
echo.
echo ※ 프로그램을 종료하시려면 우측 상단 [X] 버튼을 눌러주세요.
echo -----------------------------------------------------

:: 시작 직후에는 5초, 그 뒤로는 60초 동안 대기 (화면을 갱신하기 위한 시간 벌기)
if !FAST_CHECKS! gtr 0 (
    set /a FAST_CHECKS-=1
    timeout /t 5 /nobreak > nul
) else (
    timeout /t 60 /nobreak > nul
)

goto monitor_loop