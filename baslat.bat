@echo off
chcp 65001 >nul
title Ballinc Web Sunucusu
cd /d "%~dp0"

echo ===================================================
echo   Ballinc Web Sunucusu Başlatılıyor...
echo   Adres: http://localhost:8080/
echo   Durdurmak için: Ctrl + C
echo ===================================================
echo.

:: Sunucu açıldıktan 1 saniye sonra tarayıcıda otomatik aç
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://localhost:8080/"

:: Web sunucusunu başlat
powershell -NoProfile -ExecutionPolicy Bypass -File .\serve.ps1

pause
