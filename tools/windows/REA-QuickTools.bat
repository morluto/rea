@echo off
setlocal EnableExtensions
chcp 65001 >nul
title REA Quick Tools - Reverse Engineer Anything (Windows)
color 0A

:: ---- Analysis engine environment -------------------------------------------
:: Only set defaults when the caller has not chosen an installation already.
:: Everything below runs inside this setlocal, so no assignment leaks into the
:: calling shell when the launcher exits.
if not defined GHIDRA_INSTALL_DIR if exist "C:\tools\ghidra_12.1.4_PUBLIC" set "GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.1.4_PUBLIC"
if not defined JAVA_HOME if exist "C:\Program Files\Java\jdk-22" set "JAVA_HOME=C:\Program Files\Java\jdk-22"

:: ---- Locate the REA CLI ------------------------------------------------------
:: Preferred: node.exe plus the packaged rea.mjs entry, executed directly so a
:: child process cannot replace this menu and percent signs in analyst-provided
:: paths survive untouched. Fallback: the npm global rea.cmd shim via CALL,
:: which keeps the original launcher behavior when the entry cannot be located.
set "NODE_EXE="
for %%I in (node.exe) do if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"
set "REA_ENTRY="
if defined NODE_EXE for %%D in ("%APPDATA%\npm\node_modules\rea-agents" "%~dp0..\..") do if not defined REA_ENTRY if exist "%%~D\scripts\rea.mjs" set "REA_ENTRY=%%~D\scripts\rea.mjs"
if defined REA_ENTRY goto HAVE_REA
set "REA_CMD="
for %%I in (rea.cmd) do if not defined REA_CMD if exist "%%~$PATH:I" set "REA_CMD=%%~$PATH:I"
if not defined REA_CMD if exist "%APPDATA%\npm\rea.cmd" set "REA_CMD=%APPDATA%\npm\rea.cmd"
if not defined REA_CMD goto NO_REA
goto HAVE_REA

:NO_REA
echo [ERROR] ไม่พบคำสั่ง rea ในระบบ
echo.
echo ติดตั้งก่อนด้วยคำสั่ง:  npm install -g rea-agents
echo แล้วตรวจสอบด้วย:       rea doctor
echo.
pause
exit /b 1

:HAVE_REA

:: Capture a dragged-and-dropped target BEFORE enabling delayed expansion so
:: the raw argument is stored literally (no percent or exclamation re-expansion).
:: Explorer strips nothing; %~1 removes the surrounding quotes it adds, and
:: Windows filenames cannot contain quote characters, so the line stays safe.
set "TARGET=%~1"
set "HAS_ARG="
if not "%~1"=="" set "HAS_ARG=1"

:: Every interactive path from here on references analyst-provided values only
:: through delayed expansion (!VAR!), which cmd substitutes after parsing: menu
:: input, pasted paths and search terms can therefore not inject commands.
setlocal EnableDelayedExpansion

if defined HAS_ARG goto FILE_DROPPED

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
set "choice="
set /p choice="เลือกเมนู [1-5]: "
:: stop when stdin is closed instead of looping forever
if not defined choice exit /b 0

if "!choice!"=="1" goto DOCTOR
if "!choice!"=="2" goto MCP_DOCTOR
if "!choice!"=="3" goto INPUT_PATH
if "!choice!"=="4" goto GUIDE
if "!choice!"=="5" exit /b
goto MENU

:DOCTOR
cls
echo [กำลังตรวจสอบสถานะ REA...]
set "REA_ARGS=doctor --client codex --client hermes"
call :RUN_REA
echo.
pause
goto MENU

:MCP_DOCTOR
cls
echo [กำลังตรวจสอบ MCP Server...]
set "REA_ARGS=mcp doctor"
call :RUN_REA
echo.
pause
goto MENU

