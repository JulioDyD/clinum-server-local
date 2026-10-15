@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
if not exist "%TEMP%\opencode" exit /b 1
cl /nologo /std:c++17 /EHsc /I"%~dp0." "%~dp0reliability.cpp" /Fe:"%TEMP%\opencode\reliability-host.exe" /Fo:"%TEMP%\opencode\reliability-host.obj"
if errorlevel 1 exit /b 1
"%TEMP%\opencode\reliability-host.exe"
