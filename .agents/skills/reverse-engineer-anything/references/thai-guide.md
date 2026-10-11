# คู่มือการใช้งาน REA (Reverse Engineer Anything) ภาษาไทย

เครื่องมือสำหรับวิศวกรรมย้อนกลับ (Reverse Engineering) ครอบคลุมทั้ง Native Binary (C/C++), JavaScript/Electron, .NET, Android (APK), Firmware และ Web Application

---

## 1. การทำงานหลักของ REA
- **Decompile โค้ด Native Binary (C/C++)**: แปลงฟังก์ชัน Machine Code กลับเป็น Pseudo-C ด้วย Ghidra 12.1.4
- **วิเคราะห์โครงสร้าง PE / DLL / .NET**: อ่าน PE Header, ส่วนประกอบ Resources, Icon Group, Hash, Section และ Managed CLI metadata
- **วิเคราะห์ JavaScript / Electron / Web**: กู้คืน Source code, สร้าง Semantic Dependency Graph, ตรวจสอบ Data Flow, Call Flow และ Export ต่างๆ
- **วิเคราะห์ Android APK**: ตรวจสอบ AndroidManifest.xml, Classes, Methods, Resources
- **เชื่อมต่อผ่าน MCP Server**: ใช้งานคำสั่งร่วมกับ Agent เช่น Hermes, OpenCodex / Codex อัตโนมัติ (170 เครื่องมือ, 6 Prompts)

---

## 2. สถานะการติดตั้งในระบบปัจจุบัน
- **REA CLI & MCP**: เวอร์ชัน 6.4.0 (Global npm package)
- **Native Decompiler Engine**: **Ghidra 12.1.4** ติดตั้งที่ `C:	ools\ghidra_12.1.4_PUBLIC` (พร้อม Environment Variable `GHIDRA_INSTALL_DIR`)
- **Java Runtime**: Java JDK 22.0.1 (`C:\Program Files\Java\jdk-22`)
- **Agent Integration**:
  - **Codex**: `~/.codex/config.toml` (สถานะ: aligned พร้อม GHIDRA env)
  - **Hermes**: `~/.hermes/config.yaml` (สถานะ: aligned พร้อม GHIDRA env)
  - **OpenCodex Proxy**: รันอยู่ที่ `http://127.0.0.1:10100`

---

## 3. คำสั่ง CLI ที่สำคัญ (คำสั่งด่วน)

### 3.1 การ Decompile Native Binary ด้วย Ghidra
```bash
# Decompile ฟังก์ชัน entry หรือฟังก์ชันที่ระบุในไฟล์ .exe / .dll เป็นโค้ดภาษา C
rea decompile "path/to/app.exe" entry --provider ghidra

# Decompile ฟังก์ชันตามชื่อหรือ address เช่น FUN_1400021b4
rea decompile "path/to/app.exe" FUN_1400021b4 --provider ghidra

# ค้นหา Procedure หรือฟังก์ชันใน Binary
rea search "path/to/app.exe" "main" --provider ghidra
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

# วิเคราะห์ Web Bundle จาก URL
rea analyze-web-bundle --url "https://example.com"
```

### 3.4 การตรวจสอบสถานะระบบ
```bash
# ตรวจสอบสถานะการทำงานของ REA และเครื่องมือวิเคราะห์
rea doctor --client codex --client hermes

# ตรวจสอบสถานะ MCP Server
rea mcp doctor
```
