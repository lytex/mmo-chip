@echo off
rem Double-click shim: run the PowerShell ML-plugin installer bypassing the
rem execution policy. Everything is installed into resources\app\ml\.venv.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_ml.ps1" %*
pause
