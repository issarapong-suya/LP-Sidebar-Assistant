@echo off
setlocal
cd /d "%~dp0"
pyinstaller --clean --noconfirm DoctorAssistantCompanion.spec
endlocal
