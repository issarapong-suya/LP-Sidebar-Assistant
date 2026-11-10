@echo off
chcp 65001 >nul
title Sidebar Doctor Assistant Server
cd /d "%~dp0server"
echo กำลังเริ่มต้น Sidebar Doctor Assistant Server...
echo เปิดหน้าตั้งค่า: http://localhost:3030/setup/
echo.
npm start
pause
