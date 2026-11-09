@echo off
setlocal
cd /d "%~dp0"
python -m PyInstaller --noconfirm --clean --distpath build\release DoctorAssistantCompanion.spec
if errorlevel 1 exit /b %errorlevel%
if not exist dist mkdir dist
copy /y "build\release\DoctorAssistantCompanion.exe" "dist\DoctorAssistantCompanion_v1_build20261109.01.exe" >nul
if errorlevel 1 exit /b %errorlevel%
echo Built: %CD%\dist\DoctorAssistantCompanion_v1_build20261109.01.exe
