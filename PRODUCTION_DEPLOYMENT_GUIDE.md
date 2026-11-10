# คู่มือการเตรียมความพร้อมและติดตั้งระบบบน Production Server ของโรงพยาบาล
## Sidebar Doctor Assistant (ระบบผู้ช่วยแพทย์อัจฉริยะข้างโต๊ะตรวจ HOSxP)

> **เวอร์ชันเอกสาร:** 1.0 (Build 20261109.01)  
> **กลุ่มเป้าหมาย:** ผู้ดูแลระบบเครือข่าย, นักวิชาการคอมพิวเตอร์, ผู้ดูแลระบบสารสนเทศโรงพยาบาล (Hospital IT Administrator / DBA)

---

## สารบัญ
1. [สถาปัตยกรรมระบบโดยรวม (System Architecture)](#1-สถาปัตยกรรมระบบโดยรวม)
2. [ระบบปฏิบัติการที่รองรับ (Supported Operating Systems)](#2-ระบบปฏิบัติการที่รองรับ)
3. [พอร์ตและข้อกำหนดทางเครือข่าย (Port & Network Requirements)](#3-พอร์ตและข้อกำหนดทางเครือข่าย)
4. [การประเมินผลกระทบต่อระบบเดิมของโรงพยาบาล (Impact Analysis)](#4-การประเมินผลกระทบต่อระบบเดิมของโรงพยาบาล)
5. [การเตรียมฐานข้อมูล HOSxP (Zero-Write Read-Only Database Setup)](#5-การเตรียมฐานข้อมูล-hosxp)
6. [ขั้นตอนการติดตั้งบน Linux Server (Ubuntu / Debian / AlmaLinux / Rocky)](#6-ขั้นตอนการติดตั้งบน-linux-server)
7. [ขั้นตอนการติดตั้งบน Windows Server / Windows PC](#7-ขั้นตอนการติดตั้งบน-windows-server)
8. [การตั้งค่า Reverse Proxy ร่วมกับเว็บเซิร์ฟเวอร์เดิม (Nginx / IIS / Apache)](#8-การตั้งค่า-reverse-proxy)
9. [การกระจายโปรแกรม Companion สู่เครื่องตรวจ (Client Workstations)](#9-การกระจายโปรแกรม-companion-สู่เครื่องตรวจ)
10. [รายการตรวจสอบความพร้อมก่อนเปิดใช้งานจริง (Production Readiness Checklist)](#10-รายการตรวจสอบความพร้อมก่อนเปิดใช้งานจริง)

---

## 1. สถาปัตยกรรมระบบโดยรวม

```
 +-----------------------------------------------------------------------+
 |                     HOSPITAL LOCAL AREA NETWORK                       |
 |                                                                       |
 |   [เครื่องตรวจแพทย์ / Workstations]                                   |
 |   - HOSxP v3 / v4 (เปิดตรวจตามปกติ)                                   |
 |   - Doctor Assistant Companion (.exe เบา ไม่ต้องสิทธิ์ Admin)         |
 |   - Browser Sidebar (Edge / Chrome หน้าต่างชิดขอบจอ)                 |
 |                                |                                      |
 |                                | HTTP/WebSocket พอร์ต 3030             |
 |                                v                                      |
 |   [Production Server: Linux หรือ Windows]                              |
 |   - Sidebar Doctor Assistant Core Service (Node.js)                   |
 |   - Local Audit DB (SQLite สำหรับบันทึกความปลอดภัย)                   |
 |   - Setup & Deployment Center (เข้าได้เฉพาะ Localhost หรือ IT)        |
 |                                |                                      |
 |                                | MySQL TCP พอร์ต 3306                  |
 |                                | (สิทธิ์ SELECT-Only อ่านอย่างเดียว)  |
 |                                v                                      |
 |   [HOSxP Database Server: MariaDB / MySQL]                            |
 |   - ฐานข้อมูล HOSxP ของโรงพยาบาล (เช่น hos, hosxp)                    |
 |   - *ไม่มีการเขียน, ไม่มีการแก้ไข, ไม่มีการสร้างตารางเพิ่ม*           |
 +-----------------------------------------------------------------------+
```

---

## 2. ระบบปฏิบัติการที่รองรับ

ระบบ Backend ของ Doctor Assistant พัฒนาด้วยเทคโนโลยี Node.js ที่เป็น Cross-Platform และมีขนาดเบามาก สามารถรันบนสภาพแวดล้อมได้หลากหลาย:

| ระบบปฏิบัติการ | ระดับความเหมาะสม | ข้อแนะนำสำหรับการใช้งานจริงใน รพ. |
| :--- | :---: | :--- |
| **Ubuntu Server 20.04 / 22.04 / 24.04 LTS** | ⭐⭐⭐⭐⭐ (แนะนำสูงสุด) | เสถียรสูง จัดการ Service ด้วย `systemd` ได้ง่าย ทรัพยากรน้อย ปลอดภัย |
| **Debian 11 / 12** | ⭐⭐⭐⭐⭐ (แนะนำสูงสุด) | เหมาะสำหรับ VM หรือ Bare-metal ที่ต้องการความเสถียรระยะยาว |
| **AlmaLinux 8/9 / Rocky Linux 8/9** | ⭐⭐⭐⭐⭐ | เหมาะสำหรับ รพ. ที่ใช้สาย RedHat / CentOS เดิม |
| **Windows Server 2016 / 2019 / 2022** | ⭐⭐⭐⭐ | เหมาะสำหรับ รพ. ที่ทีม IT เชี่ยวชาญ Windows จัดการเป็น Windows Service ด้วย NSSM |
| **Windows 10 / 11 Pro (PC Server / Mini PC)** | ⭐⭐⭐ | เหมาะสำหรับโรงพยาบาลชุมชนขนาดเล็ก หรือรันเป็นเครื่องทดสอบเฉพาะแผนก |
| **Docker / Container / Proxmox / ESXi** | ⭐⭐⭐⭐⭐ | สามารถรันบน VM แยก หรือ Container ได้อย่างมีประสิทธิภาพ |

---

## 3. พอร์ตและข้อกำหนดทางเครือข่าย

### 3.1 ทิศทางการเชื่อมต่อ (Traffic Flow)

| ทิศทาง | โปรโตคอล / พอร์ต | ปลายทาง | หน้าที่การทำงาน |
| :--- | :---: | :--- | :--- |
| **Inbound** | `TCP 3030` (หรือพอร์ตที่ตั้งค่าไว้) | Production Server | ให้เครื่องตรวจของแพทย์เรียกหน้า Sidebar และให้ Companion ส่ง Heartbeat |
| **Outbound** | `TCP 3306` (หรือพอร์ต MySQL HOSxP) | ฐานข้อมูล HOSxP | Server อ่านข้อมูล Visit, Lab, ประวัติยา (SELECT-only) |
| **Localhost** | `TCP 3030` | ภายใน Server เอง | หน้าจัดการ `/setup/` อนุญาตให้เปิดจากเครื่อง Server เท่านั้นเพื่อความปลอดภัย |

> [!NOTE]
> พอร์ต `3030` เป็นพอร์ตเริ่มต้น สามารถเปลี่ยนเป็นพอร์ตอื่น เช่น `8080`, `8888`, หรือรันหลัง Nginx Reverse Proxy ที่พอร์ต `80/443` ได้โดยไม่ชนกับเว็บเดิม

### 3.2 การเปิด Firewall

* **Linux (UFW):**
  ```bash
  sudo ufw allow 3030/tcp comment 'Sidebar Doctor Assistant'
  ```
* **Linux (firewalld - CentOS/Rocky/Alma):**
  ```bash
  sudo firewall-cmd --permanent --add-port=3030/tcp
  sudo firewall-cmd --reload
  ```
* **Windows Server (PowerShell Admin):**
  ```powershell
  New-NetFirewallRule -DisplayName "Sidebar Doctor Assistant Server" -Direction Inbound -LocalPort 3030 -Protocol TCP -Action Allow
  ```

### 3.3 การเข้าถึงหน้า Setup สำหรับผู้ดูแลระบบ (Admin Setup Access)

ระบบได้รับการออกแบบให้รองรับทั้งเซิร์ฟเวอร์แบบมีหน้าจอ (GUI) และเซิร์ฟเวอร์แบบไม่มีหน้าจอ (Headless Ubuntu Terminal / Server ในตู้ Rack):

1. **การติดตั้งครั้งแรก (First-run Setup):**
   - ระบบจะ **อนุญาตให้เปิดหน้า Setup จากบราวเซอร์ในวง LAN ได้ทันทีโดยอัตโนมัติ** (`http://<SERVER_IP>:<PORT>/setup/`) เพื่อให้แอดมินสามารถกำหนดค่าระบบจากเครื่องคอมพิวเตอร์ตนเองได้ทันที ไม่ติดบล็อก 403
   - ในขั้นตอนที่ 2 ระบบจะตรวจจับ Client IP ของแอดมินอัตโนมัติ และเติมลงในช่อง `วงเครือข่ายที่อนุญาต (allowedLanSubnets)` ให้ เพื่อป้องกันปัญหาแอดมินเผลอบันทึกแล้วถูกล็อกเอาต์
   - ตัวเลือก `☑ อนุญาตให้เข้าหน้า Setup จากเครื่องแอดมินในวง LAN (Remote Setup)` จะเปิดไว้เป็นค่าเริ่มต้น
2. **คำแนะนำความปลอดภัยหลังติดตั้งเสร็จ (Post-Setup Security):**
   - เมื่อตั้งค่าเสร็จสมบูรณ์และทดสอบการทำงานเรียบร้อย หากต้องการจำกัดความปลอดภัยสูงสุด สามารถกลับมาปิดตัวเลือก "อนุญาตให้เข้าหน้า Setup จากเครื่องแอดมินในวง LAN" ได้ ซึ่งจะทำให้หน้า Setup เข้าได้เฉพาะจาก Localhost หรือผ่าน SSH Tunnel เท่านั้น
3. **กรณีฉุกเฉินต้องการกู้คืนสิทธิ์เข้าหน้า Setup (Emergency Override):**
   - หากเผลอปิด `allowRemoteSetup` หรือจำกัด IP ผิดพลาด สามารถเปิดสิทธิ์กลับมาได้ง่ายๆ ด้วยคำสั่งบน Terminal ของ Server:
     ```bash
     sudo sed -i '/\[Service\]/a Environment=ALLOW_REMOTE_SETUP=true' /etc/systemd/system/doctor-assistant.service
     sudo systemctl daemon-reload && sudo systemctl restart doctor-assistant
     ```
   - หรือใช้ SSH Port Forwarding จากเครื่องทำงาน:
     ```bash
     ssh -L 3030:localhost:3030 user@<SERVER_IP>
     # แล้วเปิดบราวเซอร์ไปที่ http://localhost:3030/setup/
     ```

---

## 4. การประเมินผลกระทบต่อระบบเดิมของโรงพยาบาล

ก่อนนำขึ้น Production ทีม IT มักมีความกังวลใน 3 ประเด็นหลัก ซึ่งระบบได้รับการออกแบบมารองรับโดยเฉพาะ:

### 4.1 ผลกระทบต่อ Web Server เดิมที่รันอยู่ (Apache / Nginx / IIS / XAMPP)
* **ไม่มีผลกระทบต่อพอร์ต:** ระบบนี้ใช้พอร์ตเฉพาะของตนเอง (ค่าเริ่มต้น `3030`) จะไม่ทับซ้อนกับเว็บแอปพลิเคชันเดิมที่ใช้พอร์ต `80` (HTTP) หรือ `443` (HTTPS)
* **ไม่มีการใช้ Web Server ร่วม:** ทำงานด้วย Built-in HTTP Server (Express/Node.js) ในตัวเอง จึงไม่ต้องพึ่งพา Apache/PHP/IIS เดิม และไม่รบกวน Extension เดิมของเครื่อง
* **หากต้องการใช้ Domain ร่วม:** สามารถตั้งค่า Reverse Proxy ชี้ `https://assistant.hospital.go.th` หรือ `http://ip:80/assistant` ส่งต่อมาที่ `localhost:3030` ได้อย่างราบรื่น

### 4.2 ผลกระทบต่อฐานข้อมูลหลักของ HOSxP (MySQL / MariaDB)
* **Zero-Write Guarantee (ไม่มีการเขียนข้อมูลเด็ดขาด):**
  - ระบบทำงานแบบ **Read-only 100%**
  - ไม่มีคำสั่ง `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER` หรือสร้างตารางใหม่ลงในฐาน HOSxP แม้แต่คำสั่งเดียว
  - ข้อมูลบันทึกการใช้งานและความปลอดภัยทั้งหมดจะบันทึกใน Local SQLite (`server/data/audit.sqlite`) บนเครื่อง Server ผู้ช่วยแพทย์เอง
* **Connection Pooling ที่รัดกุม:**
  - กำหนด Connection Pool คงที่ไว้เพียง **10 connections** (ปรับได้ 2-30) เทียบกับ HOSxP Client ในโรงพยาบาลที่เชื่อมต่อเป็นร้อย Connection จึงไม่มีผลกระทบต่อ Connection Limit ของ MariaDB
* **Non-locking Queries:**
  - คำสั่ง SQL ค้นหาข้อมูลผู้ป่วย, Lab และยา ถูกปรับจูนดัชนี (Indexed Queries) อ่านข้อมูลอย่างรวดเร็ว (ความเร็วเฉลี่ย 1-15 มิลลิวินาทีต่อคำขอ) ไม่เกิดปัญหา Table Lock หรือ Row Lock ที่ทำให้แพทย์บันทึกประวัติสะดุด

### 4.3 ทรัพยากรเครื่องแม่ข่าย (Server Resource Consumption)
* **RAM (Memory):** ใช้หน่วยความจำเพียง **~80 - 180 MB** (เบากว่าแอป Java/Tomcat หรือ Web Application ขนาดใหญ่มาก)
* **CPU:** ในสภาวะปกติใช้ CPU **ต่ำกว่า 2 - 5%** แม้มีแพทย์เปิดใช้งานพร้อมกัน 20 - 50 โต๊ะตรวจ
* **Disk Space:** ตัวซอร์สโค้ดและไลบรารีใช้พื้นที่ประมาณ **120 MB** และ Audit Log เติบโตประมาณ **20 - 50 MB ต่อเดือน** (สามารถหมุนเวียนลบตามนโยบาย DPO/IT ได้)

---

## 5. การเตรียมฐานข้อมูล HOSxP

เพื่อความปลอดภัยสูงสุดตามมาตรฐานความมั่นคงปลอดภัยไซเบอร์ของ รพ. (Zero Trust Architecture) **ห้ามใช้บัญชี `sa` หรือสิทธิ์ Admin เด็ดขาด** ให้สร้างบัญชีแบบ **SELECT-Only** ดังนี้:

### คำสั่ง SQL สำหรับ DBA สร้างบัญชี (รันบน MariaDB/MySQL ของ HOSxP):

```sql
-- 1. สร้างบัญชีสำหรับระบบผู้ช่วยแพทย์ (กำหนดรหัสผ่านที่รัดกุมตามนโยบายความมั่นคงปลอดภัยของโรงพยาบาล)
CREATE USER 'hos_assistant_ro'@'%' IDENTIFIED BY 'StrongReadPassword#2026';

-- 2. ให้สิทธิ์อ่านอย่างเดียว (SELECT เท่านั้น) บนฐานข้อมูล HOSxP ของโรงพยาบาล
-- *หมายเหตุ: ให้เปลี่ยน `hosxp` เป็นชื่อฐานข้อมูล HOSxP จริงของโรงพยาบาลท่าน เช่น `hos`, `hosxp`, `hosxp_pcu` เป็นต้น
GRANT SELECT ON `hosxp`.* TO 'hos_assistant_ro'@'%';

-- 3. ตรวจสอบให้แน่ใจว่าไม่มีสิทธิ์แก้ไข ลบ สร้างตาราง หรือส่งต่อสิทธิ์เด็ดขาด (Zero-Write Enforcement)
REVOKE INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, GRANT OPTION ON `hosxp`.* FROM 'hos_assistant_ro'@'%';

-- 4. โหลดสิทธิ์ใหม่
FLUSH PRIVILEGES;

-- 5. ตรวจสอบสิทธิ์ที่ได้
SHOW GRANTS FOR 'hos_assistant_ro'@'%';
```

> [!NOTE]
> **คำแนะนำด้านความปลอดภัยเครือข่ายสำหรับ DBA:**
> - หากต้องการจำกัดการเชื่อมต่อให้แน่นหนายิ่งขึ้น สามารถเปลี่ยน Host จาก `'%'` เป็น IP หรือ Subnet ของเครื่อง Server ผู้ช่วยแพทย์ได้ เช่น `'hos_assistant_ro'@'192.168.1.50'` หรือ `'hos_assistant_ro'@'172.16.10.%'`
> - ให้เปลี่ยนรหัสผ่าน `'StrongReadPassword#2026'` เป็นรหัสผ่านที่มีความซับซ้อนสูง (ตัวพิมพ์ใหญ่-เล็ก ตัวเลข และอักขระพิเศษ) ตามนโยบายสารสนเทศของโรงพยาบาล

> [!TIP]
> หน้า Setup Center ของระบบมีระบบตรวจเช็กสิทธิ์อัตโนมัติ หากบัญชีที่ระบุมีสิทธิ์เกิน (เช่น มีสิทธิ์ INSERT/UPDATE) ระบบจะแจ้งเตือนและปฏิเสธ เพื่อปกป้องฐานข้อมูลของโรงพยาบาล

---

## 6. ขั้นตอนการติดตั้งบน Linux Server

*(รองรับ Ubuntu 20.04/22.04/24.04 LTS, Debian 11/12, AlmaLinux 8/9, Rocky Linux 8/9)*

### วิธีที่ 1 (แนะนำสูงสุด): ติดตั้งอัตโนมัติผ่าน GitHub ด้วยสคริปต์ `install.sh` (คำสั่งเดียวเสร็จสมบูรณ์)

ผู้ดูแลระบบสามารถ Clone และรันตัวติดตั้งอัตโนมัติได้ทันที:

```bash
git clone https://github.com/issarapong-suya/LP-Sidebar-Assistant.git
cd LP-Sidebar-Assistant
sudo bash install.sh
```

**สิ่งที่สคริปต์ `install.sh` ดำเนินการให้อัตโนมัติ:**
1. ตรวจสอบสภาพแวดล้อมและติดตั้ง Node.js 22 LTS จาก NodeSource ให้อัตโนมัติ (หากยังไม่มี)
2. รัน `npm install --production` เพื่อติดตั้งโมดูลที่จำเป็น
3. เตรียมโฟลเดอร์จัดเก็บข้อมูลความปลอดภัย `server/data/` พร้อมตั้งสิทธิ์การเข้าถึง
4. สร้างและเปิดใช้งาน Systemd Service (`doctor-assistant.service`) ให้เริ่มทำงานอัตโนมัติเมื่อเปิดเครื่อง
5. ตรวจสอบและเปิดกฎ Firewall พอร์ต `3030` (UFW / Firewalld)
6. สรุป IP และ URL หน้า Setup เพื่อให้เริ่มตั้งค่าระบบได้ทันที

---

### วิธีที่ 2: ติดตั้งแบบ Manual ทีละขั้นตอน (สำหรับแอดมินที่ต้องการจัดการเอง)

#### ขั้นตอนที่ 1: ติดตั้ง Node.js 22 LTS
```bash
# สำหรับ Ubuntu / Debian:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential

# สำหรับ AlmaLinux / Rocky / CentOS Stream:
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs git gcc-c++ make

# ตรวจสอบเวอร์ชัน (ต้องเป็น v22.5.0 ขึ้นไป)
node -v
npm -v
```

#### ขั้นตอนที่ 2: Clone ซอร์สโค้ดจาก GitHub
```bash
# วางไว้ที่ /opt/doctor-assistant
sudo git clone https://github.com/issarapong-suya/LP-Sidebar-Assistant.git /opt/doctor-assistant
cd /opt/doctor-assistant/server

# ติดตั้ง Dependencies
sudo npm install --production
```

#### ขั้นตอนที่ 3: ตั้งค่าให้รันเป็น Background Service ด้วย systemd
สร้างไฟล์ Service:
```bash
sudo nano /etc/systemd/system/doctor-assistant.service
```

วางเนื้อหาด้านล่างลงไป:
```ini
[Unit]
Description=Sidebar Doctor Assistant Production Server
After=network.target mysql.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/doctor-assistant/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

# Security hardening
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

เปลี่ยนสิทธิ์โฟลเดอร์และเปิดใช้งาน Service:
```bash
# ให้สิทธิ์ www-data สามารถเขียน config และ audit sqlite ได้
sudo chown -R www-data:www-data /opt/doctor-assistant/server/data /opt/doctor-assistant/server/config.json 2>/dev/null || true

# โหลดและเปิดเซอร์วิส
sudo systemctl daemon-reload
sudo systemctl enable doctor-assistant
sudo systemctl start doctor-assistant

# ตรวจสอบสถานะ
sudo systemctl status doctor-assistant
```

---

## 7. ขั้นตอนการติดตั้งบน Windows Server / Windows 10/11

*(ต้องการ Node.js 22 LTS ขึ้นไป ดาวน์โหลดได้จาก [nodejs.org](https://nodejs.org/))*

### วิธีที่ 1 (แนะนำและสะดวกรวดเร็ว): ติดตั้งผ่าน `install-windows.bat`

1. Clone ซอร์สโค้ดจาก GitHub ไปยังไดรฟ์ที่ต้องการ เช่น `D:\HospitalApps`:
   ```cmd
   cd /d D:\HospitalApps
   git clone https://github.com/issarapong-suya/LP-Sidebar-Assistant.git
   cd LP-Sidebar-Assistant
   ```
2. ดับเบิลคลิกไฟล์ **`install-windows.bat`** (หรือคลิกขวาแล้วเลือก Run as Administrator)
3. สคริปต์จะทำการ:
   - ตรวจสอบเวอร์ชัน Node.js
   - ติดตั้ง dependencies (`npm install --production`)
   - เปิดกฎ Firewall พอร์ต `3030`
   - เริ่มต้นเซิร์ฟเวอร์และเปิดหน้าจอ **Setup Wizard** ในบราวเซอร์ให้อัตโนมัติ

---

### วิธีที่ 2: ติดตั้งเป็น Windows Service ระยะยาวด้วย NSSM (ทำงานตลอดเวลาแม้ไม่มีผู้ใช้ล็อกอิน)

NSSM (Non-Sucking Service Manager) ช่วยให้ Node.js รันเป็น Service ของ Windows อัตโนมัติ:
1. ดาวน์โหลด `nssm.exe` จาก [nssm.cc](https://nssm.cc/) วางไว้ที่ `C:\Windows\System32\`
2. เปิด PowerShell ในฐานะ Administrator แล้วพิมพ์:
   ```powershell
   nssm install DoctorAssistantService "C:\Program Files\nodejs\node.exe" "D:\HospitalApps\LP-Sidebar-Assistant\server\server.js"
   nssm set DoctorAssistantService AppDirectory "D:\HospitalApps\LP-Sidebar-Assistant\server"
   nssm set DoctorAssistantService Description "Sidebar Doctor Assistant HOSxP Server"
   nssm set DoctorAssistantService Start SERVICE_AUTO_START
   nssm start DoctorAssistantService
   ```
3. เซอร์วิสจะเริ่มทำงานทันที และเริ่มต้นใหม่อัตโนมัติทุกครั้งที่รีสตาร์ตเครื่อง Server
3. เซอร์วิสจะเริ่มทำงานทันที และเริ่มใหม่อัตโนมัติทุกครั้งที่รีสตาร์ตเครื่อง Server

---

## 8. การตั้งค่า Reverse Proxy

หากโรงพยาบาลมี Nginx หรือ IIS รันอยู่ที่พอร์ต `80` หรือ `443` อยู่แล้ว และต้องการให้เข้าถึงระบบผ่าน Domain Name โดยไม่ต้องพิมพ์พอร์ต `:3030`:

### ตัวอย่างการตั้งค่า Nginx (Linux / Windows Nginx):
```nginx
server {
    listen 80;
    server_name assistant.hospital.local 192.168.1.100;

    client_max_body_size 20M;

    # ส่งต่อคำขอทั้งหมดไปที่ Doctor Assistant Node.js Port 3030
    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        
        # รองรับ WebSocket สำหรับ Live Diagnostic และ Real-time Notification
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        
        # ส่ง IP จริงของเครื่องลูกข่ายไปให้ระบบตรวจสอบสิทธิ์
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }
}
```

---

## 9. การกระจายโปรแกรม Companion สู่เครื่องตรวจ

เมื่อติดตั้ง Server เรียบร้อยแล้ว การนำไปใช้ที่ห้องตรวจแพทย์ทำได้ง่ายโดยไม่ต้องไปลงโปรแกรมแบบ Manual ทีละเครื่อง:

1. **เปิดหน้าติดตั้งบนเครื่องตรวจ:**
   - ให้แพทย์หรือเจ้าหน้าที่เปิดบราวเซอร์ไปที่:
     `http://<SERVER_IP>:3030/install/`
2. **คลิกปุ่มดาวน์โหลด:**
   - กดปุ่ม **"⬇ ดาวน์โหลดและติดตั้ง Companion"**
3. **เปิดไฟล์ที่ดาวน์โหลดมา:**
   - เปิดไฟล์ `DoctorAssistantCompanion.exe` ขึ้นมาเพียง 1 ครั้ง
   - ตัวโปรแกรมจะติดตั้งตัวเองลงในโฟลเดอร์ Local AppData ของผู้ใช้ (ไม่ติดสิทธิ์ User Account Control / UAC)
   - สร้าง Shortcut **"Doctor Assistant"** บน Desktop และ Start Menu ให้โดยอัตโนมัติ
   - ตั้งค่าให้เปิดตัวเองอัตโนมัติเมื่อเปิดเครื่อง (Windows Startup)
4. **พร้อมใช้งานทันที:**
   - ไอคอนผู้ช่วยจะปรากฏที่มุมจอและถาดระบบ (System Tray) ซิงค์ข้อมูลกับ HOSxP อัตโนมัติเมื่อแพทย์เปิดหน้าตรวจ

---

## 10. รายการตรวจสอบความพร้อมก่อนเปิดใช้งานจริง

| ลำดับ | รายการตรวจสอบ | วิธีตรวจสอบ / มาตรฐานที่ยอมรับ | สถานะ |
| :---: | :--- | :--- | :---: |
| 1 | **สิทธิ์ฐานข้อมูล** | บัญชี MySQL ได้รับเฉพาะสิทธิ์ `SELECT` บนฐาน HOSxP เท่านั้น (ทดสอบผ่านหน้า Setup) | [ ] |
| 2 | **Connection Limits** | ตรวจสอบ `max_connections` ของ MySQL HOSxP มีพื้นที่ว่างอย่างน้อย 20 connection ขึ้นไป | [ ] |
| 3 | **วงเครือข่าย (Subnets)** | ระบุ Subnet ของจุดตรวจครบถ้วนใน Setup เช่น `192.168.1.`, `10.0.0.`, `172.16.0.` (ระบุตามวงเครือข่ายจริงของโรงพยาบาลท่าน) | [ ] |
| 4 | **Auto-start Service** | ทดสอบ Restart เครื่อง Server แล้วตรวจว่า Service เริ่มทำงานอัตโนมัติ | [ ] |
| 5 | **Firewall** | เครื่องตรวจในแผนก OPD/ER/Wards สามารถเปิดหน้า `http://<SERVER_IP>:3030/` ได้ | [ ] |
| 6 | **Lab Item Mapping** | กดปุ่ม "🪄 ค้นหาและจับคู่รหัส Lab อัตโนมัติ" ในหน้า Setup ครบทุกตัว (Creatinine, LDL, K, Na, etc.) | [ ] |
| 7 | **Audit Log Backup** | กำหนดสคริปต์สำรองข้อมูลไฟล์ `server/data/audit.sqlite` ประจำวัน | [ ] |
| 8 | **เครื่องตรวจ HOSxP** | ทดสอบเปิด Companion ร่วมกับ HOSxP แล้วพบว่าคลิกเลือกคนไข้แล้ว Sidebar อัปเดตข้อมูลตรงกัน | [ ] |
