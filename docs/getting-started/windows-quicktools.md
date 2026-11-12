# คู่มือการใช้งาน REA (Reverse Engineer Anything) ภาษาไทย

เครื่องมือสำหรับวิศวกรรมย้อนกลับ (Reverse Engineering) ครอบคลุมทั้ง Native Binary (C/C++), JavaScript/Electron, .NET, Android (APK), Firmware และ Web Application

---

## เปิด Quick Tools บนเครื่องที่ติดตั้งแล้ว (Windows)

ติดตั้ง REA แบบ global ด้วย `npm install -g rea-agents` แล้ว launcher จะอยู่ที่:

```text
%APPDATA%\npm\node_modules\rea-agents\tools\windows\REA-QuickTools.bat
```

เปิดใช้ได้ 3 วิธี:

1. **ดับเบิลคลิก** ไฟล์ `REA-QuickTools.bat` ใน File Explorer (จะเปิดหน้าต่างเมนูของตัวเอง)
2. **จาก cmd ที่เปิดอยู่** รัน:
   ```bat
   "%APPDATA%\npm\node_modules\rea-agents\tools\windows\REA-QuickTools.bat"
   ```
3. **สร้าง Shortcut** ไปวางบน Desktop: คลิกขวาที่ไฟล์ > Show more options > Send to > Desktop (create shortcut)

ลากไฟล์ `.exe` / `.dll` ใส่หน้าต่าง launcher ก็วิเคราะห์ได้ทันที (drag-and-drop) หรือเลือกเมนู 3 เพื่อวาง path เอง

---

## 1. การทำงานหลักของ REA

- **Decompile โค้ด Native Binary (C/C++)**: แปลงฟังก์ชัน Machine Code กลับเป็น Pseudo-C ด้วย Ghidra 12.1.4
- **วิเคราะห์โครงสร้าง PE / DLL / .NET**: อ่าน PE Header, ส่วนประกอบ Resources, Icon Group, Hash, Section และ Managed CLI metadata
- **วิเคราะห์ JavaScript / Electron / Web**: กู้คืน Source code, สร้าง Semantic Dependency Graph, ตรวจสอบ Data Flow, Call Flow และ Export ต่างๆ
- **วิเคราะห์ Android APK**: ตรวจสอบ AndroidManifest.xml, Classes, Methods, Resources
- **เชื่อมต่อผ่าน MCP Server**: ใช้งานคำสั่งร่วมกับ Agent เช่น Hermes, OpenCodex / Codex อัตโนมัติ (170 เครื่องมือ, 6 Prompts)

---

## 2. สถานะการติดตั้ง (ตรวจสอบบนเครื่องของคุณเอง)

หมายเหตุ: ค่าด้านล่างเป็นตัวอย่างรูปแบบเท่านั้น ไม่ใช่ผลตรวจของเครื่องใดเครื่องหนึ่ง — ตรวจสอบด้วยคำสั่งจริงเสมอ

| รายการ                            | วิธีตรวจสอบ                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| เวอร์ชัน REA CLI                    | `rea --version`                                                                                                   |
| Native Decompiler Engine (Ghidra) | ตั้งค่าตัวแปร `GHIDRA_INSTALL_DIR` ชี้ไปที่โฟลเดอร์ Ghidra ที่ติดตั้ง (เช่น `C:\tools\\ghidra_12.1.4_PUBLIC`) แล้วรัน `rea doctor` |
| Java Runtime                      | ตั้งค่าตัวแปร `JAVA_HOME` ชี้ไปที่ JDK ที่ติดตั้ง (Ghidra 12.1 ต้องการ JDK 21+, Ghidra 12.2 ต้องการ JDK 25+)                     |
| สถานะรวมทั้งระบบ                    | `rea doctor --client codex --client hermes`                                                                       |
| MCP Server                        | `rea mcp doctor`                                                                                                  |

---

## 3. คำสั่ง CLI ที่สำคัญ (คำสั่งด่วน)

### 3.1 การ Decompile Native Binary ด้วย Ghidra

```bash
# Decompile ฟังก์ชัน entry หรือฟังก์ชันที่ระบุในไฟล์ .exe / .dll เป็นโค้ดภาษา C
rea decompile "path/to/app.exe" entry --provider ghidra

# Decompile ฟังก์ชันตามชื่อหรือ address เช่น FUN_1400021b4
rea decompile "path/to/app.exe" FUN_1400021b4 --provider ghidra

# ค้นหา Procedure หรือฟังก์ชันใน Binary (ต้องระบุ --kind procedures มิฉะนั้นจะค้นหา strings)
rea search "path/to/app.exe" "main" --kind procedures --provider ghidra
```

### 3.2 การวิเคราะห์ PE Resource และ .NET Artifacts

```bash
# วิเคราะห์ Resource ของไฟล์ Executable (.exe, .dll)
rea inspect-pe-resources "path/to/app.exe"

# วิเคราะห์ .NET / C# Assembly
rea inspect-managed-artifact "path/to/app.dll"
```

### 3.3 การวิเคราะห์ JavaScript / Electron / Web

```bash
# วิเคราะห์โครงสร้างโปรเจกต์ JavaScript / Electron
rea analyze-javascript-application "path/to/project_or_asar"

# วิเคราะห์ Web Bundle ผ่าน CDP: เปิดเบราว์เซอร์ด้วย --remote-debugging-port=9222 ก่อน
# 1) ดูรายการ target ที่เปิดอยู่
rea list-browser-targets http://127.0.0.1:9222 --json
# 2) นำ TARGET_ID จากผลลัพธ์ข้างต้นมาวิเคราะห์
rea analyze-web-bundle http://127.0.0.1:9222 TARGET_ID --json
```

### 3.4 การตรวจสอบสถานะระบบ

```bash
# ตรวจสอบสถานะการทำงานของ REA และเครื่องมือวิเคราะห์
rea doctor --client codex --client hermes

# ตรวจสอบสถานะ MCP Server
rea mcp doctor
```
