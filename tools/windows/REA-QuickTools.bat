@echo off
setlocal EnableExtensions

:: ---- Own console for the interactive session ------------------------------
:: chcp, title and color mutate console state that setlocal cannot restore,
:: so the UI runs in a dedicated console window that closes on exit; the
:: caller's console keeps its code page, title and colors. The child marks
:: itself with a sentinel first argument (an absolute dropped path can never
:: equal it).
if /i "%~1"=="__REA_CHILD__" (
    shift
    goto REA_CHILD
)
:: Automation (and piped stdin) skips the console relaunch: REA_TEST_INLINE
:: runs the menu in the calling console instead of a dedicated window.
if defined REA_TEST_INLINE goto REA_CHILD
start "REA Quick Tools" cmd /d /c ""%~f0" __REA_CHILD__ %1
exit /b 0

:REA_CHILD
chcp 65001 >nul
title REA Quick Tools - Reverse Engineer Anything (Windows)
color 0A

:: ---- Analysis engine environment -------------------------------------------
:: Only set defaults when the caller has not chosen an installation already.
:: Everything below runs inside this setlocal, so no assignment leaks into the
:: calling shell when the launcher exits.
if not defined GHIDRA_INSTALL_DIR if exist "C:\tools\ghidra_12.1.4_PUBLIC" set "GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.1.4_PUBLIC"
:: No JAVA_HOME guessing here: release identity and java.exe selection
:: belong to REA's GhidraInstallation (doctor reads the real release and
:: probes java.exe from PATH); the launcher only suggests the directory.

:: ---- Locate the REA CLI ------------------------------------------------------
:: node.exe plus the packaged rea.mjs entry, executed directly: control returns
:: to the menu, a child process cannot replace it, and percent signs in
:: analyst-provided paths survive untouched. The npm rea.cmd shim is NOT used
:: as a fallback because CALL would re-parse the reconstructed arguments.
set "NODE_EXE="
for %%I in (node.exe) do if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"
set "REA_ENTRY="
if defined NODE_EXE for %%D in ("%APPDATA%\npm\node_modules\rea-agents" "%~dp0..\..") do if not defined REA_ENTRY if exist "%%~D\scripts\rea.mjs" set "REA_ENTRY=%%~D\scripts\rea.mjs"
if not defined REA_ENTRY goto NO_REA
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
:: Delayed expansion consumes ! in values it expands, so an install location
:: containing ! cannot be dispatched reliably; fail closed with guidance.
set "BANG_CHECK=%NODE_EXE%%REA_ENTRY%"
if not "%BANG_CHECK%"=="%BANG_CHECK:!=%" goto NO_BANG
goto CAPTURE

:NO_BANG
echo [ERROR] ตำแหน่งติดตั้งมีอักขระ ! ซึ่ง launcher ของ Windows รองรับไม่ได้
echo ติดตั้ง REA ในโฟลเดอร์ที่ไม่มีอักขระ ! แล้วลองใหม่
echo.
pause
exit /b 1

