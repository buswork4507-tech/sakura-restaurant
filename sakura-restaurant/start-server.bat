@echo off
chcp 65001 > nul
title Sakura Restaurant Web Server
cd /d "%~dp0"
echo ==================================================
echo   กำลังเริ่มต้นระบบ Sakura Restaurant Web Server...
echo ==================================================
node server.js
if %errorlevel% neq 0 (
  echo.
  echo [!] ไม่สามารถรันด้วย Node.js ได้ จะเปิดไฟล์ index.html บนเว็บเบราว์เซอร์แทน...
  start index.html
)
pause
