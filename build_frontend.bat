@echo off
echo ====================================================
echo   SAGBI AGI Frontend Builder (TS to JS)
echo ====================================================

:: Node.jsの確認
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [Error] Node.js/npm is not installed.
    pause
    exit /b 1
)

echo [1/2] Installing dependencies...
call npm install

echo [2/2] Transpiling TypeScript and Bundling...
call npm run build

echo.
echo ====================================================
echo   Build Complete! 
echo   Please upload the contents of the "dist" folder 
echo   to your static hosting (Firebase, etc.)
echo ====================================================
pause
