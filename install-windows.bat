@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Sidebar Doctor Assistant - Windows Production Installer

echo ==================================================================
echo    Sidebar Doctor Assistant - ติดตั้งระบบบน Windows Server / PC
echo ==================================================================
echo.

:: 1. ตรวจสอบ Node.js
echo [1/4] ตรวจสอบ Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] ไม่พบ Node.js ในเครื่อง!
    echo กรุณาดาวน์โหลดและติดตั้ง Node.js 22 LTS จาก:
    echo 👉 https://nodejs.org/
    echo (เมื่อติดตั้งเสร็จแล้ว ให้เปิดรันไฟล์ install-windows.bat นี้ใหม่อีกครั้ง)
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo ✓ ตรวจพบ Node.js %NODE_VERSION%

:: 2. ติดตั้ง Dependencies
echo.
echo [2/4] ติดตั้ง Server Dependencies (npm install)...
cd /d "%~dp0server"
call npm install --production --no-audit --no-fund
if %errorlevel% neq 0 (
    echo [ERROR] ติดตั้ง dependencies ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต
    pause
    exit /b 1
)
if not exist "data" mkdir "data"

:: 3. เปิด Firewall Port 3030
echo.
echo [3/4] ตรวจสอบ Firewall พอร์ต 3030...
netsh advfirewall firewall show rule name="Sidebar Doctor Assistant" >nul 2>nul
if %errorlevel% neq 0 (
    echo กำลังเพิ่มกฎ Firewall พอร์ต 3030...
    netsh advfirewall firewall add rule name="Sidebar Doctor Assistant" dir=in action=allow protocol=TCP localport=3030 >nul 2>nul
    if %errorlevel% equ 0 (
        echo ✓ เปิด Firewall พอร์ต 3030 เรียบร้อย
    ) else (
        echo ! ไม่สามารถเพิ่มกฎ Firewall ได้โดยอัตโนมัติ (อาจต้องรันในฐานะ Run as Administrator)
    )
) else (
    echo ✓ กฎ Firewall พอร์ต 3030 มีอยู่แล้ว
)

:: 4. สรุปและเริ่มระบบ
echo.
echo [4/4] เริ่มต้นเซิร์ฟเวอร์และเปิดหน้า Setup...
echo.
echo ==================================================================
echo    🎉 การติดตั้งเสร็จสมบูรณ์!
echo ==================================================================
echo.
echo • หน้าตั้งค่าระบบ (Setup Wizard):
echo   http://localhost:3030/setup/
echo.
echo • หน้าดาวน์โหลดสำหรับเครื่องตรวจแพทย์:
echo   http://localhost:3030/install/
echo.
echo • หากต้องการรันเป็น Windows Service ระยะยาว สามารถใช้ NSSM ได้
echo   ตามคำแนะนำในคู่มือ PRODUCTION_DEPLOYMENT_GUIDE.md
echo ==================================================================
echo.

:: เปิด Browser ไปที่หน้า Setup
start http://localhost:3030/setup/

:: เริ่มรัน Server ทันที
echo กำลังเริ่ม Server บนพอร์ต 3030... (กด Ctrl+C เพื่อหยุด)
echo.
node server.js
