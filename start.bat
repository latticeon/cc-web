@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "PORT=8002"
set "HOST=127.0.0.1"

if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if /i "%%A"=="PORT" set "PORT=%%B"
        if /i "%%A"=="HOST" set "HOST=%%B"
    )
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    echo https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
)

echo Access URLs:
echo   Local: http://127.0.0.1:%PORT%
if /i "%HOST%"=="0.0.0.0" (
    setlocal EnableDelayedExpansion
    for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /R /C:"IPv4"') do (
        set "LAN_IP=%%I"
        set "LAN_IP=!LAN_IP: =!"
        if not "!LAN_IP!"=="127.0.0.1" if /i not "!LAN_IP:~0,8!"=="169.254." echo   LAN:   http://!LAN_IP!:%PORT%
    )
    endlocal
) else (
    echo   LAN:   Disabled because HOST=%HOST%
)
echo.

echo Starting CC-Web...
node server.js
pause
