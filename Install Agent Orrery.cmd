@echo off
rem Double-click to set up Agent Orrery: installs what it needs, adds the Desktop and
rem Start-menu shortcuts, and opens the app. Run it again after moving this folder.
rem No parenthesized blocks: the folder path may contain ( ) or &.
setlocal
pushd "%~dp0"
where node >nul 2>nul || goto no_node
node scripts\setup.mjs %*
if errorlevel 1 goto failed
popd
exit /b 0

:no_node
echo Agent Orrery needs Node.js 22.12 or newer. Install it from https://nodejs.org, then run this again.
pause
exit /b 1

:failed
echo.
echo Setup did not finish. The messages above say why.
pause
exit /b 1