:INPUT_PATH
cls
set "TARGET_INPUT="
set /p TARGET_INPUT="วางหรือพิมพ์ Path ของไฟล์ที่ต้องการวิเคราะห์: "
if not defined TARGET_INPUT goto MENU
:: Strip surrounding quotes the user may have pasted; delayed expansion keeps
:: ampersands and percent signs in the value literal.
set "TARGET=!TARGET_INPUT:"=!"
if not exist "!TARGET!" goto BAD_TARGET
goto FILE_DROPPED

:BAD_TARGET
echo.
echo ไม่พบไฟล์: "!TARGET!"
pause
goto MENU

:FILE_DROPPED
cls
echo ========================================================
echo  ไฟล์เป้าหมาย: "!TARGET!"
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

if "!file_choice!"=="1" goto DO_ENTRY
if "!file_choice!"=="2" goto DO_FUNCTION
if "!file_choice!"=="3" goto DO_PE
if "!file_choice!"=="4" goto DO_STRINGS
if "!file_choice!"=="5" goto DO_PROCEDURES
if "!file_choice!"=="6" goto DO_MANAGED
if "!file_choice!"=="7" goto MENU
goto FILE_DROPPED

:DO_ENTRY
cls
echo [กำลัง Decompile ฟังก์ชัน entry ด้วย Ghidra...]
set "REA_ARGS=decompile "!TARGET!" entry --provider ghidra"
call :RUN_REA
pause
goto FILE_DROPPED

:DO_FUNCTION
set "FUNC_NAME="
set /p FUNC_NAME="พิมพ์ชื่อฟังก์ชันหรือ Memory Address (เช่น FUN_1400021b4): "
if not defined FUNC_NAME goto FILE_DROPPED
cls
echo [กำลัง Decompile ฟังก์ชันตามชื่อที่ระบุ...]
set "REA_ARGS=decompile "!TARGET!" "!FUNC_NAME!" --provider ghidra"
call :RUN_REA
pause
goto FILE_DROPPED

:DO_PE
cls
echo [กำลังวิเคราะห์ PE Resources...]
set "REA_ARGS=inspect-pe-resources "!TARGET!""
call :RUN_REA
pause
goto FILE_DROPPED

:DO_STRINGS
set "SEARCH_TERM="
set /p SEARCH_TERM="พิมพ์คำที่ต้องการค้นหาใน Strings: "
if not defined SEARCH_TERM goto FILE_DROPPED
cls
echo [กำลังค้นหาข้อความใน Strings...]
set "REA_ARGS=search "!TARGET!" "!SEARCH_TERM!" --kind strings --provider ghidra"
call :RUN_REA
pause
goto FILE_DROPPED

:DO_PROCEDURES
set "PROC_TERM="
set /p PROC_TERM="พิมพ์ชื่อ Procedure ที่ต้องการค้นหา: "
if not defined PROC_TERM goto FILE_DROPPED
cls
echo [กำลังค้นหาฟังก์ชันตามชื่อที่ระบุ...]
set "REA_ARGS=search "!TARGET!" "!PROC_TERM!" --kind procedures --provider ghidra"
call :RUN_REA
pause
goto FILE_DROPPED

:DO_MANAGED
cls
echo [กำลังตรวจสอบ .NET Managed Artifact...]
set "REA_ARGS=inspect-managed-artifact "!TARGET!""
call :RUN_REA
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
start notepad "!GUIDE_FILE!"
goto MENU

:: ---- run rea with the resolved launcher ------------------------------------
:: REA_ARGS is built with delayed expansion at the action sites. Expanding it
:: once here keeps operator and percent characters inside the value literal;
:: analyst input never travels through the parse-time %* expansion.
:RUN_REA
if defined REA_ENTRY (
    "%NODE_EXE%" "%REA_ENTRY%" !REA_ARGS!
    goto :eof
)
:: The shim fallback re-expands percents once (inherent to npm .cmd shims).
call "%REA_CMD%" !REA_ARGS!
goto :eof
