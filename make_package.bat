@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion
:: ESC char for colored result banners (Windows 10+ console)
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

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
goto FAIL
)

:: 4. 사용자 설정 파일 (config.json) 복사 (backend 폴더에서 package로)
if exist "%BACKEND_DIR%\config.json" (
copy "%BACKEND_DIR%\config.json" "%PACKAGE_DIR%" /Y
echo [INFO] Copied config.json
) else (
echo [ERROR] config.json not found. Aborting script.
goto FAIL
)

:: 5. CCTV 목록 파일 (cctv.txt) 복사 (backend 폴더에서 package로)
if exist "%BACKEND_DIR%\cctv.txt" (
copy "%BACKEND_DIR%\cctv.txt" "%PACKAGE_DIR%" /Y
echo [INFO] Copied cctv.txt
) else (
echo [ERROR] cctv.txt not found. Aborting script.
goto FAIL
)

:: 6. ffmpeg folder (used by go2rtc to convert H.265 cameras to H.264 for PC browsers)
if exist "%FFMPEG_DIR%" (
xcopy "%FFMPEG_DIR%" "%PACKAGE_DIR%\ffmpeg" /E /I /Y
echo [INFO] Copied ffmpeg folder
) else (
echo [ERROR] ffmpeg folder not found. Aborting script.
goto FAIL
)

:: 7. go2rtc (video server, MIT license). go2rtc.yaml is generated at service start, so it is not copied
if exist "%ROOT_DIR%go2rtc\go2rtc.exe" (
mkdir "%PACKAGE_DIR%\go2rtc"
copy "%ROOT_DIR%go2rtc\go2rtc.exe" "%PACKAGE_DIR%\go2rtc" /Y
copy "%ROOT_DIR%go2rtc\LICENSE.txt" "%PACKAGE_DIR%\go2rtc" /Y
echo [INFO] Copied go2rtc
) else (
echo [ERROR] go2rtc\go2rtc.exe not found. Aborting script.
goto FAIL
)

:: 9. cloudflare 터널생성
echo ---------------------------------------------
echo [INFO] Creating Cloudflare Tunnel

:: **변경:** CUSTOMER_ID 입력을 make_package.bat에서 받습니다.
:: Customer ID becomes the hostname (ID.cctvgo.app). Browsers send it in lowercase,
:: but config.yml hostname is case-sensitive, so lowercase it and reject invalid chars.
:: (Keep comments here ASCII: long Korean lines make cmd misread this UTF-8 file.)
:ASK_CUSTOMER_ID
set "CUSTOMER_ID="
set /p "CUSTOMER_ID=고객 ID (영문 소문자/숫자/-, 예: user1): "
if not defined CUSTOMER_ID goto ASK_CUSTOMER_ID
:: set substitution is case-insensitive, so replacing a with a turns A into a
for %%c in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do set "CUSTOMER_ID=!CUSTOMER_ID:%%c=%%c!"
set "ID_REST=!CUSTOMER_ID!"
for %%c in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 -) do if defined ID_REST set "ID_REST=!ID_REST:%%c=!"
set "ID_OK=1"
if defined ID_REST set "ID_OK="
if "!CUSTOMER_ID:~0,1!"=="-" set "ID_OK="
if "!CUSTOMER_ID:~-1!"=="-" set "ID_OK="
if not "!CUSTOMER_ID:~63!"=="" set "ID_OK="
if not defined ID_OK (
echo [ERROR] 고객 ID 에는 영문/숫자/-만 쓸 수 있고, -로 시작하거나 끝날 수 없습니다. ^(최대 63자^)
goto ASK_CUSTOMER_ID
)
echo [INFO] 접속 주소: https://!CUSTOMER_ID!.cctvgo.app

cd %CLOUDFLARE_DIR%
:: **변경:** CUSTOMER_ID를 인수로 전달합니다.
call make_cloudflare_package.bat %CUSTOMER_ID%
echo [INFO] Customer ID set in make_package.bat: %CUSTOMER_ID%
cd %ROOT_DIR%

:: 10. cloudflare 터널폴더 복사
if exist "%CLOUDFLARE_DIR%\%CUSTOMER_ID%" (
xcopy "%CLOUDFLARE_DIR%\%CUSTOMER_ID%" "%PACKAGE_DIR%\cloudflare" /E /I /Y
echo [INFO] Copied cloudflare folder
) else (
echo [ERROR] cloudflare\%CUSTOMER_ID% folder not found ^(tunnel creation failed^). Aborting script.
goto FAIL
)

