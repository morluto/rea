@echo off
chcp 65001 >nul
title REA Quick Tools - Reverse Engineer Anything (Windows)
color 0A

:: ---- Analysis engine environment -------------------------------------------
:: Only set defaults when the caller has not chosen an installation already.
if not defined GHIDRA_INSTALL_DIR if exist "C:\tools\ghidra_12.1.4_PUBLIC" set "GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.1.4_PUBLIC"
if not defined JAVA_HOME if exist "C:\Program Files\Java\jdk-22" set "JAVA_HOME=C:\Program Files\Java\jdk-22"

:: ---- Locate the REA launcher -----------------------------------------------
:: Order: npm global shim on PATH, %APPDATA%\npm shim, then a source checkout
:: two levels above this script (tools\windows\ -> repo root).
set "REA_CMD="
for %%I in (rea.cmd) do if not defined REA_CMD if exist "%%~$PATH:I" set "REA_CMD=%%~$PATH:I"
if not defined REA_CMD if exist "%APPDATA%\npm\rea.cmd" set "REA_CMD=%APPDATA%\npm\rea.cmd"
if not defined REA_CMD if exist "%~dp0..\..\scripts\rea.mjs" set "REA_SOURCE=%~dp0..\..\scripts\rea.mjs"
if not defined REA_CMD if not defined REA_SOURCE goto NO_REA
goto HAVE_REA

:NO_REA
echo [ERROR] ไม่พบคำสั่ง rea ในระบบ
echo.
echo ติดตั้งก่อนด้วยคำสั่ง:  npm install -g rea-agents
echo.
pause
exit /b 1

:HAVE_REA

:: Check if a file was dragged and dropped onto this script
if not "%~1"=="" (
    set "TARGET=%~1"
    goto FILE_DROPPED
)

:MENU
cls
echo ========================================================
echo       REA - Reverse Engineer Anything (Quick Tools)
echo ========================================================
echo.
echo  [1] ตรวจสอบสถานะระบบ (rea doctor)
echo  [2] ตรวจสอบ MCP Server (rea mcp doctor)
echo  [3] ระบุพาธไฟล์ที่ต้องการวิเคราะห์
echo  [4] เปิดคู่มือภาษาไทย (thai-guide.md)
echo  [5] ออกจากโปรแกรม
echo.
echo ========================================================
set /p choice="เลือกเมนู [1-5]: "
:: stop when stdin is closed instead of looping forever
if not defined choice exit /b 0

if "%choice%"=="1" goto DOCTOR
if "%choice%"=="2" goto MCP_DOCTOR
if "%choice%"=="3" goto INPUT_PATH
if "%choice%"=="4" goto GUIDE
if "%choice%"=="5" exit /b
goto MENU

:DOCTOR
cls
echo [กำลังตรวจสอบสถานะ REA...]
call :RUN_REA doctor --client codex --client hermes
echo.
pause
goto MENU

:MCP_DOCTOR
cls
echo [กำลังตรวจสอบ MCP Server...]
call :RUN_REA mcp doctor
echo.
pause
goto MENU

:INPUT_PATH
cls
set "TARGET_INPUT="
set /p TARGET_INPUT="วางหรือพิมพ์ Path ของไฟล์ที่ต้องการวิเคราะห์: "
if not defined TARGET_INPUT goto MENU
:: Strip surrounding quotes the user may have pasted
set "TARGET=%TARGET_INPUT:"=%"
if not exist "%TARGET%" goto BAD_TARGET
goto FILE_DROPPED

:BAD_TARGET
echo.
echo ไม่พบไฟล์: "%TARGET%"
pause
goto MENU

:FILE_DROPPED
cls
echo ========================================================
echo  ไฟล์เป้าหมาย: "%TARGET%"
echo ========================================================
echo.
echo  [1] Decompile ฟังก์ชัน entry ด้วย Ghidra (C/C++)
echo  [2] Decompile ฟังก์ชันที่กำหนดเอง (ระบุชื่อ/แอดเดรส)
echo  [3] ตรวจสอบ PE Resources / Metadata (สำหรับ .exe, .dll)
echo  [4] ค้นหาข้อความ (Strings) ในไฟล์ด้วย Ghidra
echo  [5] ค้นหารายชื่อฟังก์ชัน (Procedures) ด้วย Ghidra
echo  [6] ตรวจสอบ .NET / C# Assembly
echo  [7] กลับสู่เมนูหลัก
echo.
echo ========================================================
set "file_choice="
set /p file_choice="เลือกการดำเนินการ [1-7]: "
if not defined file_choice goto MENU

