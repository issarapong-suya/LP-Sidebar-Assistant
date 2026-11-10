/**
 * Companion Release Downloader
 * Downloads the latest compiled Companion executable from GitHub Releases
 * into companion/dist/ if not already present.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'issarapong-suya/LP-Sidebar-Assistant';
const DIST_DIR = path.join(__dirname, '..', 'companion', 'dist');

function checkExisting() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
  const files = fs.readdirSync(DIST_DIR).filter(f => /^DoctorAssistantCompanion.*\.exe$/i.test(f));
  if (files.length) {
    console.log(`✓ ตรวจพบไฟล์ Companion ในโฟลเดอร์ companion/dist/ แล้ว: ${files[0]}`);
    return true;
  }
  return false;
}

async function downloadLatest() {
  if (checkExisting()) return;

  console.log(`กำลังตรวจสอบ Release ล่าสุดจาก GitHub (${REPO})...`);
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;

  const options = {
    headers: { 'User-Agent': 'DoctorAssistantInstaller/1.0' }
  };

  https.get(apiUrl, options, res => {
    if (res.statusCode !== 200) {
      console.log(`! ไม่พบ GitHub Release ล่าสุด (HTTP ${res.statusCode})`);
      console.log(`  (หากติดตั้งผ่าน git clone ไฟล์ Companion จะอยู่ใน companion/dist/ เรียบร้อยแล้ว)`);
      return;
    }
    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const asset = (release.assets || []).find(a => /^DoctorAssistantCompanion.*\.exe$/i.test(a.name));
        if (!asset || !asset.browser_download_url) {
          console.log('! ไม่พบไฟล์ .exe ใน Release assets ล่าสุด');
          return;
        }

        const targetFile = path.join(DIST_DIR, asset.name);
        console.log(`กำลังดาวน์โหลด ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MB)...`);
        
        function fetchAsset(url) {
          https.get(url, options, dlRes => {
            if (dlRes.statusCode >= 300 && dlRes.statusCode < 400 && dlRes.headers.location) {
              return fetchAsset(dlRes.headers.location);
            }
            if (dlRes.statusCode !== 200) {
              console.error(`ดาวน์โหลดล้มเหลว: HTTP ${dlRes.statusCode}`);
              return;
            }
            const fileStream = fs.createWriteStream(targetFile);
            dlRes.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              console.log(`✓ ดาวน์โหลดและบันทึกเรียบร้อย: ${targetFile}`);
            });
          }).on('error', err => console.error('เกิดข้อผิดพลาดในการดาวน์โหลด:', err.message));
        }

        fetchAsset(asset.browser_download_url);
      } catch (e) {
        console.error('ประมวลผลข้อมูล Release ไม่สำเร็จ:', e.message);
      }
    });
  }).on('error', err => console.log('ไม่สามารถเชื่อมต่อ GitHub API ได้:', err.message));
}

if (require.main === module) {
  downloadLatest();
}

module.exports = { downloadLatest, checkExisting };
