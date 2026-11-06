$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'ไม่พบ npm กรุณาติดตั้ง Node.js LTS ก่อน'
}
npm install --omit=dev
Write-Host 'Dependencies installed. Run start-server.bat to start the service.'
