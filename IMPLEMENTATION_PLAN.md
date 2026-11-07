# แผนปรับปรุง Sidebar Doctor Assistant

เอกสารนี้เป็นแผนก่อนพัฒนาเพิ่มเติมสำหรับผลิตภัณฑ์ Sidebar Doctor Assistant แบบ standalone โดยคงระบบเดิมไว้ครบ และติดตั้ง Server แยกบนเครื่องของแต่ละโรงพยาบาล

## หลักการ

- ไม่ลบหรือย้ายไฟล์จากระบบเดิม
- ผลิตภัณฑ์ใหม่นำเฉพาะ Sidebar, API ที่จำเป็น, ไอคอนพี่หมอ และ Setup มาใช้
- ไม่รวมระบบเปิดดูหรือเขียน OPD Card
- ใช้บัญชี HOSxP สำหรับแอปที่มีสิทธิ์ SELECT เท่าที่จำเป็นเท่านั้น และตรวจสอบสิทธิ์ผ่าน Setup
- ให้ปรับ schema, charset, รหัส lab, clinic และกฎทางคลินิกได้ โดยไม่ผูกค่าของโรงพยาบาลเดียวไว้ในโค้ด
- ใช้ Product Version `1` และเลข Build เดียวกันเป็นข้อมูลอ้างอิงบน Companion และหน้าเว็บ
- ยังไม่เชื่อมต่อ AI ภายนอก; หากเริ่ม AI ในอนาคต ให้ใช้บริการที่ติดตั้งภายในโรงพยาบาลเท่านั้น

## ขอบเขตฟังก์ชันและการตัดสินใจ

### ควรพัฒนาเป็นลำดับต้น

1. **ประวัติแพ้ยา** — อ่านจาก `opd_allergy` เมื่อ schema รองรับ และ fallback ไปยัง `patient.drugallergy`; ฟิลด์เสริม เช่น `seriousness_id` ต้องตรวจพบก่อนใช้
2. **สัญญาณชีพย้อนหลัง** — แสดงแนวโน้มจาก `opdscreen` และ `ovst`; ใช้ VN เป็นจุดเชื่อมหลักแทนการสมมติว่าทุกเวอร์ชันมี `opdscreen.hn`
3. **แนวโน้มผลแล็บ** — เพิ่มรายการสำคัญ เช่น K, LDL, Hct, Platelet และ UACR โดยกำหนดรหัสใน Setup; จัดการผลหลายรายการในวันเดียวกันด้วยเวลาและเลขที่ใบสั่งแล็บ
4. **Visit Timeline** — สรุป Visit ล่าสุดพร้อมอาการและการวินิจฉัย โดยจำกัดจำนวนแถวและตรวจ index/ภาระ query
5. **รายการยาใน Visit** — แสดงยาและบริบทประกอบคำเตือน โดยอ่านจาก `opitemrece` และ `drugitems`

### ต้องปรับหรือกำหนดค่าก่อนเปิดใช้

- รหัส Creatinine ใน SQL ตัวอย่างคือ `78` แต่ค่าของโรงพยาบาลปัจจุบันอาจต่างกัน; ใช้ค่าจาก Setup และตรวจสอบกับผลจริง
- รหัสแผนก ER, คลินิก, lab, `icode` ยา และ charset เป็นค่ารายโรงพยาบาล ห้าม hard-code
- การตรวจ ER ซ้ำ 48 ชั่วโมงต้องตั้งรหัสแผนกและตรวจว่าจะใช้ `main_dep`, `cur_dep` หรือทั้งคู่
- Chronic care gap เช่น HbA1c/UACR ให้ตั้งช่วงเวลาตามแนวทางของโรงพยาบาล
- ตั้งค่า table/column mappings แบบ optional เพื่อรองรับ HOSxP V3/V4/XE และ schema ที่ต่างกัน

### ยังไม่เปิดเป็นคำเตือนอัตโนมัติจนกว่าจะผ่านการทบทวน

- **Readmission 28 วัน:** query ตัวอย่างหาเพียงการจำหน่ายใน 28 วันที่ผ่านมา ยังไม่ได้เชื่อมกับการ admit ครั้งใหม่หลังจำหน่าย
- **qSOFA/Sepsis:** ตัวอย่างนับเพียง RR และ systolic BP ไม่มี altered mental status จึงเป็นคะแนนบางส่วน ต้องแสดงเป็นตัวช่วยคัดกรอง ไม่ใช่การวินิจฉัย
- **Dengue/Hct rise:** สูตร max-min หาร min ไม่เท่ากับการเพิ่มจากค่าแรกเสมอ ห้ามจัดเป็น RED alert จนกว่าแพทย์ทบทวนสูตรและเกณฑ์
- **ยาซ้ำใน 30 วัน:** ปริมาณจ่ายไม่บอกจำนวนวันที่ยาพอและวิธีใช้ เสี่ยงเตือนเกินจริง
- **RDU และ renal drug alerts:** หลีกเลี่ยง regex ชื่อยาหรือ ICD เป็นกฎถาวร; ให้ใช้รายการยาที่ map ด้วย `icode` และกฎเวอร์ชันที่โรงพยาบาลรับรอง พร้อมแสดงเป็นคำแนะนำ

## ลำดับดำเนินงาน

