@echo off
chcp 65001 >nul
title REA Quick Tools - Reverse Engineer Anything (Windows)
color 0A

:: Ensure environment variables for Ghidra and Java
if not defined GHIDRA_INSTALL_DIR (
    set "GHIDRA_INSTALL_DIR=C:\tools\ghidra_12.1.4_PUBLIC"
)
if not defined JAVA_HOME (
    set "JAVA_HOME=C:\Program Files\Java\jdk-22"
)

:: Resolve Node executable and REA script
set "NODE_EXE=C:\Users\AD PAO\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe"
set "REA_SCRIPT=C:\Users\AD PAO\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node_modules\rea-agents\scripts\rea.mjs"

:: Check if file was dragged and dropped
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

if "%choice%"=="1" goto DOCTOR
if "%choice%"=="2" goto MCP_DOCTOR
if "%choice%"=="3" goto INPUT_PATH
if "%choice%"=="4" goto GUIDE
if "%choice%"=="5" exit /b
goto MENU

:DOCTOR
cls
echo [กำลังตรวจสอบสถานะ REA...]
if exist "%NODE_EXE%" (
    "%NODE_EXE%" "%REA_SCRIPT%" doctor --client codex --client hermes
) else (
    rea doctor --client codex --client hermes
)
echo.
pause
goto MENU

:MCP_DOCTOR
cls
echo [กำลังตรวจสอบ MCP Server...]
if exist "%NODE_EXE%" (
    "%NODE_EXE%" "%REA_SCRIPT%" mcp doctor
) else (
    rea mcp doctor
)
echo.
pause
goto MENU

:INPUT_PATH
cls
set /p TARGET_INPUT="วางหรือพิมพ์ Path ของไฟล์ที่ต้องการวิเคราะห์: "
:: Strip quotes if entered by user
set "TARGET=%TARGET_INPUT:"=%"
if not exist "%TARGET%" (
    echo.
    echo ไม่พบไฟล์: "%TARGET%"
    pause
    goto MENU
)

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
set /p file_choice="เลือกการดำเนินการ [1-7]: "

if "%file_choice%"=="1" (
    cls
    echo [กำลัง Decompile ฟังก์ชัน entry ด้วย Ghidra...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" decompile "%TARGET%" entry --provider ghidra
    ) else (
        rea decompile "%TARGET%" entry --provider ghidra
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="2" (
    set /p func_name="พิมพ์ชื่อฟังก์ชันหรือ Memory Address (เช่น FUN_1400021b4): "
    cls
    echo [กำลัง Decompile ฟังก์ชัน %func_name%...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" decompile "%TARGET%" %func_name% --provider ghidra
    ) else (
        rea decompile "%TARGET%" %func_name% --provider ghidra
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="3" (
    cls
    echo [กำลังวิเคราะห์ PE Resources...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" inspect-pe-resources "%TARGET%"
    ) else (
        rea inspect-pe-resources "%TARGET%"
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="4" (
    set /p search_term="พิมพ์คำที่ต้องการค้นหาใน Strings: "
    cls
    echo [กำลังค้นหาข้อความ: %search_term%...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" search "%TARGET%" "%search_term%" --kind strings --provider ghidra
    ) else (
        rea search "%TARGET%" "%search_term%" --kind strings --provider ghidra
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="5" (
    set /p proc_term="พิมพ์ชื่อ Procedure ที่ต้องการค้นหา: "
    cls
    echo [กำลังค้นหาฟังก์ชัน: %proc_term%...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" search "%TARGET%" "%proc_term%" --kind procedures --provider ghidra
    ) else (
        rea search "%TARGET%" "%proc_term%" --kind procedures --provider ghidra
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="6" (
    cls
    echo [กำลังตรวจสอบ .NET Managed Artifact...]
    if exist "%NODE_EXE%" (
        "%NODE_EXE%" "%REA_SCRIPT%" inspect-managed-artifact "%TARGET%"
    ) else (
        rea inspect-managed-artifact "%TARGET%"
    )
    pause
    goto FILE_DROPPED
)

if "%file_choice%"=="7" goto MENU

goto FILE_DROPPED

:GUIDE
set "GUIDE_FILE=C:\Users\AD PAO\AppData\Local\hermes\skills\reverse-engineer-anything\references\thai-guide.md"
if exist "%GUIDE_FILE%" (
    start notepad "%GUIDE_FILE%"
) else (
    echo ไม่พบคู่มือภาษาไทยที่: "%GUIDE_FILE%"
    pause
)
goto MENU
