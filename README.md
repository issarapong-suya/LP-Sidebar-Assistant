# Sidebar Doctor Assistant (LP Sidebar)
## ระบบผู้ช่วยแพทย์อัจฉริยะข้างโต๊ะตรวจ HOSxP (Clinical Decision Support Sidebar)

> **เวอร์ชัน:** 1.0 (Build 20261109.01)  
> ระบบแสดงผลข้อมูลผู้ป่วย แจ้งเตือนความปลอดภัยด้านยา (Drug Safety) และสนับสนุนการตัดสินใจทางคลินิก (Clinical Decision Support) ข้างหน้าจอ HOSxP โดยทำงานแบบ **อ่านอย่างเดียว 100% (Zero-Write)** ไม่แก้ไขฐานข้อมูล HOSxP ของโรงพยาบาล

---

## 🚀 ติดตั้งด่วนผ่าน GitHub (Quick Install)

### 🐧 สำหรับ Linux Server (Ubuntu 20.04+, Debian 11+, AlmaLinux 8+, Rocky 8+)
คัดลอกและวางคำสั่งต่อไปนี้ใน Terminal เพื่อติดตั้งและเริ่ม Service อัตโนมัติ:

```bash
git clone https://github.com/issarapong-suya/LP-Sidebar-Assistant.git
cd LP-Sidebar-Assistant
sudo bash install.sh
```
*สคริปต์ `install.sh` จะตรวจสอบ Node.js 22 LTS, ติดตั้ง dependencies, ตั้งค่า `systemd` service (`doctor-assistant.service`), และเปิด Firewall พอร์ต 3030 ให้อัตโนมัติ*

---

### 💻 สำหรับ Windows Server / Windows 10/11
เปิด Command Prompt หรือ PowerShell ในโฟลเดอร์ที่ต้องการติดตั้ง:

```cmd
git clone https://github.com/issarapong-suya/LP-Sidebar-Assistant.git
cd LP-Sidebar-Assistant
install-windows.bat
```
*(ต้องการ Node.js 22 LTS ขึ้นไป ดาวน์โหลดได้จาก [nodejs.org](https://nodejs.org/))*

---

### 🔄 การอัปเดตเวอร์ชันใหม่ในอนาคต (Updating)
เมื่อมีการปรับปรุงโค้ดหรือฟีเจอร์ใหม่ สามารถสั่งอัปเดตได้ด้วยคำสั่งเดียว:
* **Linux:** `sudo bash update.sh`
* **Windows:** ดับเบิลคลิก `update-windows.bat`

---

## 📌 ขั้นตอนเริ่มต้นใช้งานหลังติดตั้ง (Post-Installation)

1. **ตั้งค่าการเชื่อมต่อฐานข้อมูล HOSxP (Setup Wizard):**
   - เปิดบราวเซอร์ไปที่: `http://<SERVER_IP>:3030/setup/` (หรือ `http://localhost:3030/setup/`)
   - ทดสอบการเชื่อมต่อฐานข้อมูล HOSxP (ต้องใช้สิทธิ์ `SELECT` เท่านั้น)
   - ระบุชื่อโรงพยาบาลและวงเครือข่ายที่อนุญาต (LAN Subnets)
   - ระบบจะตรวจจับและจับคู่รหัส Lab (Creatinine, LDL, Hct, Platelet, uACR) ให้โดยอัตโนมัติ

2. **กระจายโปรแกรม Companion สู่เครื่องตรวจแพทย์ (Workstation Rollout):**
   - ให้แพทย์หรือเจ้าหน้าที่เปิดบราวเซอร์ไปที่: `http://<SERVER_IP>:3030/install/`
   - คลิกดาวน์โหลดโปรแกรม **Companion** แล้วเปิดไฟล์ขึ้นมา 1 ครั้ง
   - โปรแกรมจะติดตั้งตัวเองและตรวจจับหน้าจอ HOSxP โดยอัตโนมัติ ไม่ต้องกรอก URL หรือ Token ใดๆ

3. **หน้าจอทำงานของผู้ช่วยแพทย์ (Doctor Sidebar):**
   - เข้าผ่านไอคอนพี่หมอที่ถาดระบบ (System Tray) หรือเปิด URL: `http://<SERVER_IP>:3030/assistant/`

---

## 🛡️ สถาปัตยกรรมความปลอดภัยและ PDPA (Security & Compliance)

* **Zero-Write Database Guarantee:** เชื่อมต่อฐานข้อมูล HOSxP ด้วยสิทธิ์ **SELECT-Only 100%** ไม่มีการสั่ง `INSERT`, `UPDATE`, `DELETE`, `DROP` หรือสร้างตารางใดๆ ในฐานข้อมูลโรงพยาบาล
* **Local Audit Logging:** บันทึกประวัติการเข้าถึงข้อมูลตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล (PDPA) จัดเก็บลงใน Local SQLite ภายในเครื่องเซิร์ฟเวอร์ ไม่ส่งข้อมูลออกภายนอก
* **Strict Network Isolation:** ระบบจะให้บริการเฉพาะเครื่องตรวจที่อยู่ในวงเครือข่าย LAN ที่ได้รับอนุญาตเท่านั้น
* **No External AI Dependency:** ประมวลผลและตัดสินใจทางคลินิกภายในเซิร์ฟเวอร์ของโรงพยาบาล ข้อมูลผู้ป่วยไม่หลุดออกสู่อินเทอร์เน็ต

---

## 📚 เอกสารคู่มือฉบับเต็ม (Documentation)

* 📖 **[คู่มือการติดตั้งระดับ Production (PRODUCTION_DEPLOYMENT_GUIDE.md)](PRODUCTION_DEPLOYMENT_GUIDE.md):**  
  ครอบคลุมการประเมินผลกระทบต่อระบบเดิม, การตั้งค่า Reverse Proxy (Nginx/IIS), คำสั่ง SQL สร้าง User สำหรับ DBA, และรายการตรวจสอบก่อนเปิดใช้งานจริง (Readiness Checklist)
* 🩺 **[คู่มือเกณฑ์และการตัดสินใจทางคลินิก (CLINICAL_DECISION_SUPPORT_SPEC.md)](CLINICAL_DECISION_SUPPORT_SPEC.md):**  
  สูตรคำนวณ eGFR (CKD-EPI 2021 / Cockcroft-Gault), เกณฑ์ปรับขนาดยาไต (Renal Dosing), การตรวจจับภาวะวิกฤต (Sepsis/Dengue), และ Care Gap โรคเรื้อรัง (uACR / LDL / Hct)
