@echo off
cd /d "%~dp0"

if not exist node_modules goto INSTALL
if not exist node_modules\imapflow goto INSTALL
goto RUN

:INSTALL
echo 필요한 것들을 설치합니다. 몇 분 걸릴 수 있어요...
echo (keytar 라이브러리 때문에 빌드가 한 번 더 돌 수 있는데, 정상입니다)
call npm install
if errorlevel 1 goto INSTALL_FAIL

:RUN
echo 두레이 AI 어시스턴트를 시작합니다...
call npm start
pause
goto :EOF

:INSTALL_FAIL
echo.
echo 설치 중 오류가 발생했습니다. 이 창을 캡처해서 보내주세요.
pause
