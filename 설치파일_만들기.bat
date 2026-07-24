@echo off
cd /d "%~dp0"

if not exist package.json goto WRONG_PLACE
if not exist node_modules goto INSTALL
if not exist node_modules\imapflow goto INSTALL
goto BUILD

:INSTALL
echo 필요한 것들을 설치합니다. 몇 분 걸릴 수 있어요...
call npm install
if errorlevel 1 goto INSTALL_FAIL

:BUILD
echo 설치 파일(.exe)을 만듭니다. 몇 분 걸릴 수 있어요...
call npm run dist
if errorlevel 1 goto BUILD_FAIL

echo.
echo 완료되었습니다. dist 폴더를 엽니다.
start "" "%~dp0dist"
pause
goto :EOF

:WRONG_PLACE
echo.
echo 이 파일은 dooray-assistant 폴더 안에서 실행해야 해요.
echo (이 파일만 따로 복사해서 실행하면 동작하지 않습니다)
pause
goto :EOF

:INSTALL_FAIL
echo.
echo 설치 중 오류가 발생했습니다. 이 창을 캡처해서 보내주세요.
pause
goto :EOF

:BUILD_FAIL
echo.
echo 생성 중 오류가 발생했습니다. 이 창을 캡처해서 보내주세요.
pause
