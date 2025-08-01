@echo off
setlocal EnableDelayedExpansion

:: .env 파일이 이미 있는 경우 종료
if exist ".env" (
    echo ✅ 이미 .env 파일이 존재합니다.
    exit /b
)

:: 32바이트 랜덤 문자열 생성 (64자리 hex값)
set "charset=0123456789abcdef"
set "secret="
for /L %%i in (1,1,64) do (
    set /a index=!random! %% 16
    for %%c in (!index!) do set "secret=!secret!!charset:~%%c,1!"
)

:: .env 파일 생성
(
    echo SESSION_SECRET=!secret!
) > .env

echo ✅ .env 파일이 생성되었습니다.
endlocal
