@echo off
title Room For Improvement server
cd /d "%~dp0"

rem Find Node.js: first on PATH, then in the usual install folders.
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%NVM_SYMLINK%\node.exe" set "NODE=%NVM_SYMLINK%\node.exe"
if not defined NODE (
  echo Node.js is not installed.
  echo.
  echo 1. Go to https://nodejs.org and download the LTS version for Windows.
  echo 2. Run the installer and keep the default options.
  echo 3. Double-click start-roomfit.bat again.
  echo.
  pause
  exit /b 1
)

rem The 3D model bridge needs Python.
set "HASPY="
where py >nul 2>nul && set "HASPY=1"
where python >nul 2>nul && set "HASPY=1"
if not defined HASPY (
  echo Warning: Python was not found, so 3D model generation will not work.
  echo Install Python from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  echo.
)

echo Starting Room For Improvement... keep this window open while people use it.
echo Close this window to stop the server.
echo.
"%NODE%" server.js
echo.
echo Room For Improvement stopped.
pause
