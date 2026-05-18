@echo off
setlocal enabledelayedexpansion

echo ====================================================
echo   SAGBI AGI Build System
echo ====================================================

:: 1. Signaling Server (Go) のビルド
echo [1/3] Building Signaling Server (Go)...
cd signaling
go build -o sagbi-server.exe main.go
if %ERRORLEVEL% neq 0 (
    echo [Error] Signaling server build failed.
    exit /b %ERRORLEVEL%
)
cd ..

:: 2. Windows Installer (C++) のビルド
:: MinGW (g++) がパスに通っていることを想定しています
echo [2/3] Building Windows Installer (C++)...
cd installer
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp -lshell32 -lurlmon -luser32 -mwindows -static
if %ERRORLEVEL% neq 0 (
    echo [Error] Installer build failed.
    exit /b %ERRORLEVEL%
)
cd ..

:: 3. Frontend (React / TypeScript) のビルド
echo [3/3] Building Frontend (React/TypeScript)...
:: npm がインストールされていることを確認
call npm install
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [Error] Frontend build failed.
    exit /b %ERRORLEVEL%
)

echo ====================================================
echo   Build Complete successfully!
echo ====================================================
pause