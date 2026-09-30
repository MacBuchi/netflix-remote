@echo off
rem Couch Remote: updates this folder to the latest release on GitHub. Double-click to run.
rem One line with exit: cmd reads batch files while running them, and the update replaces this one.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" & exit /b