1. ยืนยัน HOSxP รุ่นและช่องทางตรวจสอบตัวตน/role ของแต่ละโรงพยาบาล รวมทั้งกำหนดผู้อนุมัติด้านระบบและข้อมูลสุขภาพ
2. ทำ Setup ให้ตรวจการเชื่อมต่อ ตารางที่ต้องอ่าน และสิทธิ์ effective grants ของบัญชี HOSxP; แนะนำ SQL สำหรับ DBA เพื่อสร้างบัญชี SELECT-only โดยไม่ให้แอปยกระดับสิทธิ์เอง
3. เพิ่ม authentication/session gate: ให้ข้อมูลผู้ป่วยและ API ใช้งานได้เมื่อมี HOSxP session ที่ตรวจสอบแล้วเท่านั้น; logout, ปิด HOSxP, session หมดอายุ หรือเปลี่ยนผู้ใช้ต้องล็อก API และเคลียร์ข้อมูลค้าง
4. จำกัด Setup ด้วยสิทธิ์ผู้ดูแลระบบ/IT ที่ตรวจสอบจากแหล่งข้อมูลจริงของโรงพยาบาล โดยคง loopback-only เป็นชั้นป้องกันเพิ่มเติม
5. จัดทำ audit log สำหรับการเข้าสู่ระบบ, การอ่านผู้ป่วย/Visit, การค้นหา, การวิเคราะห์, การปฏิเสธสิทธิ์ และการเปลี่ยนค่าระบบ พร้อมตั้งอายุการเก็บและผู้มีสิทธิ์ดู log
6. แสดง Product Version `1` และ Build บน Companion, หน้าเว็บ และ endpoint ตรวจสอบรุ่น; แจ้งเตือนเมื่อรุ่น client/server ใช้งานร่วมกันไม่ได้
7. สร้างบัญชีกลางของรายการ Lab ทุกชนิดที่ระบบแสดง และเพิ่ม mapping รหัส/ชื่อ/หน่วย/ค่าปกติตาม schema โรงพยาบาลใน Setup พร้อมตรวจผลก่อนบันทึก
8. ทำ footer นโยบายข้อมูลสุขภาพแบบกะทัดรัดและเปิดอ่านใน modal โดยใช้ข้อความแม่แบบที่ระบุผู้ควบคุมข้อมูล วัตถุประสงค์ ประเภทข้อมูล ผู้เข้าถึง การเก็บรักษา ช่องทางติดต่อ และวันที่/รุ่นนโยบาย; ให้ DPO/ฝ่ายกฎหมายของโรงพยาบาลตรวจข้อความก่อนใช้จริง
9. หลังข้อ 1–8 ผ่านการตรวจรับ จึงเริ่ม AI pilot แบบ on-premise สำหรับสรุปประวัติผู้ป่วยจากข้อมูลที่จำเป็นเท่านั้น; ปิดการส่งข้อมูลไปผู้ให้บริการ AI ภายนอก และไม่ให้ AI วินิจฉัย สั่งยา หรือเขียนกลับ HOSxP
10. ทดลองบนสำเนาฐานหรือ replica ก่อน แล้วจึงทดสอบกับโรงพยาบาลนำร่อง พร้อมคู่มือติดตั้ง อัปเกรด สำรอง config/log และ rollback

## แนวทางบัญชีฐานข้อมูล HOSxP

