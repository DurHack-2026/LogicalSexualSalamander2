@echo off
title Deploy Roomfit to Vultr
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-to-vultr.ps1"
echo.
pause
