#!/usr/bin/env bash
# ==============================================================================
# Sidebar Doctor Assistant - Production Automated Installer for Linux
# Supported OS: Ubuntu 20.04/22.04/24.04, Debian 11/12, AlmaLinux 8/9, Rocky 8/9
# ==============================================================================
set -e

# ANSI Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}==================================================================${NC}"
echo -e "${GREEN}${BOLD}   Sidebar Doctor Assistant - ติดตั้งระบบบน Production Server (Linux)${NC}"
echo -e "${BLUE}==================================================================${NC}"

# 1. ตรวจสอบสิทธิ์ Root / Sudo
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] กรุณารันสคริปต์นี้ด้วยสิทธิ์ Root หรือใช้คำสั่ง:${NC}"
  echo -e "       ${YELLOW}sudo bash $0${NC}"
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$APP_DIR/server"

# ตรวจสอบพอร์ตบริการ (ค่าเริ่มต้น 3030 หรืออ่านจากตัวแปร PORT)
APP_PORT="${PORT:-3030}"
if [ -z "$PORT" ]; then
  PORT_OCCUPIED=false
  if command -v ss >/dev/null 2>&1 && ss -tulpn | grep -q ":3030[[:space:]]"; then
    PORT_OCCUPIED=true
  elif command -v lsof >/dev/null 2>&1 && lsof -i :3030 >/dev/null 2>&1; then
    PORT_OCCUPIED=true
  fi

  if [ "$PORT_OCCUPIED" = true ]; then
    echo -e "\n${YELLOW}! แจ้งเตือน: พบว่าพอร์ต 3030 กำลังถูกใช้งานโดยโปรแกรมอื่นในเครื่องนี้${NC}"
    # ค้นหาพอร์ตว่างถัดไปโดยอัตโนมัติ (เช่น 3031, 3032)
    CHECK_PORT=3031
    while command -v ss >/dev/null 2>&1 && ss -tulpn | grep -q ":$CHECK_PORT[[:space:]]"; do
      CHECK_PORT=$((CHECK_PORT + 1))
    done
    APP_PORT=$CHECK_PORT
    echo -e "${GREEN}✓ ระบบเลือกพอร์ตสำรองที่ว่างให้อัตโนมัติ: ${BOLD}$APP_PORT${NC}"
    echo -e "  (หากต้องการระบุพอร์ตเอง สามารถเรียกคำสั่ง: ${YELLOW}PORT=xxxx sudo -E bash install.sh${NC})"
  fi
fi

# 2. ตรวจสอบและติดตั้ง Node.js 22 LTS หากยังไม่มี
echo -e "\n${BLUE}[1/5] ตรวจสอบสภาพแวดล้อม Node.js (ต้องการ v22+ สำหรับ SQLite builtin)...${NC}"
NODE_OK=false
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
  if [ "$NODE_MAJOR" -ge 22 ]; then
    NODE_OK=true
    echo -e "${GREEN}✓ ตรวจพบ Node.js $(node -v) (พร้อมใช้งาน)${NC}"
  else
    echo -e "${YELLOW}! พบ Node.js $(node -v) ซึ่งต่ำกว่า v22.x (กำลังเตรียมอัปเกรดเป็น Node.js 22 LTS)...${NC}"
  fi
fi

if [ "$NODE_OK" = false ]; then
  echo -e "${YELLOW}กำลังติดตั้ง Node.js 22 LTS อัตโนมัติจาก NodeSource...${NC}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg build-essential
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl gcc-c++ make
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y -q nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl gcc-c++ make
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y -q nodejs
  else
    echo -e "${RED}[ERROR] ไม่พบ Package Manager (apt/dnf/yum) กรุณาติดตั้ง Node.js 22 ด้วยตนเอง${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ ติดตั้ง Node.js $(node -v) เรียบร้อยแล้ว${NC}"
fi

# 3. ติดตั้ง Node Dependencies
echo -e "\n${BLUE}[2/5] ติดตั้ง Server Dependencies (npm install)...${NC}"
cd "$SERVER_DIR"
npm install --production --no-audit --no-fund
mkdir -p "$SERVER_DIR/data"
chmod 755 "$SERVER_DIR/data"