:CAPTURE

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
:: A leading-dash symbol would parse as an option; the decompile contract's
:: --procedure=<value> selector routes it as the function name.
:: Selector dispatch: the symbol crosses to the child inside a FOR-carrier
:: ("!FUNC_NAME!" -> quoted %%P), which preserves every byte (quotes,
:: spaces) as ONE argv entry; an options-shaped symbol routes through the
:: documented --procedure= selector. An &-containing symbol cannot cross
:: any cmd exec boundary intact and is dispatched raw (safe: & stays data;
:: the CLI reports the surplus positional with a clear error).
call :SCAN_VALUE "FUNC_NAME"
if defined META_VALUE (
    set "REA_ARGS=decompile "!TARGET!" !FUNC_NAME! --provider ghidra"
    call :RUN_REA
) else if "!FUNC_NAME:~0,1!"=="-" (
    for %%P in ("--procedure=!FUNC_NAME!") do "%NODE_EXE%" "%REA_ENTRY%" decompile "!TARGET!" %%P --provider ghidra
) else (
    for %%P in ("!FUNC_NAME!") do "%NODE_EXE%" "%REA_ENTRY%" decompile "!TARGET!" %%P --provider ghidra
)
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
:: A leading-dash term such as --help would parse as an option; the CLI's
:: documented selector form --pattern=<value> routes it as the pattern.
:: Selector dispatch (same rules as the function search): the needle
:: crosses to the child inside a FOR-carrier (quoted %%P), preserving
:: every byte as ONE argv entry; an options-shaped needle routes through
:: --pattern=<value>; an &-containing needle is dispatched raw (safe).
:: Selector boundary: the charset scan rejects any value carrying cmd
:: metacharacters (" ^ %% ! & | < >) -- the same set the repository batch
:: boundary rejects -- so the quoted FOR-carrier below only ever receives
:: values cmd cannot reparse. Rejected values dispatch raw through
:: :RUN_REA (safe: they stay data; the CLI reports the surplus positional).
call :SCAN_VALUE "SEARCH_TERM"
if defined META_VALUE (
    set "REA_ARGS=search "!TARGET!" !SEARCH_TERM! --kind strings --provider ghidra"
    call :RUN_REA
) else if "!SEARCH_TERM:~0,1!"=="-" (
    for %%P in ("--pattern=!SEARCH_TERM!") do "%NODE_EXE%" "%REA_ENTRY%" search "!TARGET!" %%P --kind strings --provider ghidra
) else (
    for %%P in ("!SEARCH_TERM!") do "%NODE_EXE%" "%REA_ENTRY%" search "!TARGET!" %%P --kind strings --provider ghidra
)
pause
goto FILE_DROPPED

:DO_PROCEDURES
set "PROC_TERM="
set /p PROC_TERM="พิมพ์ชื่อ Procedure ที่ต้องการค้นหา: "
if not defined PROC_TERM goto FILE_DROPPED
call :SCAN_VALUE "PROC_TERM"
if defined META_VALUE (
    set "REA_ARGS=search "!TARGET!" !PROC_TERM! --kind procedures --provider ghidra"
    call :RUN_REA
) else if "!PROC_TERM:~0,1!"=="-" (
    for %%P in ("--pattern=!PROC_TERM!") do "%NODE_EXE%" "%REA_ENTRY%" search "!TARGET!" %%P --kind procedures --provider ghidra
) else (
    for %%P in ("!PROC_TERM!") do "%NODE_EXE%" "%REA_ENTRY%" search "!TARGET!" %%P --kind procedures --provider ghidra
)
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
if exist "%APPDATA%\npm\node_modules\rea-agents\docs\windows-quicktools.md" set "GUIDE_FILE=%APPDATA%\npm\node_modules\rea-agents\docs\windows-quicktools.md"
if not defined GUIDE_FILE if exist "%~dp0..\..\docs\windows-quicktools.md" set "GUIDE_FILE=%~dp0..\..\docs\windows-quicktools.md"
if defined GUIDE_FILE goto OPEN_GUIDE
echo ไม่พบคู่มือภาษาไทยในเครื่องนี้
echo ค้นหาได้ที่: docs\windows-quicktools.md ในโฟลเดอร์ติดตั้ง
pause
goto MENU

:OPEN_GUIDE
start notepad "!GUIDE_FILE!"
goto MENU

:: ---- selector charset scan -------------------------------------------------
:: Splits no value: walks %1-named variable one char at a time and rejects
:: any character outside the safe set. Sets META_VALUE=1 when a cmd
:: metacharacter (" ^ %% ! & | < >) or ! is present, clears it otherwise;
:: rejected values keep every byte and cross through :RUN_REA raw.
:SCAN_VALUE
set "META_VALUE="
set "SCAN_REST=!%~1!"
:: ! anywhere: reject (delayed expansion consumes it); quotes are rejected
:: too: they cannot be tested per-char without reparse-prone constructions
:: (the CLI pattern/procedure values accept these characters, but the
:: launcher surfaces them raw through :RUN_REA instead, where they stay
:: data and the CLI reports the surplus positional).
set "SCAN_SAFE=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .:-_()[]{}^+*=@/,~?""
goto SCAN_LOOP

:SCAN_LOOP
if not defined SCAN_REST goto SCAN_DONE
set "SCAN_CH=!SCAN_REST:~0,1!"
for %%C in ("!SCAN_CH!") do if "!SCAN_SAFE:%%~C=!"=="!SCAN_SAFE!" set "META_VALUE=1"
set "SCAN_REST=!SCAN_REST:~1!"
goto SCAN_LOOP

:SCAN_DONE
set "SCAN_REST="
set "SCAN_SAFE="
set "SCAN_CH="
goto :eof

:: ---- run rea with the resolved launcher ------------------------------------
:: REA_ARGS is built with delayed expansion at the action sites. Expanding it
:: once here keeps operator and percent characters inside the value literal;
:: analyst input never travels through the parse-time %* expansion.
:RUN_REA
:: REA_ARGS is built with delayed expansion at the action sites and is
:: dispatched with !RARGS! on a delayed line: operator characters stay data
:: and analyst input never travels through the parse-time %* expansion.
:: NODE_EXE and REA_ENTRY contain no ! (pre-flight above), so their
:: parse-time expansion is safe inside this delayed scope. No endlocal here:
:: the menus after an action keep their delayed expansion.
"%NODE_EXE%" "%REA_ENTRY%" !REA_ARGS!
goto :eof