if "%file_choice%"=="1" goto DO_ENTRY
if "%file_choice%"=="2" goto DO_FUNCTION
if "%file_choice%"=="3" goto DO_PE
if "%file_choice%"=="4" goto DO_STRINGS
if "%file_choice%"=="5" goto DO_PROCEDURES
if "%file_choice%"=="6" goto DO_MANAGED
if "%file_choice%"=="7" goto MENU
goto FILE_DROPPED

:DO_ENTRY
cls
echo [กำลัง Decompile ฟังก์ชัน entry ด้วย Ghidra...]
call :RUN_REA decompile "%TARGET%" entry --provider ghidra
pause
goto FILE_DROPPED

:DO_FUNCTION
set "func_name="
set /p func_name="พิมพ์ชื่อฟังก์ชันหรือ Memory Address (เช่น FUN_1400021b4): "
if not defined func_name goto FILE_DROPPED
cls
echo [กำลัง Decompile ฟังก์ชัน %func_name%...]
call :RUN_REA decompile "%TARGET%" "%func_name%" --provider ghidra
pause
goto FILE_DROPPED

:DO_PE
cls
echo [กำลังวิเคราะห์ PE Resources...]
call :RUN_REA inspect-pe-resources "%TARGET%"
pause
goto FILE_DROPPED

:DO_STRINGS
set "search_term="
set /p search_term="พิมพ์คำที่ต้องการค้นหาใน Strings: "
if not defined search_term goto FILE_DROPPED
cls
echo [กำลังค้นหาข้อความ: %search_term%...]
call :RUN_REA search "%TARGET%" "%search_term%" --kind strings --provider ghidra
pause
goto FILE_DROPPED

:DO_PROCEDURES
set "proc_term="
set /p proc_term="พิมพ์ชื่อ Procedure ที่ต้องการค้นหา: "
if not defined proc_term goto FILE_DROPPED
cls
echo [กำลังค้นหาฟังก์ชัน: %proc_term%...]
call :RUN_REA search "%TARGET%" "%proc_term%" --kind procedures --provider ghidra
pause
goto FILE_DROPPED

:DO_MANAGED
cls
echo [กำลังตรวจสอบ .NET Managed Artifact...]
call :RUN_REA inspect-managed-artifact "%TARGET%"
pause
goto FILE_DROPPED

:GUIDE
:: The installed skill ships the guide; the source checkout keeps it beside the skill.
set "GUIDE_FILE="
if exist "%APPDATA%\npm\node_modules\rea-agents\skills\reverse-engineer-anything\references\thai-guide.md" set "GUIDE_FILE=%APPDATA%\npm\node_modules\rea-agents\skills\reverse-engineer-anything\references\thai-guide.md"
if not defined GUIDE_FILE if exist "%LOCALAPPDATA%\hermes\skills\reverse-engineer-anything\references\thai-guide.md" set "GUIDE_FILE=%LOCALAPPDATA%\hermes\skills\reverse-engineer-anything\references\thai-guide.md"
if not defined GUIDE_FILE if exist "%~dp0..\..\.agents\skills\reverse-engineer-anything\references\thai-guide.md" set "GUIDE_FILE=%~dp0..\..\.agents\skills\reverse-engineer-anything\references\thai-guide.md"
if defined GUIDE_FILE goto OPEN_GUIDE
echo ไม่พบคู่มือภาษาไทยในเครื่องนี้
echo ค้นหาได้ที่: skills\reverse-engineer-anything\references\thai-guide.md
pause
goto MENU

:OPEN_GUIDE
start notepad "%GUIDE_FILE%"
goto MENU

:: ---- run rea with the resolved launcher ------------------------------------
:RUN_REA
if defined REA_CMD (
    call "%REA_CMD%" %*
    goto :eof
)
node "%REA_SOURCE%" %*
goto :eof