# 4. ตั้งค่าสิทธิ์โฟลเดอร์สำหรับ Service User (www-data หรือ nobody)
SERVICE_USER="www-data"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if id "nobody" >/dev/null 2>&1; then
    SERVICE_USER="nobody"
  else
    SERVICE_USER="root"
  fi
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" || true
chmod 775 "$SERVER_DIR" || true
chmod 775 "$SERVER_DIR/data" || true

# 5. สร้าง systemd Service
echo -e "\n${BLUE}[3/5] ตั้งค่าและสร้าง systemd Service (doctor-assistant.service)...${NC}"
NODE_BIN=$(command -v node)
cat <<EOF > /etc/systemd/system/doctor-assistant.service
[Unit]
Description=Sidebar Doctor Assistant Production Server
After=network.target mysql.target mariadb.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
Environment=ALLOW_REMOTE_SETUP=true
LimitNOFILE=65536

# Security hardening
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true
ReadWritePaths=$SERVER_DIR/data $SERVER_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable doctor-assistant.service
systemctl restart doctor-assistant.service

# 6. เปิด Firewall Port
echo -e "\n${BLUE}[4/5] ตรวจสอบและเปิด Firewall พอร์ต $APP_PORT...${NC}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow $APP_PORT/tcp comment "Sidebar Doctor Assistant (Port $APP_PORT)" || true
  echo -e "${GREEN}✓ เปิดพอร์ต $APP_PORT บน UFW เรียบร้อย${NC}"
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=$APP_PORT/tcp || true
  firewall-cmd --reload || true
  echo -e "${GREEN}✓ เปิดพอร์ต $APP_PORT บน firewalld เรียบร้อย${NC}"
fi

# 7. สรุปผลและแสดง URL เข้าใช้งาน
echo -e "\n${BLUE}[5/5] ตรวจสอบสถานะการทำงาน...${NC}"
sleep 2
if systemctl is-active --quiet doctor-assistant.service; then
  echo -e "${GREEN}${BOLD}✓ เซอร์วิส doctor-assistant เริ่มทำงานเรียบร้อยแล้ว! (Active / Running)${NC}"
else
  echo -e "${YELLOW}! เซอร์วิสกำลังเริ่มต้น สามารถตรวจสอบ log ด้วยคำสั่ง: journalctl -u doctor-assistant -f${NC}"
fi

# ค้นหา IP เครื่อง Server
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "IP_SERVER")

echo -e "\n${GREEN}==================================================================${NC}"
echo -e "${GREEN}${BOLD}   🎉 การติดตั้งเสร็จสมบูรณ์ พร้อมเปิดใช้งาน!${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "พอร์ตบริการที่ใช้งาน: ${BOLD}$APP_PORT${NC}"
echo -e "ขั้นตอนต่อไปสำหรับผู้ดูแลระบบ IT:"
echo -e "1. ${BOLD}เปิดหน้า Setup เพื่อตั้งค่าเชื่อมต่อฐานข้อมูล HOSxP:${NC}"
echo -e "   👉 ${YELLOW}http://$SERVER_IP:$APP_PORT/setup/${NC} (เข้าได้จากคอมพิวเตอร์ในวง LAN ทันที)"
echo -e "2. ${BOLD}หน้าดาวน์โหลดโปรแกรมสำหรับโต๊ะตรวจแพทย์:${NC}"
echo -e "   👉 ${YELLOW}http://$SERVER_IP:$APP_PORT/install/${NC}"
echo -e "3. ${BOLD}คำสั่งจัดการ Service:${NC}"
echo -e "   - ตรวจสอบสถานะ : ${YELLOW}sudo systemctl status doctor-assistant${NC}"
echo -e "   - ดู Log การทำงาน : ${YELLOW}sudo journalctl -u doctor-assistant -f${NC}"
echo -e "   - รีสตาร์ตระบบ   : ${YELLOW}sudo systemctl restart doctor-assistant${NC}"
echo -e "   - อัปเดตเวอร์ชันใหม่: ${YELLOW}sudo bash $APP_DIR/update.sh${NC}"
echo -e "${GREEN}==================================================================${NC}\n"
