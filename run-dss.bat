@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

set "PYTHONW=%PROJECT_ROOT%.venv\Scripts\pythonw.exe"
set "PYTHON=%PROJECT_ROOT%.venv\Scripts\python.exe"
set "LAUNCHER=%PROJECT_ROOT%desktop_launcher.py"

if exist "%PYTHONW%" (
    start "" "%PYTHONW%" "%LAUNCHER%"
    exit /b 0
)

if exist "%PYTHON%" (
    start "" "%PYTHON%" "%LAUNCHER%"
    exit /b 0
)

echo DSS virtual environment was not found.
echo Expected:
echo   %PYTHON%
echo.
echo Create the environment first, then run this file again.
pause
exit /b 1
