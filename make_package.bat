@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: 1. 변수 설정 및 초기화
echo ---------------------------------------------
echo [INFO] Package Directory Initialization
echo ---------------------------------------------

set "ROOT_DIR=%~dp0"
set "PACKAGE_DIR=%ROOT_DIR%package"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "FFMPEG_DIR=%ROOT_DIR%ffmpeg"
set "CLOUDFLARE_DIR=%ROOT_DIR%cloudflare"

:: 2. 기존 패키지 폴더 삭제 후 재생성 (이전 빌드 흔적 제거)
if exist "%PACKAGE_DIR%" (
echo [INFO] Deleting previous build folder: %PACKAGE_DIR%
rd /s /q "%PACKAGE_DIR%"
)
mkdir "%PACKAGE_DIR%"
echo [INFO] Package folder created.

echo ---------------------------------------------
echo [INFO] Copying external assets to package folder...

:: 3. 환경 설정 파일 (.env) 복사 (ROOT 폴더에서 package로)
cd %BACKEND_DIR%
call generate-env.bat
cd %ROOT_DIR%

if exist "%BACKEND_DIR%\.env" (
copy "%BACKEND_DIR%\.env" "%PACKAGE_DIR%" /Y
echo [INFO] Copied .env
) else (
echo [ERROR] .env not found. Aborting script.
exit /b 1
)

:: 4. 사용자 설정 파일 (config.json) 복사 (backend 폴더에서 package로)
if exist "%BACKEND_DIR%\config.json" (
copy "%BACKEND_DIR%\config.json" "%PACKAGE_DIR%" /Y
echo [INFO] Copied config.json
) else (
echo [ERROR] config.json not found. Aborting script.
exit /b 1
)

:: 5. CCTV 목록 파일 (cctv.txt) 복사 (backend 폴더에서 package로)
if exist "%BACKEND_DIR%\cctv.txt" (
copy "%BACKEND_DIR%\cctv.txt" "%PACKAGE_DIR%" /Y
echo [INFO] Copied cctv.txt
) else (
echo [ERROR] cctv.txt not found. Aborting script.
exit /b 1
)

:: 6. ffmpeg 폴더 복사
if exist "%FFMPEG_DIR%" (
xcopy "%FFMPEG_DIR%" "%PACKAGE_DIR%\ffmpeg" /E /I /Y
echo [INFO] Copied ffmpeg folder
) else (
echo [ERROR] ffmpeg folder not found. Aborting script.
exit /b 1
)

:: 7. ffmpeg 스크립트 복사
if exist "%ROOT_DIR%\start_ffmpeg.bat" (
copy "%ROOT_DIR%\start_ffmpeg.bat" "%PACKAGE_DIR%" /Y
echo [INFO] Copied start_ffmpeg.bat
) else (
echo [ERROR] start_ffmpeg.bat not found. Aborting script.
exit /b 1
)
if exist "%ROOT_DIR%\run_single_stream.bat" (
copy "%ROOT_DIR%\run_single_stream.bat" "%PACKAGE_DIR%" /Y
echo [INFO] Copied run_single_stream.bat
) else (
echo [ERROR] run_single_stream.bat not found. Aborting script.
exit /b 1
)

:: 8. HLS 스트리밍 폴더 생성
mkdir "%PACKAGE_DIR%\hls"
echo [INFO] hls folder created.

:: 9. cloudflare 터널생성
echo ---------------------------------------------
echo [INFO] Creating Cloudflare Tunnel

:: **변경:** CUSTOMER_ID 입력을 make_package.bat에서 받습니다.
set /p CUSTOMER_ID=고객 ID (예: user1):

cd %CLOUDFLARE_DIR%
:: **변경:** CUSTOMER_ID를 인수로 전달합니다.
call make_cloudflare_package.bat %CUSTOMER_ID%
echo [INFO] Customer ID set in make_package.bat: %CUSTOMER_ID%
cd %ROOT_DIR%

:: 10. cloudflare 터널폴더 복사
if exist "%CLOUDFLARE_DIR%" (
xcopy "%CLOUDFLARE_DIR%\%CUSTOMER_ID%" "%PACKAGE_DIR%\cloudflare" /E /I /Y
echo [INFO] Copied cloudflare folder
) else (
echo [ERROR] cloudflare folder not found. Aborting script.
exit /b 1
)

:: 11. README.md 파일 복사
if exist "%ROOT_DIR%\README.md" (
copy "%ROOT_DIR%\README.md" "%PACKAGE_DIR%" /Y
echo [INFO] Copied README.md
) else (
echo [ERROR] README.md not found. Aborting script.
exit /b 1
)


:: 12. 실행 스크립트 복사
if exist "%ROOT_DIR%\cctvgo.bat" (
copy "%ROOT_DIR%\cctvgo.bat" "%PACKAGE_DIR%" /Y
echo [INFO] Copied cctvgo.bat
) else (
echo [ERROR] cctvgo.bat not found. Aborting script.
exit /b 1
)

:: 13. 프론트엔드 빌드 (frontend/dist 생성)
echo ---------------------------------------------
echo [INFO] Installing and building frontend...
cd /d "%ROOT_DIR%frontend"
echo [DEBUG] Current Directory 1 (Frontend): %CD%
call npm install
call npm run build

:: 14. 프론트엔드 빌드 결과 (frontend/dist) 복사
cd %ROOT_DIR%
if exist "frontend\dist" (
xcopy "frontend\dist" "%PACKAGE_DIR%\frontend\dist" /E /I /Y
echo [INFO] Copied frontend/dist folder
) else (
echo [ERROR] frontend/dist folder not found. Aborting script.
exit /b 1
)

:: 15. 백엔드 빌드 (Executable 생성)
echo ---------------------------------------------
echo [INFO] Installing backend dependencies and running PKG...
cd "%BACKEND_DIR%"
echo [DEBUG] Current Directory 2 (Backend): %CD%
call npm install
:: PKG 실행: 출력 경로를 ROOT_DIR의 package 폴더로 지정합니다.
call pkg server.js --targets node18-win-x64 --output "%PACKAGE_DIR%\cctvgo-service.exe"
echo !!!!!!!!!!!!!!!!!!!!!!!!!!!!!

echo ---------------------------------------------
echo [SUCCESS] Package build and assembly complete!
echo Executable is located at: %PACKAGE_DIR%\cctvgo-service.exe
echo ---------------------------------------------

pause