:: 11. README.md 파일 복사
if exist "%ROOT_DIR%\README.md" (
copy "%ROOT_DIR%\README.md" "%PACKAGE_DIR%" /Y
echo [INFO] Copied README.md
) else (
echo [ERROR] README.md not found. Aborting script.
goto FAIL
)


:: 12. 실행 스크립트 복사
if exist "%ROOT_DIR%\cctvgo.bat" (
copy "%ROOT_DIR%\cctvgo.bat" "%PACKAGE_DIR%" /Y
echo [INFO] Copied cctvgo.bat
) else (
echo [ERROR] cctvgo.bat not found. Aborting script.
goto FAIL
)

:: 12-1. utils 폴더 복사
if exist "%ROOT_DIR%utils" (
:: Do not ship sample videos (*.mp4) to customers
robocopy "%ROOT_DIR%utils" "%PACKAGE_DIR%\utils" /E /XF *.mp4 /NFL /NDL /NJH /NJS /NP >nul
echo [INFO] Copied utils folder ^(*.mp4 제외^)
) else (
echo [ERROR] utils folder not found. Aborting script.
goto FAIL
)

:: 13. 프론트엔드 빌드 (frontend/dist 생성)
echo ---------------------------------------------
echo [INFO] Installing and building frontend...
cd /d "%ROOT_DIR%frontend"
echo [DEBUG] Current Directory 1 (Frontend): %CD%
call npm install
if errorlevel 1 (
echo [ERROR] frontend npm install failed. Aborting script.
goto FAIL
)
:: Remove old dist first so a failed build cannot ship a stale one
if exist "dist" rd /s /q "dist"
call npm run build
if errorlevel 1 (
echo [ERROR] frontend build failed. Aborting script.
goto FAIL
)

:: 14. 프론트엔드 빌드 결과 (frontend/dist) 복사
cd %ROOT_DIR%
if exist "frontend\dist" (
xcopy "frontend\dist" "%PACKAGE_DIR%\frontend\dist" /E /I /Y
echo [INFO] Copied frontend/dist folder
) else (
echo [ERROR] frontend/dist folder not found. Aborting script.
goto FAIL
)

:: 15. 백엔드 빌드 (Executable 생성)
echo ---------------------------------------------
echo [INFO] Installing backend dependencies and running PKG...
cd "%BACKEND_DIR%"
echo [DEBUG] Current Directory 2 (Backend): %CD%
call npm install
if errorlevel 1 (
echo [ERROR] backend npm install failed. Aborting script.
goto FAIL
)
:: PKG 실행: 출력 경로를 ROOT_DIR의 package 폴더로 지정합니다.
call pkg server.js --targets node18-win-x64 --output "%PACKAGE_DIR%\cctvgo-service.exe"
if errorlevel 1 (
echo [ERROR] pkg failed. Aborting script.
goto FAIL
)
if not exist "%PACKAGE_DIR%\cctvgo-service.exe" (
echo [ERROR] cctvgo-service.exe was not created. Aborting script.
goto FAIL
)

echo.
echo %ESC%[42;97m                                                      %ESC%[0m
echo %ESC%[42;97m   [SUCCESS] 패키지 만들기 성공                       %ESC%[0m
echo %ESC%[42;97m                                                      %ESC%[0m
echo %ESC%[92m   접속 주소: https://%CUSTOMER_ID%.cctvgo.app%ESC%[0m
echo %ESC%[92m   패키지 폴더: %PACKAGE_DIR%%ESC%[0m
echo.
pause
exit /b 0

:FAIL
cd /d "%ROOT_DIR%"
echo.
echo %ESC%[41;97m                                                      %ESC%[0m
echo %ESC%[41;97m   [FAILED] 패키지 만들기 실패                        %ESC%[0m
echo %ESC%[41;97m                                                      %ESC%[0m
echo %ESC%[91m   바로 위의 [ERROR] 줄에서 원인을 확인하세요.%ESC%[0m
echo %ESC%[91m   package 폴더는 완성되지 않았으니 쓰지 마세요.%ESC%[0m
echo.
pause
exit /b 1