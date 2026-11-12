@echo off
setlocal
cd /d "%~dp0"
title Sidebar Doctor Assistant - Windows Production Installer

:: Launch modern PowerShell installer with full UTF-8 and path discovery
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Installation script exited with error code %errorlevel%.
    pause
)