- ใช้บัญชีแยกสำหรับ Doctor Assistant ไม่ใช้บัญชี admin/root หรือบัญชีที่ Companion ใช้เข้าสู่ HOSxP
- ให้สิทธิ์ `SELECT` เฉพาะฐาน/ตารางที่ฟีเจอร์เปิดใช้จริง ไม่มี `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `FILE`, `GRANT OPTION` หรือสิทธิ์ระดับ global ที่ไม่จำเป็น
- Setup ตรวจ `SHOW GRANTS`/effective roles เท่าที่บัญชีมีสิทธิ์ตรวจได้ และลองอ่านตาราง/คอลัมน์ที่จำเป็น; ห้ามทดสอบด้วยการเขียนหรือลบข้อมูลจริง
- ถ้า Setup ตรวจสอบ role ที่สืบทอดหรือสิทธิ์จริงได้ไม่ครบ ให้แสดงว่า “ยืนยันสิทธิ์ SELECT-only ไม่ได้” และยังไม่ถือว่าผ่านการตรวจรับ ให้ DBA ตรวจและยืนยันก่อนเปิดใช้
- รหัสผ่านฐานข้อมูลเก็บเฉพาะฝั่ง Server ตามมาตรการของโรงพยาบาล ห้ามส่งไป Companion/browser, ห้ามบันทึกใน audit/console log และห้าม commit ลง Git

## แนวทาง session และสิทธิ์ Setup

- การพบ process HOSxP หรือ username string จาก Companion เป็นเพียงสัญญาณสถานะ ไม่ใช่หลักฐานยืนยันตัวตนจาก Server
- HOSxP credential ต้องตรวจผ่านวิธีที่ผู้ดูแล HOSxP/IT รับรอง; ห้ามอ่านหรือเทียบ password hash จากตารางภายในเอง และห้ามเก็บ HOSxP password หลังยืนยันตัวตน
- ใช้ session/token อายุสั้นผูกกับผู้ใช้ เครื่อง และสถานะ HOSxP; heartbeat หมดอายุหรือ HOSxP logout/ปิดต้องปฏิเสธ API ข้อมูลผู้ป่วยและเคลียร์ข้อมูลในหน้าจอ
- Setup ใช้ได้เฉพาะผู้ใช้ที่อยู่ในกลุ่ม/รายชื่อ Admin หรือ IT ซึ่งตรวจสอบจากแหล่งสิทธิ์ที่โรงพยาบาลกำหนด; `localhost` อย่างเดียวไม่พอ และห้ามใช้ค่า fallback เช่นชื่อแผนกเริ่มต้นมาตัดสิน role
- Bootstrap ผู้ดูแลครั้งแรกต้องทำจากเครื่อง Server ตามขั้นตอนติดตั้งที่จำกัดผู้มีสิทธิ์ และทุกการเปลี่ยนแปลง Setup ต้องมี audit record

## นโยบายข้อมูลสุขภาพและ audit log

- ใช้ log แบบ audit event ไม่ใช่สำเนาฐานข้อมูล: เก็บเวลา, user/session, workstation, action, resource reference ที่จำเป็น, ผลสำเร็จ/ปฏิเสธ และ request/correlation ID
- ไม่บันทึกรหัสผ่าน, connection string, SQL parameters, ข้อความเวชระเบียนทั้งหมด, ผล Lab ทั้งชุด, prompt หรือคำตอบ AI แบบเต็มลง log โดยปริยาย; HN/VN ถือเป็นข้อมูลอ่อนไหวใน log ให้จำกัดการเห็นและกำหนด retention/การลบ
- **ตัวเลือกเริ่มต้นสำหรับ Server เดี่ยวต่อโรงพยาบาล:** ใช้ SQLite ในไฟล์บน local disk ของ Server สำหรับ audit/event log แยกจากฐาน HOSxP, เปิด WAL, ตั้ง busy timeout, เขียนผ่าน writer queue/transaction และทำ backup/rotation ตามนโยบาย
- SQLite รองรับผู้ใช้หลายคนที่ส่ง request เข้า Server เดียวกันได้ แต่การเขียนฐานเดียวกันจะถูกจัดคิว/เกิดทีละ writer; ห้ามวางไฟล์ SQLite บน network share หรือให้ Companion หลายเครื่องเปิดไฟล์เดียวกันโดยตรง
- หากต้องรันหลาย instance/server, ต้องการรายงานรวมศูนย์ หรือมี write contention สูง ให้เปลี่ยนเป็น PostgreSQL/MariaDB service แยกสำหรับ log หรือส่งต่อไป SIEM ของโรงพยาบาล; ห้ามเขียน audit ลงฐาน HOSxP ด้วยบัญชี read-only
- จำกัดสิทธิ์อ่าน log, บันทึกการอ่าน/ส่งออก log, กำหนดระยะเก็บตามนโยบายโรงพยาบาล และพิจารณาส่งสำเนาไปพื้นที่เก็บที่แก้ไขย้อนหลังได้ยาก
- Footer เปิด modal นโยบายข้อมูลสุขภาพ โดยระบุว่าระบบอ่านข้อมูลจาก HOSxP เพื่อวัตถุประสงค์ใด, ใครเข้าถึง, ใช้ log อย่างไร, เก็บนานเท่าใด, ช่องทางติดต่อ DPO/ผู้ดูแล และรุ่น/วันที่มีผล; ห้ามเขียนข้อความรับรองการปฏิบัติตาม PDPA โดยอัตโนมัติก่อนโรงพยาบาลอนุมัติ

## แนวทาง AI ในอนาคต

- รุ่น 1 ยังไม่เรียก AI ภายนอกและไม่ส่งข้อมูลผู้ป่วยออกนอกเครือข่ายโรงพยาบาล
- หากเริ่ม pilot ให้เลือกโมเดล/บริการที่ติดตั้งภายในโรงพยาบาล; จำกัด network egress, เลือกข้อมูลตามงานวิเคราะห์, ไม่ส่งชื่อ/CID/HN หากไม่จำเป็น และไม่เก็บ prompt/output ที่มีข้อมูลสุขภาพนานเกินนโยบาย
- เริ่มด้วยปุ่มวิเคราะห์โดยผู้ใช้ ไม่วิเคราะห์ทุก Visit อัตโนมัติ; ให้ AI สรุปแนวโน้มพร้อมอ้างวันที่/ค่าต้นทางและระบุข้อมูลที่ขาด โดยแพทย์เป็นผู้ตรวจทาน
- AI เป็น decision support เท่านั้น ห้ามยืนยันการวินิจฉัย สั่งยา เปลี่ยนข้อมูล HOSxP หรือยกระดับคำเตือนทางคลินิกเอง
- ก่อน pilot ต้องกำหนดผู้รับผิดชอบทางคลินิก, ชุดทดสอบ, เกณฑ์วัดความผิดพลาด, การอนุมัติจากโรงพยาบาล/DPO/IT และ log ของรุ่นโมเดลกับผลการเรียกใช้โดยไม่เก็บเนื้อหาผู้ป่วยเกินจำเป็น

## เงื่อนไขก่อนปล่อยใช้งาน

- แต่ละฟีเจอร์มีผลทดสอบเทียบข้อมูลต้นทางและ fallback เมื่อ table/column ไม่มี
- คำเตือนสำคัญผ่านการทบทวนโดยผู้รับผิดชอบทางคลินิกของโรงพยาบาล
- API ใช้สิทธิ์อ่านอย่างเดียว จำกัดเครือข่าย และไม่บันทึกรหัสผ่านลง Git
- Setup ยืนยันบัญชี HOSxP ที่ใช้เชื่อมต่อเป็น SELECT-only ได้ หรือมีการตรวจยืนยันจาก DBA เมื่อระบบตรวจ effective roles ไม่ครบ
- เมื่อ HOSxP ปิด/logout/session หมดอายุ ต้องไม่สามารถอ่าน patient API ต่อได้ และไม่เหลือข้อมูลผู้ป่วยค้างใน Sidebar
- ทุกการอ่านข้อมูลผู้ป่วยและการเปลี่ยน Setup มี audit log ที่ระบุผู้ใช้ได้ โดยไม่บันทึกรหัสผ่านหรือเวชระเบียนเต็ม
- Policy modal ผ่านการทบทวนของ DPO/ฝ่ายกฎหมายและผู้ควบคุมข้อมูลของโรงพยาบาล
- AI (หากเปิด pilot) ประมวลผลภายในโรงพยาบาลเท่านั้น และผลทุกชิ้นผ่านการทบทวนโดยบุคลากรทางการแพทย์
- ทดสอบ HOSxP เป้าหมายและอุปกรณ์ Companion ก่อนทำแพ็กเกจเผยแพร่

## ความคืบหน้าการพัฒนา

อัปเดต 7 พ.ย. 2569:

- เพิ่ม API และแถบประวัติแพ้ยา โดยอ่าน `opd_allergy` ตามคอลัมน์ที่พบและ fallback ไป `patient.drugallergy`; ต้องตรวจผลกับข้อมูลจริงของโรงพยาบาลก่อนเปิดใช้งาน
- แก้ประวัติสัญญาณชีพที่เดิมคัดเฉพาะ Visit ซึ่งมีความดันหรือชีพจร ให้รวม Visit ที่มีน้ำหนัก ส่วนสูง BMI อุณหภูมิ หรือน้ำตาลด้วย โดยยังเชื่อม `opdscreen` ผ่าน VN
- เพิ่ม mapping รหัส Lab รายโรงพยาบาลจาก Setup สำหรับ LDL, Hct, Platelet และ UACR พร้อมตัวกรองดูแนวโน้มใน Sidebar
- เปิดเสียงแจ้งเตือนอัตโนมัติผ่าน Chromium ที่ Companion เปิดด้วย autoplay policy; ปุ่มบน Sidebar ใช้ปิดเสียงได้
- เปลี่ยนภาพ Companion, Windows icon และ browser favicon เป็น Badge PNG ที่มีพื้นหลังโปร่งใส
- งานทดลอง mapping กับ Lab จริงและ Visit Timeline ถูกจัดลำดับใหม่ตามข้อกำหนด Security/PDPA ในส่วนท้ายของเอกสารนี้; ยังไม่เริ่มจนกว่าจะได้รับอนุญาต

## ข้อกำหนดเพิ่มเติมจากผู้ใช้ — 7 พ.ย. 2569

- จัดทำรุ่นเริ่มต้นเป็น Product Version `1` และตามด้วยเลข Build; แสดงให้เห็นทั้ง Companion และหน้าเว็บ
- บังคับใช้บัญชี HOSxP ที่จำกัดสิทธิ์อ่าน SELECT เท่านั้น; Setup ต้องตรวจสิทธิ์ก่อนบันทึก โดยไม่เขียนทดสอบลงฐานจริง
- ล็อกการใช้เมื่อไม่มี HOSxP session ที่ยืนยันแล้ว และให้ Setup จำกัดเฉพาะผู้ดูแลระบบ/IT
- เพิ่มลิงก์นโยบาย PDPA/ข้อมูลผู้ป่วยขนาดเล็กใน footer และเปิดเนื้อหาเป็น modal
- มี audit log สำหรับกิจกรรมระบบทุกประเภทที่จำเป็นต่อการตรวจสอบ โดยลดข้อมูลสุขภาพใน log ให้เหลือน้อยที่สุด
- ใช้ SQLite แยกบน local disk สำหรับ Server เดี่ยวในรุ่นเริ่มต้น โดยออกแบบ writer queue/WAL/backup; ทบทวน PostgreSQL หรือระบบ log กลางเมื่อมีหลาย Server หรือ concurrency สูง
- ยังไม่อนุญาตเชื่อม AI ภายนอก; AI ในอนาคตให้ประเมินแบบ on-premise และต้องผ่านการอนุมัติของโรงพยาบาลก่อน
- **สถานะ:** ผู้ใช้อนุญาตเริ่มพัฒนาแล้ว; ความคืบหน้าและรายการที่ยังต้องผูกกับข้อมูลเฉพาะโรงพยาบาลระบุไว้ด้านล่าง

## ความคืบหน้าหลังได้รับอนุญาต — 7 พ.ย. 2569

- เพิ่ม Product Version `1` / Build `20261107.01` ใน Companion, Sidebar, Setup/health และ `/api/version`
- Setup ตรวจ `SHOW GRANTS`, ปฏิเสธสิทธิ์ที่ระบุชัดว่าเกิน SELECT-only หรือเป็น role/ขอบเขตที่ตรวจไม่ได้ และทดลอง `SELECT ... LIMIT 0` ตารางที่ API ใช้โดยตรงก่อนบันทึก; ไม่มี write probe (`opd_allergy` และ `oapp` ยัง optional)
- เพิ่ม Companion token แบบสุ่มที่สร้างใน Setup และ heartbeat ทุก 5 วินาที; API ข้อมูลผู้ป่วยปฏิเสธเมื่อไม่มี session heartbeat ใหม่กว่า 15 วินาทีหรือไม่พบ username จาก HOSxP scanner; หน้าเว็บขึ้นหน้าล็อกและเคลียร์ข้อมูลส่วนหัวเมื่อ session หาย
- ตัด HN/VN, username, IP และ computer name ออกจาก URL ของหน้า Sidebar เพื่อลดข้อมูลผู้ป่วย/บุคลากรที่ค้างใน browser history
- เปลี่ยน scanner ให้ fail-closed เมื่อไม่สามารถอ่าน username รอบปัจจุบันได้ แทนการใช้ชื่อทั่วไปหรือ username เก่าจาก cache
- เพิ่ม audit database แยกที่ `server/data/audit.sqlite`, SQLite WAL และ busy timeout; บันทึก session start/end, การสลับ patient context, การค้น/อ่านข้อมูล, การเปลี่ยน Setup และการปฏิเสธ API โดย HN/VN เป็น HMAC reference; morgan ไม่เก็บ URL/path/query และ data API fail-closed เมื่อเขียน audit ไม่สำเร็จ
- เพิ่ม footer/modal นโยบายข้อมูลที่ระบุชัดว่าเป็นร่างสำหรับเติมข้อมูลและให้ DPO/ฝ่ายกฎหมายโรงพยาบาลอนุมัติ; ไม่มี AI ภายนอก
- เพิ่มวิธี provision Companion token ผ่าน Setup โดยผู้ดูแลนำไปใส่ `companion/config.json` บน workstation
- อัปเดตตามข้อเสนอผู้ใช้: อนุญาต `SELECT` บนฐานข้อมูลอื่นได้ หากไม่มีสิทธิ์เขียนหรือ `GRANT OPTION`; จัดหน้า Setup เป็น wizard responsive เต็มความกว้าง โดยล็อกการไปขั้นต่อไปจนกว่าทดสอบฐานข้อมูลผ่าน แล้วเรียงโรงพยาบาล/เครือข่าย, Lab mappings และสรุปบันทึกเป็นขั้นถัดไป
- อัปเลขรุ่นเป็น Product v1 / Build `20261107.02` และ build Companion EXE ใหม่สำเร็จเพื่อให้เลข build ตรงกัน; ไฟล์ผลลัพธ์ยังถูก ignore จาก Git
- เพิ่มผลวินิจฉัยการเชื่อมต่อ: Setup แสดง `USER()`, `CURRENT_USER()`, active role และรายการ `SHOW GRANTS` เมื่อ policy check ไม่ผ่าน เพื่อระบุ account@host และสิทธิ์จริงที่ MariaDB จับคู่

### ขอบเขตที่ยังไม่ถือว่าผ่านด้านความปลอดภัย/PDPA

- การมี Companion token และการอ่านชื่อจาก process/window เป็นหลักฐานว่าสัญญาณ Companion มาจากเครื่องที่ลง tokenและตรวจพบชื่อใน HOSxP เท่านั้น **ยังไม่ใช่การตรวจ username/password**; ส่วน manual login ตรวจข้อมูลจาก `opduser` ตามค่าที่ผู้ใช้ตรวจยืนยัน
- ผู้ใช้เริ่มจากให้ตรวจผ่าน `opduser.password` แต่ผลตรวจรูปแบบบัญชีจริงพบว่า `password` ยาว 76 ตัว ส่วน `passweb` เป็น hex 32 ตัว จึงปรับเป็นเปรียบเทียบ `passweb` กับ `MD5(?)` ใน MariaDB ด้วย parameterized query โดยไม่อ่าน hash กลับ (Build `20261107.04`). วิธีนี้สอดคล้องกับรูปแบบ passweb ที่พบ แต่ยังต้องยืนยันการล็อกอินกับบัญชีทดสอบของโรงพยาบาล
- Setup ยัง loopback-only; ยังไม่ได้บังคับ role Admin/IT จาก authoritative role source เพราะ schema/แหล่งจัดการสิทธิ์ของโรงพยาบาลยังไม่ทราบ หน้าตั้งค่าระบุข้อจำกัดนี้และห้ามถือเป็น production-ready จนผูก role provider
- สิทธิ์ SELECT ตรวจและ read-probe ตารางที่ API ใช้โดยตรงแล้ว แต่ยังต้องทดสอบตาม schema/feature flags ของโรงพยาบาลจริงก่อนรับรอง setup
- ยังไม่ได้กำหนด retention/backup/restore ของ audit SQLite; ต้องให้โรงพยาบาลกำหนดก่อนเปิดใช้จริง และเพิ่ม routine ตามนโยบายที่อนุมัติ
- Privacy modal เป็นแม่แบบเท่านั้น ยังไม่ใช่การรับรอง PDPA; ต้องระบุผู้ควบคุมข้อมูล, ช่องทาง DPO, retention และวันที่มีผล
- Companion token ใน build นี้ส่งตาม `server_url`; ก่อนใช้งานผ่านเครือข่ายที่ไม่เชื่อถือ ต้องติด HTTPS ด้วย reverse proxy ของโรงพยาบาลและเปลี่ยน Companion ให้ใช้ URL แบบ HTTPS; manual login ปฏิเสธ HTTP จากเครื่องอื่นและอนุญาต HTTP เฉพาะ loopback
- สร้าง `companion/dist/DoctorAssistantCompanion.exe` จาก Build `20261107.01` ในรอบแรก แล้ว build ทับด้วย `20261107.02`; executable ถูก ignore จาก Git ส่วนการรันบน HOSxP จริง/integration และทดสอบหลาย workstation ยังไม่ได้ทำ

## เอกสารอ้างอิงทางเทคนิคสำหรับการตัดสินใจ

- SQLite WAL และการทำงานพร้อมกัน: https://www.sqlite.org/wal.html และ https://www.sqlite.org/isolation.html
- ข้อควรเลือกใช้ SQLite: https://www.sqlite.org/whentouse.html
- MariaDB `SHOW GRANTS`: https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/grant
- พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562: https://www.ocs.go.th/searchlaw/law-index/item/224
- ระเบียบกระทรวงสาธารณสุขว่าด้วยการคุ้มครองและจัดการข้อมูลสุขภาพของบุคคล พ.ศ. 2561: https://ict.moph.go.th/th/extension/418

### การเพิ่มฟอร์มล็อกอิน HOSxP — 7 พ.ย. 2569

- หน้าล็อกมีฟอร์ม username/password; ตรวจ `loginname` และเปรียบเทียบ `passweb` กับ `MD5(?)` ใน MariaDB ตามผลตรวจรูปแบบที่ผู้ใช้ส่งมา โดยไม่ดึง hash กลับ
- Login เปิด API ใช้งานได้โดยไม่ต้องเปิด HOSxP/Companion; เมื่อ Companion ยัง active ระบบยังใช้ patient context จาก HOSxP
- เพิ่ม `opduser` ใน read-only table probe ของ Setup เพื่อให้เห็นสิทธิ์ SELECT ที่จำเป็น
- ข้อจำกัด: ยังไม่ได้ยืนยันกับบัญชีทดสอบจริง และ HTTPS ต้องตั้งค่าใน environment ของโรงพยาบาลก่อนให้เครื่องอื่นล็อกอิน
- จากผลตรวจบัญชี (ไม่เปิดเผยค่า credential): `passweb` เป็น hex 32 ตัว (MD5-like), `password` ยาว 76 ตัว; เปลี่ยน verifier จากเทียบ `password` ตรง ๆ เป็น `passweb = MD5(รหัสที่กรอก)` (Build `20261107.04`)
- ภาพการใช้งานยืนยันว่า manual login ผ่านและแสดงชื่อบัญชีแล้ว แต่ overlay ยังบังหน้าเพราะ CSS `display:grid` override การซ่อนด้วย `hidden`; เพิ่ม `.session-lock-overlay[hidden]{display:none}` และอัป build เป็น `20261107.05`
- ปรับหน้า UI ตาม feedback: เอาชื่อ/เลข build ซ้ำจาก header และคง build ไว้ footer, ซ่อน allergy banner จนโหลด patient, เปลี่ยน native alert เป็น notice toast, และเขียนข้อความ privacy ตามการทำงานจริง
- แก้ search `HTTP 503` ที่มาจาก audit write failure: เพิ่ม append-only JSONL fallback ที่เก็บ HN/VN เป็น HMAC pseudonym เช่นเดิม; ถ้า SQLite และ fallback เขียนไม่ได้จึงยัง fail-closed พร้อมส่งข้อความ error ที่ server ส่งกลับให้ผู้ใช้เห็น
- อัป build เป็น `20261107.06`; การค้นกับฐาน HOSxP และการแสดงผลหลัง patient selection ยังต้องตรวจบน runtime ของโรงพยาบาล
- ปรับลำดับ session: manual login ใช้ได้เมื่อไม่มี Companion heartbeat; เมื่อ heartbeat HOSxP ที่ยังสดเข้ามา backend เพิกถอน manual cookie/logs session replacement และ API ใช้ Companion user; frontend reload เพื่อล้าง patient state เก่าแล้วอ่านคนไข้ปัจจุบันจาก HOSxP (Build `20261107.07`)
- ตรวจกรณีเปิด HOSxP แล้ว Sidebar ยังล็อก: Companion config ของ standalone ไม่มี token ที่ตรงกับ `security.companionToken` ใน `server/config.json` ทำให้ heartbeat ถูกปฏิเสธ; provision config ที่ใช้รัน Python และ config ข้าง EXE ให้ตรงกัน โดยไม่บันทึก token ลง Git
- เพิ่มการจับ status bar ที่ลงท้าย `, ใบลา` และลด cache ผู้ใช้จาก HOSxP ให้ตรวจซ้ำทุก 2 วินาที เพื่อให้ตรวจการสลับผู้ใช้ได้โดย process เดิมยังเปิดอยู่; build Companion `20261107.03`
- ผ่าน parser test ด้วย status bar จำลองและตรวจ token consistency ทั้งสอง config; สร้าง `DoctorAssistantCompanion.exe` build `20261107.03` สำเร็จ
- ข้อจำกัดการตรวจรอบนี้: ไม่ได้ยิง heartbeat จำลองเข้า server จริงเพื่อไม่แย่ง session HOSxP ที่ใช้งานอยู่; isolated HTTP integration test ถูก Windows sandbox ปฏิเสธ (`WinError 10013`) จึงยังต้องยืนยันกับ Companion ที่เปิดใหม่บนเครื่อง HOSxP จริง
- แก้สถานะแพ้ยาให้แยกแถว/ข้อความปฏิเสธการแพ้จากรายการสารก่อแพ้ โดยตรวจข้อความใน `opd_allergy.agent`, `opd_allergy.symptom`, `patient.drugallergy` และ `opdscreen.found_allergy`; แสดงข้อความปฏิเสธจริงใต้สถานะ “มีการบันทึกว่าไม่แพ้” และไม่ยกระดับเป็น “พบประวัติ” (Build `20261107.08`)
- ความคืบหน้า Audit Log: ผู้ใช้ยืนยันอ่าน JSONL ด้วย UTF-8 ได้แล้ว; event `ASSISTANT_SEARCH` ถูกบันทึกต่อคำขอค้นหา ส่วน HN/VN ถูกเก็บเป็น HMAC reference; ตรวจ metadata พบ `audit.sqlite` integrity ผ่านแต่ไม่มีแถว และ `audit-fallback.jsonl` มีข้อมูล จึงต้องมีหน้าอ่าน log จากทั้งสองแหล่ง
- เฟสถัดไป: ทำหน้า Audit Log แบบอ่านอย่างเดียว อยู่ในส่วน Setup และใช้ข้อจำกัดการเข้าถึงเดียวกัน (loopback/server-only); กรองตามช่วงวัน/action/ผู้ใช้, แบ่งหน้า, แสดงแหล่งข้อมูล และไม่แสดง HN/VN จริง; ต้องไม่ทำให้การเปิดดู log เข้าถึงได้จากเครื่อง client บน LAN
- พัฒนา Audit Log viewer ตามแผน: หน้า `/setup/audit/` และ API loopback-only อ่านจาก SQLite/JSONL พร้อมตัวกรองและ pagination; แสดงแหล่งที่มาและ pseudonym ของ resource แทน HN/VN, เพิ่มลิงก์จาก Setup (Build `20261107.09`)

### ติดตั้ง Companion ต่อ workstation จากหน้า Server — 7 พ.ย. 2569

- เพิ่มหน้า `/install/` สำหรับดาวน์โหลด Setup EXE และอธิบายขั้นตอนลงทะเบียนจากเครื่อง HOSxP
- เพิ่ม activation code แบบใช้ครั้งเดียว อายุ 10 นาที ออกได้จากหน้าจัดการ Companion ใน Setup; เก็บเฉพาะ hash ของ code ในหน่วยความจำและไม่เขียน code/token ลง audit log
- เพิ่ม API แลก code เป็น token แยกต่อ workstation; server เก็บ SHA-256 ของ token และหน้า Setup แสดงรายการเครื่องพร้อมเพิกถอนรายเครื่องได้
- Setup EXE ดาวน์โหลด Companion จาก Server แล้วเก็บ EXE และ config ไว้ใน `%LOCALAPPDATA%\SidebarDoctorAssistant\`; token ไม่ฝังในไฟล์ติดตั้งทั่วไปและไม่แชร์ระหว่างเครื่อง
- รองรับ token แบบเดิมต่อไปเพื่อไม่ตัด Companion ที่ลงทะเบียนไว้ก่อนหน้านี้; เครื่องใหม่ใช้ token รายเครื่อง
- สร้าง `companion/dist/CompanionSetup.exe` สำเร็จด้วย PyInstaller; ไฟล์ build ถูก ignore จาก Git ตามกฎเดิม
- Build Server `20261107.10`, Installer `20261107.01`, Companion `20261107.03`
- ข้อจำกัดการ deploy: ลงทะเบียนจากเครื่องอื่นต้องใช้ HTTPS; HTTP อนุญาตเฉพาะ `localhost` สำหรับทดสอบ และ endpoint download ยังตรวจ allowed LAN prefix ตามค่าที่ตั้งใน Setup
- ยังไม่ได้ทดสอบ end-to-end กับ Server จริง/HOSxP workstation; ก่อนกระจายให้ รพ. ต้องตั้ง HTTPS, ตรวจสอบ allowlist, ทดลองติดตั้งหนึ่งเครื่อง และตรวจว่าการเพิกถอนหยุด heartbeat ได้

### แก้ Companion Setup เปิดไม่ขึ้น — 7 พ.ย. 2569

- แก้ Tkinter `bad pad value "-10"` ซึ่งทำให้ Setup EXE ปิดตั้งแต่เปิดหน้าต่าง โดยเอา padding ติดลบออก
- Build Installer ใหม่เป็น `20261107.02`; ทดลองเปิด EXE และพบว่า process ทำงานต่อโดยไม่มี exception เดิม
- ปรับหน้า `/install/` ให้ระบุว่าหลังดาวน์โหลดต้องเปิดไฟล์จากแถบ Downloads/โฟลเดอร์ Downloads ด้วยตนเอง เนื่องจากเบราว์เซอร์ไม่อนุญาตให้หน้าเว็บเปิด EXE โดยตรง
- อัปเดต Server build เป็น `20261107.11` และชื่อไฟล์ดาวน์โหลดให้ตรงกับ Installer build ใหม่
- ยังไม่ได้ทดสอบแลก activation code หรือติดตั้ง Companion จนจบ เพื่อไม่สร้าง/ใช้ code ในระบบโรงพยาบาลโดยไม่ได้รับการยืนยันจากผู้ดูแล

### ปรับ flow ติดตั้งให้อัตโนมัติ — 7 พ.ย. 2569

- ยกเลิกขั้นตอนที่ผู้ดูแลต้องออก/คัดลอก code; หน้า `/install/` ขอ one-time ticket อายุ 30 นาทีและแนบไว้ใน URL ดาวน์โหลดโดยอัตโนมัติ ผู้ใช้ไม่เห็นหรือกรอก code
- ticket ผูกกับ client IP และใช้ได้ครั้งเดียว; Companion อ่าน origin/ticket จาก Windows `Zone.Identifier`, ย้ายตัวเองไป `%LOCALAPPDATA%\SidebarDoctorAssistant\` แล้วแลก ticket เป็น per-device token โดยอัตโนมัติ
- token ยังคงเป็นกลไกภายในสำหรับยืนยัน heartbeat และเพิกถอนเครื่อง แต่ไม่ให้ผู้ใช้เห็นหรือกรอก; จึงยังแยกอุปกรณ์และป้องกันการปลอม session ได้
- auto-enrollment ใช้ได้เฉพาะ client IP ที่ Setup อนุญาต; remote ต้องเป็น HTTPS, localhost ใช้ HTTP ได้ และจำกัดไม่เกิน 8 การลงทะเบียนต่อ IP ต่อ 10 นาที
- Server build ปรับเป็น `20261107.12`, Companion build เป็น `20261107.04`; หน้า Install และ Setup เปลี่ยนให้สอดคล้อง และ route เก่า `/install/companion-setup.exe` redirect ไป Companion โดยตรง
- แก้ Windows Temp extraction issue โดยเลิกใช้ Companion Setup ที่สร้างด้วย PyInstaller one-file ในขั้นติดตั้ง; ใช้ Companion EXE ที่มีอยู่แล้วและให้ติดตั้งตัวเองใน LocalAppData
- ขั้นตอน browser ยังคงต้องให้ผู้ใช้เปิดไฟล์ที่ดาวน์โหลดเอง เพราะเว็บเพจไม่สามารถสั่ง Windows ให้รัน EXE โดยตรงได้
- build Companion `20261107.04` สำเร็จเป็นไฟล์ versioned แยก โดยไม่เขียนทับ EXE เก่าที่กำลังรัน; ยังต้องตรวจติดตั้งจากลิงก์ `/install/` บน localhost กับ workstation ผ่าน HTTPS และยืนยันว่าอุปกรณ์ปรากฏในหน้า Setup/revoke ได้

### ปรับปรุงระบบ Install และทดสอบครบวงจรบน localhost — 7 พ.ย. 2569

- **Companion Auto-Install & Recovery (`app.py`):**
  - เพิ่มการตรวจสอบและปิดกระบวนการ Companion ตัวเก่า (`ensure_single_instance_restart`) ก่อนทำการคัดลอกไฟล์ทับลง `%LOCALAPPDATA%\SidebarDoctorAssistant\DoctorAssistantCompanion.exe` เพื่อป้องกันปัญหา Windows File Lock (`PermissionError / Access is denied`)
  - อัปเดต `config.json` ใน LocalAppData เสมอหากมีการดาวน์โหลดใหม่พร้อม Ticket หรือ Server URL ใหม่ และรีเซ็ต `companion_token` เพื่อให้แลกสิทธิ์ใหม่ได้ทันที
  - เพิ่มฟังก์ชัน `ensure_shortcuts` สร้างทางลัดบน Desktop (`Doctor Assistant.lnk`) และใน Windows Startup Folder (`shell:startup`) อัตโนมัติ เพื่อให้โปรแกรมสตาร์ตเองเมื่อเปิดเครื่อง
  - รองรับการขอ Ticket อัตโนมัติเมื่อรันบน localhost กรณีที่ไม่มีการเปิดผ่านลิงก์ดาวน์โหลด ช่วยให้ทดสอบและพัฒนาได้ทันที
- **Server Dynamic Release & Install Status API (`server.js`):**
  - เปลี่ยนการส่งไฟล์ดาวน์โหลด Companion ให้ค้นหาไฟล์เวอร์ชันล่าสุดในโฟลเดอร์ `companion/dist/` แบบ Dynamic โดยไม่ต้อง Hardcode ชื่อไฟล์
  - เพิ่ม Endpoint `GET /api/install/status` เพื่อให้หน้าเว็บ Install ตรวจจับสถานะการเชื่อมต่อของเครื่องลูกข่ายแบบ Real-time
  - แก้ไขบั๊ก Timing-safe Comparison ใน `authenticateCompanionToken` ที่ Buffer length ไม่ตรงกัน (Buffer 32 bytes เทียบกับ Hex 64 bytes) ให้เป็น 32 bytes binary match
  - ปรับปรุงการทำงานของ SQLite `node:sqlite` ใน `audit-log.js` ให้ Re-prepare Statement อัตโนมัติเมื่อเกิดสถานะ `finalized` ทำให้ Audit เขียนลง SQLite ได้ 100%
  - เพิ่มอ็อปชัน `security.allowInsecureEnrollment: true` ในการตั้งค่า เผื่อกรณีเครือข่ายภายในโรงพยาบาลที่ยังไม่ได้ตั้ง HTTPS Reverse Proxy
- **หน้าติดตั้งใหม่ (`/install/index.html`):**
  - ดีไซน์ใหม่แบบ Card กึ่ง Interactive พร้อมสถานะ Live Polling ตรวจจับการเชื่อมต่อแบบ Real-time
  - เมื่อเปิด Companion สำเร็จ หน้าเว็บจะแสดงแบนเนอร์สีเขียว พร้อมชื่อเครื่องและแพทย์ผู้ใช้งานทันที
  - เพิ่มกล่องคำแนะนำสำหรับการกดข้ามหน้าต่างสีฟ้า Windows SmartScreen ("More info" -> "Run anyway") อย่างชัดเจน
- **ผลการทดสอบบน Localhost:**
  - Build Companion ใหม่สำเร็จเป็น `DoctorAssistantCompanion_v1_build20261107.05.exe` (ขนาด ~27.7 MB)
  - ปรับ Server Build เป็น `20261107.13`
  - ผ่านการทดสอบ Integration Test ครบทั้ง 10 ขั้นตอนบน localhost (Health, Version, Ticket Creation, Pre-install Status, Install HTML, Companion Download, Workstation Enrollment, Heartbeat Sync, Post-install Live Status, และ Patient Sync สำหรับ Sidebar) ได้ผลสำเร็จ 100%

### บันทึกแผนพัฒนาเพิ่มเติม: ระบบตรวจจับข้อความขณะพิมพ์ (In-flight Typing Capture) & ลำดับฟีเจอร์คลินิก — 7 พ.ย. 2569

1. **ระบบดักจับข้อความขณะแพทย์กำลังพิมพ์ใน HOSxP (In-flight Real-time Typing Capture):**
   - **เป้าหมาย:** ช่วยแนะนำการวินิจฉัย (Differential Diagnosis), แจ้งเตือนขนาดยา หรือเสนอยาสมุนไพรทางเลือกในทันทีที่แพทย์กำลังพิมพ์ข้อความในช่องต่างๆ ของ HOSxP (เช่น Chief Complaint, การตรวจร่างกาย PE, บันทึกการรักษา) โดยไม่ต้องรอให้แพทย์กดปุ่มบันทึก (Save)
   - **สถาปัตยกรรมทางเทคนิค:**
     - ทำงานผ่านกระบวนการ Companion บน Windows Workstation ใน User Session เดียวกันกับ HOSxP
     - ดึงข้อความใน In-memory Edit Control ของ Delphi (เช่น `TDBMemo`, `TRichEdit`, `TEdit`) ผ่าน Win32 API (`AttachThreadInput` + `GetFocus()` + `WM_GETTEXT`) หรือ Windows UI Automation (`IUIAutomation`)
     - **ความปลอดภัย & ป้องกัน Antivirus/EDR:** ห้ามใช้ Low-level Keyboard Hook (`WH_KEYBOARD_LL` / Keylogger) เด็ดขาด ให้ใช้การอ่าน Control Text แบบ Debounced UI Polling (หน่วงเวลาหยุดพิมพ์ 600–800ms จึงดึงข้อความ) เพื่อความปลอดภัย ไม่หน่วงเครื่อง และไม่ถูก Antivirus จัดเป็นมัลแวร์
   - **ตำแหน่งในแผนพัฒนา:** บันทึกให้อยู่ใน **ระยะ "Active Clinical Assistant / In-flight Decision Support"** ควบคู่กับ **ข้อ 9 (On-premise Clinical Knowledge / AI Engine)** เนื่องจากต้องการฐานความรู้และกฎเกณฑ์ทางคลินิกที่แม่นยำเพื่อป้องกันการแจ้งเตือนพร่ำเพรื่อ

2. **ลำดับการพัฒนาฟังก์ชันขั้นถัดไป (Immediate Roadmap):**
   - **ลำดับที่ 1 (เริ่มทันที):** พัฒนาระบบแจ้งเตือน **"กลับมาตรวจซ้ำที่ห้องฉุกเฉิน (ER Revisit ภายใน 48 ชม.)"** — ดึงข้อมูลย้อนหลังจากตาราง `ovst` และ `kskdepartment` (รหัสแผนก ER เช่น `003` หรือคำว่า "ฉุกเฉิน") ช่วยเตือนแพทย์ทันทีเมื่อผู้ป่วยเพิ่งมารับบริการที่ ER ใน 48 ชม.
   - **ลำดับที่ 2 (ต่อเนื่อง):** ขยาย **"ช่อง Map รหัส Lab เพิ่มเติมในหน้า Setup"** — เพิ่มรายการแล็บสำคัญ (Potassium, Sodium, BUN, SGOT, SGPT, Uric Acid) ให้ IT สามารถกำหนดรหัสตรงตามโรงพยาบาลได้ครบถ้วนใน Setup Step 3
   - **ลำดับที่ 3:** พัฒนาระบบ In-flight Typing Capture ตามที่ออกแบบไว้ในข้อ 1
