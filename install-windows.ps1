# ==============================================================================
# Sidebar Doctor Assistant - Production Installer for Windows
# ==============================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Sidebar Doctor Assistant - Windows Production Installer"

$AppDir = $PSScriptRoot
$ServerDir = Join-Path $AppDir "server"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   Sidebar Doctor Assistant - ติดตั้งระบบบน Windows Server / PC" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. ตรวจสอบ Node.js
Write-Host "[1/4] ตรวจสอบ Node.js..." -ForegroundColor Yellow

# ตรวจหา node.exe ใน PATH ปัจจุบัน
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

# หากไม่พบใน PATH (เช่น เพิ่งติดตั้งใหม่ หรือรันเป็น Administrator ที่ยังไม่ได้โหลด PATH ของ User)
if (-not $nodeCmd) {
    $commonPaths = @(
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\nodejs",
        "$env:LOCALAPPDATA\Programs\nodejs",
        "$env:APPDATA\npm",
        "$env:APPDATA\nvm",
        "C:\Program Files\nodejs"
    )
    foreach ($dir in $commonPaths) {
        if ($dir -and (Test-Path (Join-Path $dir "node.exe"))) {
            $env:Path = "$dir;$env:Path"
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($nodeCmd) { break }
        }
    }
}

if (-not $nodeCmd) {
    Write-Host ""
    Write-Host "[ERROR] ไม่พบ Node.js ในเครื่อง!" -ForegroundColor Red
    Write-Host "กรุณาดาวน์โหลดและติดตั้ง Node.js 22 LTS จาก:" -ForegroundColor Yellow
    Write-Host "👉 https://nodejs.org/" -ForegroundColor Cyan
    Write-Host "(หากเพิ่งติดตั้งเสร็จ กรุณาปิดหน้าต่างนี้แล้วเปิดใหม่อีกครั้ง)" -ForegroundColor Gray
    Write-Host ""
    Read-Host "กด Enter เพื่อออกจากการติดตั้ง"
    exit 1
}

$nodeVersion = (& node -v).Trim()
Write-Host "✓ ตรวจพบ Node.js $nodeVersion" -ForegroundColor Green

# 2. ติดตั้ง Dependencies
Write-Host ""
Write-Host "[2/4] ติดตั้ง Server Dependencies (npm install)..." -ForegroundColor Yellow
Set-Location $ServerDir

# ตรวจสอบ npm
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    $nodeDir = Split-Path -Parent $nodeCmd.Source
    if (Test-Path (Join-Path $nodeDir "npm.cmd")) {
        $env:Path = "$nodeDir;$env:Path"
    }
}

& npm install --production --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] ติดตั้ง dependencies ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต" -ForegroundColor Red
    Read-Host "กด Enter เพื่อออกจากการติดตั้ง"
    exit 1
}

$dataDir = Join-Path $ServerDir "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
Write-Host "✓ ติดตั้ง dependencies และสร้างโฟลเดอร์ data สำเร็จ" -ForegroundColor Green

# 3. ตรวจสอบ Firewall พอร์ต 3030
Write-Host ""
Write-Host "[3/4] ตรวจสอบ Firewall พอร์ต 3030..." -ForegroundColor Yellow
$firewallRule = netsh advfirewall firewall show rule name="Sidebar Doctor Assistant" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "กำลังเพิ่มกฎ Firewall พอร์ต 3030..." -ForegroundColor Gray
    netsh advfirewall firewall add rule name="Sidebar Doctor Assistant" dir=in action=allow protocol=TCP localport=3030 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ เปิด Firewall พอร์ต 3030 เรียบร้อย" -ForegroundColor Green
    } else {
        Write-Host "! ไม่สามารถเพิ่มกฎ Firewall ได้โดยอัตโนมัติ (อาจต้องเปิดแบบ Run as Administrator)" -ForegroundColor Yellow
    }
} else {
    Write-Host "✓ กฎ Firewall พอร์ต 3030 มีอยู่แล้ว" -ForegroundColor Green
}

# 4. สรุปและเริ่มระบบ
Write-Host ""
Write-Host "[4/4] เริ่มต้นเซิร์ฟเวอร์และเปิดหน้า Setup..." -ForegroundColor Yellow
Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "   🎉 การติดตั้งเสร็จสมบูรณ์!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "• หน้าตั้งค่าระบบ (Setup Wizard):" -ForegroundColor White
Write-Host "  http://localhost:3030/setup/" -ForegroundColor Cyan
Write-Host ""
Write-Host "• หน้าดาวน์โหลดสำหรับเครื่องตรวจแพทย์:" -ForegroundColor White
Write-Host "  http://localhost:3030/install/" -ForegroundColor Cyan
Write-Host ""
Write-Host "• หากต้องการรันเป็น Windows Service ระยะยาว สามารถใช้ NSSM ได้" -ForegroundColor Gray
Write-Host "  ตามคำแนะนำในคู่มือ PRODUCTION_DEPLOYMENT_GUIDE.md" -ForegroundColor Gray
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# เปิด Browser ไปที่หน้า Setup
Start-Process "http://localhost:3030/setup/"

# เริ่มรัน Server ทันที
Write-Host "กำลังเริ่ม Server บนพอร์ต 3030... (กด Ctrl+C เพื่อหยุด)" -ForegroundColor Green
Write-Host ""
Set-Location $ServerDir
& node server.js
