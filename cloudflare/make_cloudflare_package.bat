@echo off
setlocal enabledelayedexpansion

chcp 65001

:: 사용자 입력
set CUSTOMER_ID=%~1
set DOMAIN=cctvgo.app
set PORT=8085

echo [INFO] Received Customer ID: %CUSTOMER_ID%

:: 변수 설정
set TUNNEL_NAME=tunnel_%CUSTOMER_ID%
set HOSTNAME=%CUSTOMER_ID%.%DOMAIN%
set OUTPUT_DIR=%CUSTOMER_ID%
set ZIP_FILE=%OUTPUT_DIR%.zip


:: 1. 기존 터널 존재 여부 확인 및 삭제
for /f "tokens=1" %%a in ('cloudflared.exe tunnel list ^| findstr %TUNNEL_NAME%') do (
    set EXISTING_TUNNEL_ID=%%a
)

:: 2. 기존 DNS route 삭제 시도
echo 🔁 기존 DNS route 삭제 시도: %HOSTNAME%
cloudflared.exe tunnel route dns delete %HOSTNAME% >nul 2>&1


:: 3. 터널 생성
echo 🚀 터널 생성 중: %TUNNEL_NAME%
cloudflared.exe tunnel create %TUNNEL_NAME%

:: 4. 터널 ID 추출
for /f "tokens=1" %%a in ('cloudflared.exe tunnel list ^| findstr %TUNNEL_NAME%') do (
    set TUNNEL_ID=%%a
)

:: 5. DNS 연결
echo 🌐 DNS route 등록: %HOSTNAME%
cloudflared.exe tunnel route dns %TUNNEL_NAME% %HOSTNAME%

:: 6. 고객 폴더 생성
echo 📁 고객 디렉토리 생성: %OUTPUT_DIR%
mkdir %OUTPUT_DIR%

:: 7. 인증 파일 복사
set CRED_FILE_NAME=%TUNNEL_ID%.json
set CRED_FILE_PATH=%USERPROFILE%\.cloudflared\%CRED_FILE_NAME%

if exist "%CRED_FILE_PATH%" (
    copy /Y "%CRED_FILE_PATH%" "%OUTPUT_DIR%\" >nul
) else (
    echo ❌ 인증 파일을 찾을 수 없습니다: %CRED_FILE_PATH%
    pause
    exit /b
)

:: 8. config.yml 생성
echo ⚙️ config.yml 생성
(
echo tunnel: %TUNNEL_ID%
echo credentials-file: %CRED_FILE_NAME%
echo.
echo ingress:
echo   - hostname: %HOSTNAME%
echo     service: http://localhost:%PORT%
echo   - service: http_status:404
) > %OUTPUT_DIR%\config.yml

:: 9. 실행 스크립트 생성
echo ▶️ start_tunnel.bat 생성
(
echo @echo off
echo cd /d %%~dp0
echo cloudflared.exe --config config.yml --protocol http2 tunnel run
) > %OUTPUT_DIR%\start_tunnel.bat

:: 10. cloudflared.exe 복사
if exist cloudflared.exe (
    copy /Y cloudflared.exe %OUTPUT_DIR%\cloudflared.exe >nul
)

:: 11. zip 압축
echo 📦 ZIP 압축 중: %ZIP_FILE%
powershell -Command "Compress-Archive -Path '%OUTPUT_DIR%\*' -DestinationPath '%ZIP_FILE%' -Force"

echo.
echo ✅ 완료: %ZIP_FILE% 생성됨!