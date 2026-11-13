@echo off
chcp 65001 >nul
title BiliMusic Desktop Player
cd /d "%~dp0"
node "%~dp0player\start.mjs" %*
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [BiliMusic Player] Failed to start. Please ensure Node.js 18+ is installed.
  pause
)
