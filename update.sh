#!/usr/bin/env bash
# ==============================================================================
# Sidebar Doctor Assistant - Update from GitHub (Linux)
# ==============================================================================
set -e

# ANSI Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}==================================================================${NC}"
echo -e "${GREEN}   Sidebar Doctor Assistant - อัปเดตระบบจาก GitHub${NC}"
echo -e "${BLUE}==================================================================${NC}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$APP_DIR/server"

cd "$APP_DIR"
echo -e "\n${BLUE}[1/3] ดึงข้อมูลอัปเดตล่าสุดจาก GitHub (git pull)...${NC}"
git pull origin main

echo -e "\n${BLUE}[2/3] อัปเดต dependencies และสิทธิ์ไฟล์...${NC}"
cd "$SERVER_DIR"
npm install --production --no-audit --no-fund
SERVICE_USER="www-data"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" || true
  chmod 775 "$SERVER_DIR" || true
fi

echo -e "\n${BLUE}[3/3] รีสตาร์ต Service...${NC}"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet doctor-assistant.service; then
  sudo systemctl restart doctor-assistant.service
  echo -e "${GREEN}✓ รีสตาร์ต doctor-assistant.service เรียบร้อยแล้ว${NC}"
else
  echo -e "${YELLOW}! หากรันเป็น Service กรุณารีสตาร์ตเซอร์วิสด้วยตนเอง${NC}"
fi

echo -e "\n${GREEN}==================================================================${NC}"
echo -e "${GREEN}   ✓ อัปเดตระบบเสร็จสมบูรณ์เรียบร้อยแล้ว!${NC}"
echo -e "${GREEN}==================================================================${NC}\n"
