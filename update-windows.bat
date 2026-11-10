@echo off
chcp 65001 >nul
setlocal
title Sidebar Doctor Assistant - Update from GitHub

echo ==================================================================
echo    Sidebar Doctor Assistant - อัปเดตระบบจาก GitHub
echo ==================================================================
echo.

cd /d "%~dp0"
echo [1/2] ดึงข้อมูลเวอร์ชันล่าสุดจาก GitHub (git pull)...
git pull origin main
if %errorlevel% neq 0 (
    echo [ERROR] ไม่สามารถ pull ข้อมูลจาก GitHub ได้ กรุณาตรวจสอบการเชื่อมต่อ
    pause
    exit /b 1
)

echo.
echo [2/2] ตรวจสอบ dependencies...
cd /d "%~dp0server"
call npm install --production --no-audit --no-fund

echo.
echo ==================================================================
echo    ✓ อัปเดตโค้ดเวอร์ชันล่าสุดเสร็จสมบูรณ์!
echo ==================================================================
echo * หากรันผ่านหน้าจอ cmd เดิม ให้ปิดแล้วเปิด start-server.bat ใหม่
echo * หากรันเป็น Windows Service ผ่าน NSSM ให้พิมพ์คำสั่ง:
echo   nssm restart DoctorAssistantService
echo ==================================================================
echo.
pause
