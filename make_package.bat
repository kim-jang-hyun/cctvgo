@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

:: ---------------------------------------------
:: 1. 변수 설정 및 초기화
:: ---------------------------------------------
echo ---------------------------------------------
echo [INFO] Package Directory Initialization
echo ---------------------------------------------

set "ROOT_DIR=%~dp0"
set "PACKAGE_DIR=%ROOT_DIR%package"
set "BACKEND_DIR=%ROOT_DIR%backend"

:: ---------------------------------------------
:: 2. 외부 파일 복사
:: ---------------------------------------------

:: A. 기존 패키지 폴더 삭제 후 재생성 (이전 빌드 흔적 제거)
if exist "%PACKAGE_DIR%" (
echo [INFO] Deleting previous build folder: %PACKAGE_DIR%
rd /s /q "%PACKAGE_DIR%"
)
mkdir "%PACKAGE_DIR%"
echo [INFO] Package folder created.

echo ---------------------------------------------
echo [INFO] Copying external assets to package folder...

:: B. 환경 설정 파일 (.env) 복사 (ROOT 폴더에서 package로)
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

:: C. 사용자 설정 파일 (config.json) 복사 (backend 폴더에서 package로)
if exist "%BACKEND_DIR%\config.json" (
copy "%BACKEND_DIR%\config.json" "%PACKAGE_DIR%" /Y
echo [INFO] Copied config.json
) else (
echo [ERROR] config.json not found. Aborting script.
exit /b 1
)

:: D. CCTV 목록 파일 (cctv.txt) 복사 (ROOT 폴더에서 package로)
if exist "cctv.txt" (
copy "cctv.txt" "%PACKAGE_DIR%" /Y
echo [INFO] Copied cctv.txt
) else (
echo [ERROR] cctv.txt not found. Aborting script.
exit /b 1
)

:: E. HLS 스트리밍 폴더 복사
if exist "hls" (
xcopy "hls" "%PACKAGE_DIR%\hls" /E /I /Y
echo [INFO] Copied hls folder
) else (
echo [ERROR] hls folder not found. Aborting script.
exit /b 1
)

:: ---------------------------------------------
:: 3. 프론트엔드 빌드 (frontend/dist 생성)
:: ---------------------------------------------
echo ---------------------------------------------
echo [INFO] Installing and building frontend...
cd /d "%ROOT_DIR%frontend"
echo [DEBUG] Current Directory 1 (Frontend): %CD%
call npm install
call npm run build

:: A. 프론트엔드 빌드 결과 (frontend/dist) 복사
cd %ROOT_DIR%
if exist "frontend\dist" (
xcopy "frontend\dist" "%PACKAGE_DIR%\frontend\dist" /E /I /Y
echo [INFO] Copied frontend/dist folder
) else (
echo [ERROR] frontend/dist folder not found. Aborting script.
exit /b 1
)

:: ---------------------------------------------
:: 4. 백엔드 빌드 (Executable 생성)
:: ---------------------------------------------
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