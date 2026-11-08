// sidebar-doctor-assistant/assistant.js — Real-Time HOSxP Clinical Assistant
// ตามโมเดล รพ.บ้านด่านลานหอย (BDLH Clinical Decision Support)
'use strict';

let currentVn = null;
let currentHn = null;
let currentPatientName = '';
let currentPatientAge = null;
let currentPatientSex = null;
let currentPatientMeds = [];
let currentPatientData = null;
let currentCrcl = null;
let currentEgfr = null;
let currentScr = null;
let currentWeightTypeNote = 'Actual BW';
let currentRenalCriteria = 'hosxp'; // 'hosxp' (default) or 'kdigo'
let currentDoseWeightChoice = 'abw'; // 'abw' (default), 'adjbw', 'ibw'
let currentPtActualWeight = 0;
let currentPtHeight = 0;
let currentPtIbw = null;
let currentPtAdjBw = null;
let isPatientObese = false;
let isHistoryChartVisible = true;
let currentLiveDiag = '';
let currentModalMode = 'renal';
let currentActiveModalTab = 'trend';
let currentDoseFilter = 'action_required';
let pollTimer = null;
let selectedDays = 28;
let activeToastTimeout = null;
let searchDebounceTimer = null;
let sharedAudioContext = null;
let audioEnabled = true;
let assistantSessionActive = false;
let lastSessionHeartbeatAt = 0;
let assistantAuthMode = '';

function setAssistantSessionActive(active, user = '', authMode = '') {
  const wasActive = assistantSessionActive;
  const previousAuthMode = assistantAuthMode;
  const locked = !active;
  assistantSessionActive = !!active;
  assistantAuthMode = active ? authMode : '';
  document.body.classList.toggle('session-locked', locked);
  const overlay = document.getElementById('sessionLockOverlay');
  const message = document.getElementById('sessionLockMessage');
  if (message) message.textContent = locked ? 'เข้าสู่ระบบด้วยบัญชี HOSxP ได้ แม้ไม่ได้เปิดโปรแกรม HOSxP' : (authMode === 'manual' ? `เข้าสู่ระบบแล้ว · ${user}` : `ตรวจพบ session HOSxP · ${user}`);
  const logoutButton = document.getElementById('btnSessionLogout');
  if (logoutButton) logoutButton.hidden = !(active && authMode === 'manual');
  if (locked) {
    currentVn = null; currentHn = null; currentPatientName = ''; currentPatientData = null; currentPatientMeds = [];
    currentLiveDiag = ''; lastHosxpVn = null; isManualSearchActive = false;
    const name = document.getElementById('patientName'); if (name) name.textContent = 'รอคนไข้จาก HOSxP...';
    const hn = document.getElementById('patientHnBadge'); if (hn) hn.textContent = 'HN -';
    const vn = document.getElementById('patientVn'); if (vn) vn.textContent = '-';
    const vnDt = document.getElementById('patientVnDatetime'); if (vnDt) { vnDt.textContent = ''; vnDt.style.display = 'none'; }
    const ccRow = document.getElementById('patientCcRow'); if (ccRow) ccRow.style.display = 'none';
    const erBanner = document.getElementById('erRevisitBanner'); if (erBanner) erBanner.style.display = 'none'; const readmBanner = document.getElementById('readmissionBanner'); if (readmBanner) readmBanner.style.display = 'none'; const gapBanner = document.getElementById('careGapBanner'); if (gapBanner) gapBanner.style.display = 'none'; const recMedsCard = document.getElementById('recentMedsCard'); if (recMedsCard) recMedsCard.style.display = 'none'; const sepBanner = document.getElementById('sepsisBanner'); if (sepBanner) sepBanner.style.display = 'none'; const denBanner = document.getElementById('dengueBanner'); if (denBanner) denBanner.style.display = 'none';
    const allergy = document.getElementById('allergyBanner'); if (allergy) allergy.hidden = true;
  }
  if (overlay) overlay.hidden = !locked;
  if (wasActive && active && previousAuthMode === 'manual' && authMode === 'companion') {
    // The server has revoked the direct-login cookie. Reload to remove any patient
    // details opened during manual mode before syncing the HOSxP-selected patient.
    window.location.reload();
    return;
  }
  // Discard the previous page DOM and any still-rendered clinical data as soon as
  // the server reports that the active HOSxP session has ended or expired.
  if (wasActive && locked) window.location.reload();
}

let lastHosxpVn = null;
let lastHandledClickId = 0;
let isManualSearchActive = false;

let currentHistoryType = null;
let currentHistoryLimit = 10;
let currentHistoryTitle = '';
let currentHistorySubtitle = '';


// ─── ฐานข้อมูลแนวทางการปรับขนาดยาตามค่าการทำงานของไต (CrCl / eGFR Dosage Adjustment Guidelines) ───
const RENAL_DOSE_GUIDELINES = [
  {
    id: 'metformin',
    name: 'Metformin',
    category: 'dm',
    catName: 'ยารักษาเบาหวาน',
    matchRegex: /metformin|glifor|glucophage/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'contraindicated',
          badgeText: '🚫 ห้ามใช้เด็ดขาด (Contraindicated)',
          recommendation: 'ต้องหยุดยา Metformin ทันที เสี่ยงเกิดภาวะ Lactic Acidosis รุนแรงถึงแก่ชีวิต',
          caution: 'เมื่อ eGFR/CrCl < 30 mL/min แนะนำเปลี่ยนไปใช้กลุ่ม Insulin หรือยาที่ไม่ขับทางไต'
        };
      } else if (crcl < 45) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา (Max 1,000 mg/d)',
          recommendation: 'ปรับลดขนาดไม่เกิน 1,000 mg/วัน (แบ่งให้วันละ 500 mg x 2 ครั้ง) และห้ามเริ่มยาในผู้ป่วยรายใหม่',
          caution: 'ติดตามค่า Creatinine และ eGFR ทุก 3 เดือน'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'สามารถใช้ขนาดยามาตรฐานได้ (สูงสุดไม่เกิน 2,000 mg/วัน)',
        caution: 'ระวังหากมีภาวะขาดน้ำเฉียบพลัน หรือก่อนฉีดสารทึบรังสี'
      };
    }
  },
  {
    id: 'glibenclamide',
    name: 'Glibenclamide',
    category: 'dm',
    catName: 'ยารักษาเบาหวาน',
    matchRegex: /glibenclamide|daonil/i,
    evaluate: (crcl) => {
      if (crcl < 50) {
        return {
          status: 'contraindicated',
          badgeText: '🚫 หลีกเลี่ยงการใช้ (Avoid)',
          recommendation: 'หลีกเลี่ยงการใช้เด็ดขาด เนื่องจากสารเมทาบอไลต์ออกฤทธิ์ขับทางไต ทำให้เกิดภาวะน้ำตาลในเลือดต่ำรุนแรงและยาวนาน (Severe Prolonged Hypoglycemia)',
          caution: 'แนะนำเปลี่ยนเป็น Glipizide (ขับทางตับ) หรือ Insulin'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยาปกติ 2.5 - 10 mg/วัน ก่อนอาหารเช้า',
        caution: 'ระวังอาการน้ำตาลต่ำในผู้สูงอายุ'
      };
    }
  },
  {
    id: 'glipizide',
    name: 'Glipizide',
    category: 'dm',
    catName: 'ยารักษาเบาหวาน',
    matchRegex: /glipizide|minidiab/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา',
          recommendation: 'เริ่มต้นที่ขนาดต่ำสุด 2.5 mg วันละ 1 ครั้ง ก่อนอาหารเช้า',
          caution: 'ติดตามอาการเหงื่อออก ใจสั่น หน้ามืด จากน้ำตาลตกใกล้ชิด'
        };
      } else if (crcl < 50) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ระมัดระวัง',
          recommendation: 'เริ่มต้นขนาด 2.5 - 5 mg/วัน ปรับขนาดยาอย่างระมัดระวัง',
          caution: 'ปลอดภัยกว่า Glibenclamide ในผู้ป่วยไตบกพร่อง'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยาปกติ 5 - 15 mg/วัน ก่อนอาหาร',
        caution: 'ทานยาตรงเวลาสม่ำเสมอ'
      };
    }
  },
  {
    id: 'nsaids',
    name: 'NSAIDs (Ibuprofen, Naproxen, Diclofenac, Celecoxib)',
    category: 'nsaids',
    catName: 'ยาแก้ปวด/ลดการอักเสบ',
    matchRegex: /ibuprofen|naproxen|diclofenac|celecoxib|meloxicam|mefenamic|voltaren|celebrex/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'contraindicated',
          badgeText: '🚫 ห้ามใช้เด็ดขาด (Contraindicated)',
          recommendation: 'ห้ามใช้ยาแก้ปวดกลุ่ม NSAIDs เด็ดขาด ยาจะยับยั้ง Renal Prostaglandins ส่งผลให้ไตขาดเลือดและเร่งไตวายระยะสุดท้าย (ESRD)',
          caution: 'ใช้ Paracetamol หรือ ยาทาภายนอก / กายภาพบำบัดทดแทน'
        };
      } else if (crcl < 60) {
        return {
          status: 'reduce',
          badgeText: '⚠️ หลีกเลี่ยง / ใช้สั้นที่สุด',
          recommendation: 'ควรหลีกเลี่ยงการใช้ต่อเนื่อง หากจำเป็นอย่างยิ่งให้ใช้ขนาดต่ำสุดไม่เกิน 3-5 วัน',
          caution: 'ติดตามค่า Creatinine และตรวจอาการบวมน้ำ/ความดันขึ้น'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ตามความจำเป็น',
        recommendation: 'ใช้ระยะสั้นตามอาการ ดื่มน้ำตามมากๆ',
        caution: 'ระวังการใช้ร่วมกับ ACEI/ARB (เสี่ยง Triple Whammy ทำลายไต)'
      };
    }
  },
  {
    id: 'allopurinol',
    name: 'Allopurinol',
    category: 'gout',
    catName: 'ยารักษาโรคเกาต์',
    matchRegex: /allopurinol|zyloric/i,
    evaluate: (crcl) => {
      if (crcl < 10) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดวิกฤต',
          recommendation: 'ขนาดยาไม่เกิน 100 mg วันเว้นวัน หรือ ทุก 3 วัน (หรือ 50 mg วันละครั้ง)',
          caution: 'เสี่ยง Allopurinol Hypersensitivity Syndrome (AHS) สูงมากในผู้ป่วยไตเสื่อม'
        };
      } else if (crcl < 20) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา',
          recommendation: 'ขนาดยาสูงสุดไม่เกิน 100 mg/วัน',
          caution: 'เริ่มจาก 50-100 mg/วัน เฝ้าระวังผื่นคันและตุ่มน้ำ'
        };
      } else if (crcl < 50) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา',
          recommendation: 'ขนาดยาสูงสุด 100 - 200 mg/วัน',
          caution: 'ติดตาม Serum Uric Acid และการทำงานของตับไต'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยาปกติ 100 - 300 mg/วัน หลังอาหารทันที',
        caution: 'ดื่มน้ำวันละอย่างน้อย 2 ลิตร'
      };
    }
  },
  {
    id: 'colchicine',
    name: 'Colchicine',
    category: 'gout',
    catName: 'ยารักษาโรคเกาต์',
    matchRegex: /colchicine/i,
    evaluate: (crcl) => {
      if (crcl < 10) {
        return {
          status: 'contraindicated',
          badgeText: '🚫 ห้ามใช้ (Contraindicated)',
          recommendation: 'ห้ามใช้ในผู้ป่วย CrCl < 10 mL/min ยาจะสะสมในเนื้อเยื่อและเกิดพิษต่อกล้ามเนื้อและประสาทรุนแรง (Neuromyopathy)',
          caution: 'พิจารณาใช้ยาลดปวดกลุ่มอื่นที่ปลอดภัย'
        };
      } else if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยามาก',
          recommendation: 'ขนาด 0.6 mg (1 เม็ด) วันเว้นวัน หรือ ไม่เกิน 0.3 mg/วัน',
          caution: 'ห้ามให้ยาซ้ำในรอบ 2 สัปดาห์กรณี Acute Gout Attack'
        };
      } else if (crcl < 50) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา',
          recommendation: 'ขนาดยาไม่เกิน 0.6 mg วันละ 1 ครั้ง',
          caution: 'ระวังอาการท้องเสียและปวดกล้ามเนื้อ'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: '0.6 mg วันละ 1-2 ครั้ง ตามข้อบ่งชี้',
        caution: 'หยุดยาทันทีหากมีอาการท้องเสียรุนแรง'
      };
    }
  },
  {
    id: 'enalapril',
    name: 'Enalapril (ACEI) / Losartan (ARB)',
    category: 'cv',
    catName: 'ยาลดความดัน/หัวใจ',
    matchRegex: /enalapril|losartan|captopril|ramipril/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาด 50%',
          recommendation: 'เริ่มต้นที่ขนาดต่ำสุด 2.5 mg วันละ 1 ครั้ง และปรับเพิ่มอย่างระมัดระวัง',
          caution: 'ต้องตรวจติดตามค่า Serum Potassium (K+) และ Creatinine ภายใน 1-2 สัปดาห์ (เสี่ยง Hyperkalemia)'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ชะลอไตเสื่อม (Renoprotective)',
        recommendation: 'ขนาดยา 5 - 20 mg/วัน ช่วยลดความดันและชะลอการเสื่อมของไตในระยะ 1-3',
        caution: 'ระวังการเกิดไอแห้ง (Enalapril)'
      };
    }
  },
  {
    id: 'gabapentin',
    name: 'Gabapentin',
    category: 'neuro',
    catName: 'ยาแก้ปวดปลายประสาท',
    matchRegex: /gabapentin|neurontin/i,
    evaluate: (crcl) => {
      if (crcl < 15) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดวิกฤต',
          recommendation: 'ขนาดยา 100 - 300 mg วันเว้นวัน หรือวันละ 1 ครั้งก่อนนอน',
          caution: 'ระวังอาการง่วงซึม สับสน กล้ามเนื้ออ่อนแรง เสี่ยงหกล้มสูง'
        };
      } else if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาด',
          recommendation: 'ขนาดยา 200 - 700 mg วันละ 1 ครั้งก่อนนอน',
          caution: 'ไตขับออกลดลงอย่างมาก ยาสะสมในกระแสเลือด'
        };
      } else if (crcl < 60) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาดยา',
          recommendation: 'ขนาดยา 200 - 700 mg วันละ 2 ครั้ง (BID)',
          caution: 'เริ่มจากขนาดยาต่ำแล้วค่อยๆ ปรับขึ้น'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยา 300 - 1,200 mg วันละ 3 ครั้ง (TID)',
        caution: 'ปรับขนาดยาทีละน้อยตามการตอบสนอง'
      };
    }
  },
  {
    id: 'ciprofloxacin',
    name: 'Ciprofloxacin',
    category: 'antibiotics',
    catName: 'ยาปฏิชีวนะ',
    matchRegex: /ciprofloxacin|ciprobay/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับลดขนาด 50%',
          recommendation: 'ขนาดยา 250 - 500 mg ทุก 18 - 24 ชั่วโมง (วันละครั้ง)',
          caution: 'ยาสะสมเสี่ยงต่อพิษระบบประสาทและหัวใจ (QT Prolongation)'
        };
      } else if (crcl < 50) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับขนาดยา',
          recommendation: 'ขนาดยา 250 - 500 mg ทุก 12 ชั่วโมง',
          caution: 'ดื่มน้ำมากๆ เพื่อป้องกันผลึกยาในปัสสาวะ'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยา 250 - 500 mg ทุก 12 ชั่วโมง',
        caution: 'รับประทานติดต่อกันจนครบตามแผนการรักษา'
      };
    }
  },
  {
    id: 'amoxicillin',
    name: 'Amoxicillin / Augmentin',
    category: 'antibiotics',
    catName: 'ยาปฏิชีวนะ',
    matchRegex: /amoxicillin|augmentin|amoxi/i,
    evaluate: (crcl) => {
      if (crcl < 10) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับความถี่',
          recommendation: 'ขนาดยา 250 - 500 mg ทุก 24 ชั่วโมง (วันละ 1 ครั้ง)',
          caution: 'เฝ้าระวังอาการแพ้ยาและอาการทางเดินอาหาร'
        };
      } else if (crcl < 30) {
        return {
          status: 'reduce',
          badgeText: '⚠️ ปรับความถี่',
          recommendation: 'ขนาดยา 250 - 500 mg ทุก 12 ชั่วโมง',
          caution: 'หลีกเลี่ยงสูตร 875/125 mg'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยาปกติ 500 mg ทุก 8 ชั่วโมง',
        caution: 'ทานยาต่อเนื่องตามแพทย์สั่ง'
      };
    }
  },
  {
    id: 'spironolactone',
    name: 'Spironolactone',
    category: 'cv',
    catName: 'ยาขับปัสสาวะ/หัวใจ',
    matchRegex: /spironolactone|aldactone/i,
    evaluate: (crcl) => {
      if (crcl < 30) {
        return {
          status: 'contraindicated',
          badgeText: '🚫 ห้ามใช้ (Contraindicated)',
          recommendation: 'ห้ามใช้ในผู้ป่วย CrCl < 30 หรือ eGFR < 30 เสี่ยงต่อภาวะโพแทสเซียมในเลือดสูงวิกฤต (Severe Fatal Hyperkalemia)',
          caution: 'หากจำเป็นต้องใช้ยาขับปัสสาวะ ให้พิจารณา Furosemide ทดแทน'
        };
      }
      return {
        status: 'standard',
        badgeText: '🟢 ใช้ขนาดยาปกติ',
        recommendation: 'ขนาดยา 12.5 - 25 mg วันละครั้ง',
        caution: 'ตรวจระดับ Potassium สม่ำเสมอ'
      };
    }
  }
];

// ─── ฐานข้อมูลยาสมุนไพรและอุปกรณ์กายภาพบำบัด (National Essential Drugs & Reimbursement) ───
const HERB_DATABASE = {
  'fah_talai_jone': {
    title: 'แคปซูลฟ้าทะลายโจร (Andrographis)',
    scientific: 'Andrographis paniculata (Burm.f.) Nees',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'บรรเทาอาการเจ็บคอ และอาการของโรคหวัด (Common Cold) เช่น ไอ เจ็บคอ มีน้ำมูก อ่อนเพลีย ช่วยลดการใช้ยาปฏิชีวนะ (Antibiotics) เกินความจำเป็น โดยรับประทานวันละ 1.5 - 3 กรัม แบ่งให้วันละ 3-4 ครั้ง (ไม่เกิน 5 วัน)',
    contraindication: '• ห้ามใช้ในหญิงตั้งครรภ์ และหญิงให้นมบุตร (อาจทำให้ทารกวิรูปได้)\n• ห้ามใช้ในผู้ที่เคยมีประวัติแพ้ฟ้าทะลายโจร หรือมีอาการผื่น ลมพิษ แน่นหน้าอก หายใจลำบากหลังรับประทาน',
    precaution: '• ระวังการใช้ร่วมกับสารกันเลือดเป็นลิ่ม (Warfarin) และยาต้านการจับตัวของเกล็ดเลือด (Aspirin, Clopidogrel)\n• ระวังการใช้ร่วมกับยาลดความดันโลหิต เพราะอาจเสริมฤทธิ์กันได้\n• หากใช้ติดต่อกันเกิน 3 วัน แล้วอาการไม่ดีขึ้นหรือรุนแรงขึ้น ควรหยุดใช้และพบแพทย์',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร พ.ศ. 2566 · สปสช. สนับสนุนการสั่งใช้ทดแทนยาปฏิชีวนะในโรคระบบทางเดินหายใจส่วนบน'
  },
  'makham_pom': {
    title: 'ยาอมมะขามป้อม (Emblica lozenge)',
    scientific: 'Phyllanthus emblica L.',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'บรรเทาอาการไอ ขับเสมหะ ชุ่มคอ ให้ความชุ่มชื้นแก่เยื่อบุทางเดินหายใจ อมครั้งละ 1-2 เม็ด เมื่อมีอาการไอหรือระคายคอ',
    contraindication: '• ผู้ป่วยที่มีภาวะท้องเสียรุนแรง (เนื่องจากมะขามป้อมมีฤทธิ์ระบายอ่อนๆ)',
    precaution: '• ระวังในผู้ป่วยเบาหวานกรณีสูตรผสมน้ำตาล (ควรเลือกชนิด Sugar-free)\n• สตรีมีครรภ์ควรปรึกษาแพทย์ก่อนใช้ขนาดสูง',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร'
  },
  'thao_wan_priang': {
    title: 'ยาแคปซูลสารสกัดเถาวัลย์เปรียง',
    scientific: 'Derris scandens (Roxb.) Benth.',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'บรรเทาอาการปวดกล้ามเนื้อ ลดการอักเสบ บรรเทาอาการปวดหลังส่วนล่าง (Low back pain) และข้อเข่าเสื่อม (Osteoarthritis) มีประสิทธิภาพบรรเทาปวดเทียบเท่ายา NSAIDs โดยระคายเคืองกระเพาะอาหารและไตน้อยกว่า',
    contraindication: '• สตรีมีครรภ์ หญิงให้นมบุตร และเด็ก\n• ผู้ที่มีประวัติแพ้เถาวัลย์เปรียง',
    precaution: '• ระวังการใช้ในผู้ป่วยโรคแผลเปื่อยเปปติก (Peptic ulcer)\n• อาจทำให้เกิดการระคายเคืองระบบทางเดินอาหาร คลื่นไส้ แน่นท้องในบางราย',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร พ.ศ. 2566 · แนะนำสั่งจ่ายทดแทนยาแก้ปวด NSAIDs ในผู้สูงอายุและผู้ป่วยโรคไต'
  },
  'plai_cream': {
    title: 'ครีมไพล / น้ำมันไพล / ยาหม่องไพล (GPO)',
    scientific: 'Zingiber cassumunar Roxb.',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'บรรเทาอาการปวดเมื่อย บวม เคล็ดขัดยอก ฟกช้ำ และกล้ามเนื้ออักเสบ ทาและถูนวดเบาๆ บริเวณที่มีอาการ วันละ 2 - 3 ครั้ง',
    contraindication: '• ห้ามทาบริเวณผิวหนังที่มีบาดแผลเปิด แผลสด หรือผิวหนังที่อักเสบติดเชื้อ',
    precaution: '• ยาใช้ภายนอกเท่านั้น ห้ามรับประทาน และระวังอย่าให้เข้าตา\n• หากเกิดผื่นคันหรือระคายเคืองควรหยุดใช้',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร'
  },
  'ls_support': {
    title: 'เสื้อพยุงหลัง (Lumbosacral Support / LS Support)',
    scientific: 'Physical Therapy Equipment / Medical Instrument',
    badge: 'อุปกรณ์กายภาพบำบัด (สปสช. เคลมชดเชยได้)',
    indication: 'จำกัดการเคลื่อนไหวของกระดูกสันหลังส่วนเอว บรรเทาอาการปวดหลังเฉียบพลันและเรื้อรัง (Low Back Pain), หมอนรองกระดูกสันหลังเสื่อมหรือกดทับเส้นประสาท, กล้ามเนื้อหลังอักเสบรุนแรง',
    contraindication: '• ผู้ป่วยที่มีแผลกดทับ แผลติดเชื้อบริเวณลำตัว หรือกระดูกสันหลังหักที่ไม่คงที่ (Unstable spine fracture)',
    precaution: '• ไม่ควรใส่ตลอด 24 ชั่วโมง และไม่ควรใส่ขณะนอนหลับ\n• ควรฝึกบริหารกล้ามเนื้อแกนกลางลำตัว (Core muscles) ควบคู่ เพื่อป้องกันกล้ามเนื้อลีบจากการพึ่งพาอุปกรณ์นานเกินไป',
    reference: 'สปสช. กองทุนอุปกรณ์และกายอุปกรณ์เทียม: อัตราจ่ายชดเชยอุปกรณ์ 1,000 บาท/ชิ้น (ต้นทุน รพ. ประมาณ 200 - 250 บาท) ช่วยเพิ่มรายได้ให้โรงพยาบาลและลดภาระค่าใช้จ่ายของผู้ป่วย (ตามโมเดล รพ.บ้านด่านลานหอย หน้า 20)'
  },
  'sahastara': {
    title: 'สหัสธาราแคปซูล (Sahastara)',
    scientific: 'Traditional Thai Polyherbal Formula',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'ขับลมในเส้น บรรเทาอาการปวดกล้ามเนื้อ ปวดข้อ ชาตามปลายมือปลายเท้า กล้ามเนื้อตึงตัว',
    contraindication: '• ผู้ที่มีไข้, สตรีมีครรภ์\n• ผู้ที่มีประวัติแพ้พืชวงศ์ขิงข่า หรือส่วนประกอบในตำรับ',
    precaution: '• ระวังการใช้ในผู้ป่วยความดันโลหิตสูงและโรคหัวใจ (ตำรับมีพริกไทยและดีปลีเป็นตัวยาขับลมร้อน)\n• ระวังการใช้ร่วมกับยาต้านการแข็งตัวของเลือด',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร'
  },
  'khamin_chan': {
    title: 'แคปซูลขมิ้นชัน (Turmeric)',
    scientific: 'Curcuma longa L.',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'บรรเทาอาการท้องอืด ท้องเฟ้อ จุกเสียด แน่นท้อง ขับลม รักษาแผลในกระเพาะอาหารและกรดไหลย้อน (GERD/Dyspepsia) รับประทานครั้งละ 2 แคปซูล วันละ 4 ครั้ง หลังอาหารและก่อนนอน',
    contraindication: '• ห้ามใช้ในผู้ป่วยที่มีการอุดตันท่อน้ำดี (Biliary obstruction) หรือมีนิ่วในท่อน้ำดี\n• หญิงตั้งครรภ์',
    precaution: '• ระวังการใช้ร่วมกับยาวาร์ฟาริน (Warfarin) และยาต้านเกล็ดเลือด เพราะอาจเสริมฤทธิ์การต้านการแข็งตัวของเลือด\n• ระวังการใช้ร่วมกับยารักษาโรคมะเร็งบางชนิด',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร · แนะนำใช้ทดแทนยาขับลม/ยาลดกรดแผนปัจจุบัน'
  },
  'chumhet_thet': {
    title: 'ยาชงชุมเห็ดเทศ (Senna alata)',
    scientific: 'Senna alata (L.) Roxb.',
    badge: 'บัญชียาหลักแห่งชาติ (สมุนไพร)',
    indication: 'ยาระบายสมุนไพรอ่อนๆ บรรเทาอาการท้องผูก (Constipation) ชงน้ำร้อนดื่มก่อนนอนเมื่อมีอาการ',
    contraindication: '• ผู้ป่วยที่มีภาวะลำไส้อุดตัน หรือปวดท้องรุนแรงโดยไม่ทราบสาเหตุ\n• หญิงตั้งครรภ์และหญิงให้นมบุตร',
    precaution: '• ไม่ควรใช้ติดต่อกันนานเกิน 1 สัปดาห์ เพราะอาจทำให้สูญเสียสมดุลเกลือแร่ (Electrolytes)\n• ดื่มน้ำตามมากๆ หลังรับประทาน',
    reference: 'บัญชียาหลักแห่งชาติ ด้านสมุนไพร'
  }
};

// ─── 1. เริ่มต้นระบบและดักจับพารามิเตอร์ ───
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('session-locked');
  fetch('/api/version').then(response => response.json()).then(info => {
    const node = document.getElementById('footerBuild');
    if (node) node.textContent = `Sidebar Doctor Assistant · v${info.version} · build ${info.build}`;
  }).catch(() => {});
  document.getElementById('openPrivacyPolicy')?.addEventListener('click', () => { document.getElementById('privacyPolicyModal').hidden = false; });
  document.getElementById('closePrivacyPolicy')?.addEventListener('click', () => { document.getElementById('privacyPolicyModal').hidden = true; });
  document.getElementById('privacyPolicyModal')?.addEventListener('click', event => { if (event.target.id === 'privacyPolicyModal') event.currentTarget.hidden = true; });
  document.getElementById('hosxpLoginForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const usernameInput = document.getElementById('loginUsername');
    const passwordInput = document.getElementById('loginPassword');
    const errorNode = document.getElementById('loginError');
    const submit = document.getElementById('loginSubmit');
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    errorNode.hidden = true;
    submit.disabled = true;
    submit.textContent = 'กำลังตรวจสอบ...';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      passwordInput.value = '';
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'เข้าสู่ระบบไม่สำเร็จ');
      await checkActiveSessionOnce();
    } catch (error) {
      passwordInput.value = '';
      errorNode.textContent = error.message || 'เข้าสู่ระบบไม่สำเร็จ';
      errorNode.hidden = false;
      passwordInput.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = 'เข้าสู่ระบบ';
    }
  });
  document.getElementById('btnSessionLogout')?.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { setAssistantSessionActive(false); }
  });
  setupAudioAlerts();
  const urlParams = new URLSearchParams(window.location.search);
  const qVn = urlParams.get('vn');
  const qHn = urlParams.get('hn');

  if (qVn) {
    loadPatientData(qVn, qHn);
  } else {
    // ตรวจหาคนไข้ปัจจุบันจาก HOSxP ทันทีที่เปิดหน้าต่าง
    checkActiveSessionOnce();
  }

  // เริ่ม Polling เช็คคนไข้ปัจจุบันจาก HOSxP Real-Time (ทุก 1.0 วิ)
  startActiveSessionPolling();

  // เมื่อหน้าต่างได้รับ Focus ให้เช็คซิงค์ทันที
  window.addEventListener('focus', checkActiveSessionOnce);

  // ปุ่ม Refresh: รีเซ็ตโหมดค้นหาเอง และดึงคนไข้ปัจจุบันจาก HOSxP ทันที
  document.getElementById('btnRefresh')?.addEventListener('click', () => {
    isManualSearchActive = false;
    checkActiveSessionOnce();
    if (lastHosxpVn) {
      loadPatientData(lastHosxpVn);
    } else if (currentVn) {
      loadPatientData(currentVn, currentHn);
    }
  });

  // ตั้งค่าแถบค้นหาผู้ป่วยอัจฉริยะ (HN, ชื่อ-สกุล, VN)
  setupPatientSearch();
  setupVisitPicker();

  // ตั้งค่าปุ่มปิด Modal ยาสมุนไพร
  document.getElementById('btnCloseHerbModal')?.addEventListener('click', closeHerbModal);
  document.getElementById('btnHerbModalDismiss')?.addEventListener('click', closeHerbModal);
  document.getElementById('herbModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'herbModal') closeHerbModal();
  });

  // ─── Click Handlers สำหรับดูประวัติย้อนหลัง 10 ครั้งล่าสุด (โมเดล รพ.บ้านด่านลานหอย) ───
  document.getElementById('boxBp')?.addEventListener('click', () => {
    openHistoryModal('vitals', 'ประวัติความดัน & ชีพจร', '', 'bp');
  });

  document.getElementById('vitalsStrip')?.addEventListener('click', () => {
    openHistoryModal('vitals', 'ประวัติน้ำหนัก & ส่วนสูง', '', 'bw');
  });

  document.getElementById('boxEgfr')?.addEventListener('click', () => {
    openHistoryModal('renal', 'ประวัติค่าไต', '', 'trend');
  });

  document.getElementById('boxCrcl')?.addEventListener('click', () => {
    openHistoryModal('renal', 'คำแนะนำการปรับขนาดยา', '', 'dose');
  });

  document.getElementById('boxSugar')?.addEventListener('click', () => {
    openHistoryModal('sugar', 'ประวัติตรวจน้ำตาล & HbA1c', '');
  });

  setupCopyPeButton();
  setupModalTabsAndDoseFilter();
  document.getElementById('btnToggleRecentMeds')?.addEventListener('click', () => {
    const body = document.getElementById('recentMedsBody');
    const arrow = document.getElementById('recentMedsArrow');
    if (!body) return;
    const isClosed = (body.style.display === 'none');
    body.style.display = isClosed ? 'block' : 'none';
    arrow?.classList.toggle('open', isClosed);
  });

  document.getElementById('btnCloseHistModal')?.addEventListener('click', closeHistoryModal);
  document.getElementById('btnHistClose')?.addEventListener('click', closeHistoryModal);
  document.getElementById('btnHistLoadMore')?.addEventListener('click', loadMoreHistory);
  document.getElementById('historyModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'historyModal') closeHistoryModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeHerbModal();
      closeHistoryModal();
    }
  });

  // ตั้งค่าชิปเลือกจำนวนวันคำนวณยา
  setupPillCalcChips();

  // ตั้งค่า Tooltip สไตล์ Modern Floating
  setupFloatingTooltip();

  // ตั้งค่าระบบปรับขนาดตัวอักษร Font Scaler
  setupFontScaler();
});

// ─── 2. Polling คอยตรวจว่าแพทย์เปลี่ยนคนไข้ใน HOSxP หรือไม่ ───
function startActiveSessionPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checkActiveSessionOnce, 1000);
}

async function checkActiveSessionOnce() {
  try {
    const res = await fetch('/api/sync-patient');
    if (!res.ok) {
      if (assistantSessionActive) setAssistantSessionActive(false);
      return;
    }
    const data = await res.json();
    if (!data) return;
    if (data.sessionActive) lastSessionHeartbeatAt = Date.now();
    setAssistantSessionActive(Boolean(data.sessionActive), data.user || '', data.authMode || '');
    if (!data.sessionActive) { setSyncState(false, 'รอ HOSxP'); return; }
    if (data.authMode === 'manual') { setSyncState(true, 'เข้าสู่ระบบแล้ว'); return; }

    // 1. ตรวจจับการกดไอคอนพี่หมอบน HOSxP โดยตรง (Event-driven Click Tracking)
    const isIconClick = (data.last_click_id && data.last_click_id > lastHandledClickId);
    if (isIconClick) {
      lastHandledClickId = data.last_click_id;
      isManualSearchActive = false; // ยกเลิกสถานะค้นหาเองทันทีเมื่อคลิกไอคอนพี่หมอ
      const targetVn = data.last_click_vn || data.vn;
      if (targetVn) {
        lastHosxpVn = targetVn;
        loadPatientData(targetVn);
      }
      return;
    }

    const currentHosxpVn = data.vn || null;
    const hosxpPatientChanged = (currentHosxpVn && currentHosxpVn !== lastHosxpVn);

    // 2. เมื่อแพทย์เลือกคนไข้ "คนใหม่จริง" ในโปรแกรม HOSxP (VN เปลี่ยนจากคนไข้เดิมใน HOSxP)
    if (hosxpPatientChanged) {
      console.log(`[Assistant] New patient chosen in HOSxP: ${currentHosxpVn} (was ${lastHosxpVn})`);
      lastHosxpVn = currentHosxpVn;
      isManualSearchActive = false; // เมื่อหมอเลือกคนไข้ใหม่ใน HOSxP ให้สลับตามทันที
      loadPatientData(currentHosxpVn, data.hn || null);
    } else if (!currentVn && currentHosxpVn) {
      // หน้าต่างเพิ่งเปิดขึ้นมาครั้งแรก
      lastHosxpVn = currentHosxpVn;
      loadPatientData(currentHosxpVn, data.hn || null);
    } else if (!isManualSearchActive && currentHosxpVn && currentHosxpVn !== currentVn) {
      loadPatientData(currentHosxpVn, data.hn || null);
    } else if (data.live_diag !== undefined && data.live_diag !== currentLiveDiag) {
      currentLiveDiag = data.live_diag || '';
      if (currentPatientData && (!isManualSearchActive || currentVn === currentHosxpVn)) {
        renderDrugAndHerbs(
          currentPatientData.patient || {},
          currentPatientData.screening || {},
          currentPatientData.labs || [],
          currentPatientData.diagnoses || [],
          currentPatientData.medications || [],
          currentPatientData.visit || {},
          currentPatientData.recentMeds30d || []
        );
      }
    }
  } catch (err) {
    // ออฟไลน์
    if (assistantSessionActive && Date.now() - lastSessionHeartbeatAt > 15000) setAssistantSessionActive(false);
  }
}

// ─── 3. โหลดข้อมูลคลินิกและผลแล็บจาก Server ───
async function loadPatientData(vn, hn) {
  if (!vn) return;
  const allergyBanner = document.getElementById('allergyBanner');
  if (allergyBanner) allergyBanner.hidden = true;
  const isChanged = (currentVn !== vn);
  if (isChanged) {
    currentLiveDiag = '';
  }
  currentVn = vn;
  currentHn = hn || null;

  setSyncState(true, isManualSearchActive ? 'ค้นหาเอง' : 'กำลังโหลด...');
  currentHn = hn || null;

  setSyncState(true, 'กำลังโหลด...');

  try {
    const res = await fetch(`/api/assistant/visit-data/${encodeURIComponent(vn)}`);
    if (res.status === 423) { setAssistantSessionActive(false); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'ไม่พบข้อมูล Visit');
    }

    renderAssistant(data, isChanged);
    setSyncState(true, 'ซิงค์อัตโนมัติ');
  } catch (err) {
    console.warn('[Assistant] Load error:', err);
    setSyncState(false, 'ขัดข้อง');
  }
}

// ─── 4. Render ข้อมูลสู่หน้าจอ Sidebar ───
function renderAssistant(d, isChanged = false) {
  const patient = d.patient || {};
  const visit = d.visit || {};
  const screening = d.screening || {};
  const appt = visit.appointment || d.appointment || {};
  const diag = d.diagnoses || [];
  const meds = d.medications || [];

  // เลื่อนหน้าต่างระบบขึ้นด้านบนสุดเสมอเมื่อเลือกคนไข้ใหม่
  const bodyEl = document.querySelector('.assistant-body');
  if (bodyEl) {
    bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // รวมรายการ Lab จาก nested structure ให้เป็น flat array พร้อมข้อมูลค่าปกติและการประเมิน
  const labs = [];
  (d.labResults || []).forEach(group => {
    if (Array.isArray(group.items)) {
      group.items.forEach(it => {
        labs.push({
          item_code: it.code || it.lab_items_code,
          item_name: it.name || it.item_name || '',
          result: it.result || '',
          unit: it.unit || '',
          abnormal: !!(it.abnormal || it.abnormal_result === 'Y'),
          critical: !!(it.critical || it.critical_result === 'Y'),
          normal_value: it.normal_value || it.lab_items_normal_value || it.lab_items_normal_value_ref || '',
          range_min: it.range_min,
          range_max: it.range_max,
          form_name: group.form_name || 'Lab'
        });
      });
    } else if (group.item_name || group.name) {
      labs.push({
        item_code: group.code || group.lab_items_code,
        item_name: group.item_name || group.name,
        result: group.result || '',
        unit: group.unit || '',
        abnormal: !!(group.abnormal || group.abnormal_result === 'Y'),
        critical: !!(group.critical || group.critical_result === 'Y'),
        normal_value: group.normal_value || '',
        range_min: group.range_min,
        range_max: group.range_max,
        form_name: group.form_name || 'Lab'
      });
    }
  });

  // บันทึกสถานะผู้ป่วยลง Global State
  currentPatientData = { ...d, labs };
  currentPatientMeds = meds || [];
  if (patient.hn) currentHn = patient.hn;
  currentPatientName = patient.name || '';
  currentPatientAge = patient.age || null;
  currentPatientSex = patient.sex || null;

  document.getElementById('patientName').textContent = patient.name || 'ไม่ระบุชื่อ';
  
  // เปลี่ยน queue-badge เป็น HN Badge
  const hnBadge = document.getElementById('patientHnBadge');
  if (hnBadge) hnBadge.textContent = patient.hn ? `HN ${patient.hn}` : 'HN -';

  // main_dep เป็น pill ไว้ด้านขวา (เน้นแสดงแผนกหลัก ovst.main_dep ก่อน)
  const depPill = document.getElementById('patientDepPill');
  const depName = visit.main_dep_name || visit.ovst_main_dep_name || visit.dep_name || visit.cur_dep_name || 'ห้องตรวจ';
  if (depPill) depPill.textContent = depName;

  document.getElementById('patientAge').textContent = `อายุ: ${patient.age_text || (patient.age ? patient.age + ' ปี' : '-')}`;
  
  const qWrap = document.getElementById('patientQueueWrap');
  const qText = document.getElementById('patientQueueText');
  if (visit.oqueue) {
    if (qWrap) qWrap.style.display = 'inline';
    if (qText) qText.textContent = `คิว: ${visit.oqueue}`;
  } else {
    if (qWrap) qWrap.style.display = 'none';
  }

  document.getElementById('patientVn').textContent = visit.vn || currentVn;
  const vnDtEl = document.getElementById('patientVnDatetime');
  if (vnDtEl) {
    if (visit.vstdate) {
      const dThai = visit.vstdate_thai_short || (typeof thaiDateShort === 'function' ? thaiDateShort(visit.vstdate) : (visit.vstdate_thai || visit.vstdate));
      const tText = visit.vsttime_short ? `${visit.vsttime_short} น.` : (visit.vsttime ? `${String(visit.vsttime).slice(0, 5)} น.` : '');
      vnDtEl.textContent = [dThai, tText].filter(Boolean).join(' ');
      vnDtEl.style.display = 'inline-block';
    } else {
      vnDtEl.textContent = '';
      vnDtEl.style.display = 'none';
    }
  }

  // แสดง Chief Complaint (CC / อาการสำคัญที่มาตรวจ)
  const ccRow = document.getElementById('patientCcRow');
  const ccVal = document.getElementById('patientCcVal');
  const ccText = (screening.cc || '').trim();
  if (ccRow && ccVal) {
    if (ccText) {
      ccRow.style.display = 'flex';
      ccVal.textContent = ccText;
    } else {
      ccRow.style.display = 'none';
    }
  }

  // แสดงประวัติแพ้ยาให้เห็นก่อนข้อมูลสุขภาพส่วนอื่น
  const allergyBanner = document.getElementById('allergyBanner');
  const allergyStatusLabel = document.getElementById('allergyStatusLabel');
  const allergyDetail = document.getElementById('allergyDetail');
  if (allergyBanner && allergyStatusLabel && allergyDetail) {
    allergyBanner.hidden = false;
    const allergyStatus = d.allergyStatus || 'unknown';
    allergyBanner.classList.remove('allergy-recorded', 'allergy-none', 'allergy-unknown');
    if (allergyStatus === 'recorded') {
      allergyBanner.classList.add('allergy-recorded');
      allergyStatusLabel.textContent = 'พบประวัติ';
      allergyDetail.textContent = d.allergyText || patient.drugallergy || 'พบประวัติแพ้ยา โปรดตรวจสอบรายละเอียดในเวชระเบียน';
    } else if (allergyStatus === 'none') {
      allergyBanner.classList.add('allergy-none');
      allergyStatusLabel.textContent = 'ไม่ทราบประวัติการแพ้';
      const detailText = String(d.allergyText || screening.found_allergy || '').trim();
      if (!detailText || /^(n|no|none|u|unknown|-)$/i.test(detailText)) {
        allergyDetail.textContent = 'ไม่พบประวัติการแพ้ยาในระบบ (โปรดยืนยันกับผู้ป่วยก่อนสั่งยา)';
      } else {
        allergyDetail.textContent = detailText;
      }
    } else {
      allergyBanner.classList.add('allergy-unknown');
      allergyStatusLabel.textContent = 'ยังไม่ทราบ';
      allergyDetail.textContent = 'ไม่พบข้อมูลประวัติแพ้ยาในช่องที่เชื่อมต่อ (ข้อมูลไม่ครบไม่ได้แปลว่าไม่มีประวัติแพ้ยา)';
    }
  }

  // แสดงการแจ้งเตือนกลับมาตรวจซ้ำที่ห้องฉุกเฉิน (ER Revisit ภายใน 48 ชม.)
  const erBanner = document.getElementById('erRevisitBanner');
  const erHoursBadge = document.getElementById('erHoursBadge');
  const erDetail = document.getElementById('erRevisitDetail');
  if (erBanner && erHoursBadge && erDetail) {
    if (d.erRevisit48h && d.erRevisit48h.hasRevisit) {
      const er = d.erRevisit48h;
      erBanner.style.display = 'block';
      const badgeText = er.intervalText ? `กลับมาใน ${er.intervalText}` : `${er.hoursAgo} ชม. ที่แล้ว`;
      erHoursBadge.textContent = badgeText;
      let infoText = `🗓️ <b>วันที่:</b> ${escapeHtml(er.vstdate_thai || er.vstdate)} (${escapeHtml(er.vsttime)} น.) · <b>แผนก:</b> ${escapeHtml(er.department)}`;
      if (er.cc) infoText += `<br>💬 <b>อาการที่มา ER:</b> ${escapeHtml(er.cc)}`;
      if (er.diag) infoText += `<br>🩺 <b>วินิจฉัย ER:</b> ${escapeHtml(er.diag)}`;
      if (er.doctor) infoText += ` <span style="color:#64748b">(${escapeHtml(er.doctor)})</span>`;
      erDetail.innerHTML = infoText;
    } else {
      erBanner.style.display = 'none';
    }
  }

  // 4. แสดงการแจ้งเตือน Sepsis / qSOFA
  const sepsisBanner = document.getElementById('sepsisBanner');
  const sepsisBadge = document.getElementById('sepsisBadge');
  const sepsisTitle = document.getElementById('sepsisTitle');
  const sepsisMessage = document.getElementById('sepsisMessage');
  const sepsisCriteria = document.getElementById('sepsisCriteria');
  const sepsisGuidance = document.getElementById('sepsisGuidance');
  if (sepsisBanner && sepsisBadge && sepsisTitle && sepsisMessage && sepsisCriteria && sepsisGuidance) {
    if (d.sepsisAlert && d.sepsisAlert.hasAlert) {
      const sa = d.sepsisAlert;
      sepsisBanner.style.display = 'block';
      sepsisBanner.className = 'clinical-alert-banner sepsis-banner ' + sa.severity;
      sepsisBadge.textContent = 'qSOFA ' + sa.qsofaScore + '/3';
      sepsisTitle.textContent = sa.title;
      sepsisMessage.textContent = sa.message;
      
      const c = sa.criteria || {};
      const v = sa.vitals || {};
      sepsisCriteria.innerHTML = 
        '<span class="alert-pill ' + (c.rr?.met ? 'met' : 'normal') + '">🫁 RR: <b>' + escapeHtml(c.rr?.val || '-') + '</b> ' + (c.rr?.met ? '⚠️' : '') + '</span>' +
        '<span class="alert-pill ' + (c.bps?.met ? 'met' : 'normal') + '">🩸 SBP: <b>' + escapeHtml(c.bps?.val || '-') + '</b> ' + (c.bps?.met ? '⚠️' : '') + '</span>' +
        '<span class="alert-pill ' + (c.ams?.met ? 'met' : 'normal') + '">🧠 สติ: <b>' + escapeHtml(c.ams?.val || '-') + '</b> ' + (c.ams?.met ? '⚠️' : '') + '</span>' +
        (v.temp && v.temp !== '-' ? '<span class="alert-pill normal">🌡️ T: ' + escapeHtml(v.temp) + '</span>' : '') +
        (v.pulse && v.pulse !== '-' ? '<span class="alert-pill normal">💓 P: ' + escapeHtml(v.pulse) + '</span>' : '');
      sepsisGuidance.innerHTML = '💡 <b>ข้อแนะนำทางคลินิก:</b> ' + escapeHtml(sa.guidance);
    } else {
      sepsisBanner.style.display = 'none';
    }
  }

  // 5. แสดงการแจ้งเตือนเฝ้าระวังไข้เลือดออก (Dengue)
  const dengueBanner = document.getElementById('dengueBanner');
  const dengueBadge = document.getElementById('dengueBadge');
  const dengueTitle = document.getElementById('dengueTitle');
  const dengueMessage = document.getElementById('dengueMessage');
  const dengueMetrics = document.getElementById('dengueMetrics');
  const dengueGuidance = document.getElementById('dengueGuidance');
  if (dengueBanner && dengueBadge && dengueTitle && dengueMessage && dengueMetrics && dengueGuidance) {
    if (d.dengueAlert && d.dengueAlert.hasAlert) {
      const da = d.dengueAlert;
      dengueBanner.style.display = 'block';
      dengueBanner.className = 'clinical-alert-banner dengue-banner ' + da.severity;
      dengueBadge.textContent = da.severity === 'critical' ? 'วิกฤต (Critical)' : 'เฝ้าระวัง (Warning)';
      dengueTitle.textContent = da.title;
      dengueMessage.textContent = da.message;
      
      dengueMetrics.innerHTML = 
        '<span class="alert-pill ' + (da.isHemoconcentration ? 'met' : 'normal') + '">🩸 Hct: <b>' + escapeHtml(da.currHct) + '</b> ' + (da.hctRisePct ? '(' + escapeHtml(da.hctRisePct) + ')' : '') + '</span>' +
        '<span class="alert-pill ' + (da.severity === 'critical' ? 'met' : 'normal') + '">🩹 เกล็ดเลือด: <b>' + escapeHtml(da.currPlt) + '</b></span>' +
        (da.baselineHct && da.baselineHct !== 'ไม่พบประวัติเดิม' ? '<span class="alert-pill normal">📊 Baseline Hct: ' + escapeHtml(da.baselineHct) + '</span>' : '');
      dengueGuidance.innerHTML = '💡 <b>ข้อแนะนำทางคลินิก:</b> ' + escapeHtml(da.guidance);
    } else {
      dengueBanner.style.display = 'none';
    }
  }

  // 1. แสดงการแจ้งเตือนเพิ่งจำหน่ายจากผู้ป่วยใน (IPD Readmission ภายใน 28 วัน)
  const readmBanner = document.getElementById('readmissionBanner');
  const readmBadge = document.getElementById('readmissionDaysBadge');
  const readmDetail = document.getElementById('readmissionDetail');
  if (readmBanner && readmBadge && readmDetail) {
    if (d.readmission28d && d.readmission28d.hasReadmission) {
      const r = d.readmission28d;
      readmBanner.style.display = 'block';
      readmBadge.textContent = `${r.daysAgo} วันที่แล้ว`;
      let infoText = `🗓️ <b>Discharge:</b> ${escapeHtml(r.dchdate_thai || r.dchdate)} (${escapeHtml(r.dchtime)} น.) · <b>ตึก:</b> ${escapeHtml(r.ward)}`;
      if (r.diag) infoText += `<br>🩺 <b>วินิจฉัยก่อนจำหน่าย:</b> ${escapeHtml(r.diag)}`;
      if (r.doctor) infoText += ` <span style="color:#64748b">(แพทย์: ${escapeHtml(r.doctor)})</span>`;
      readmDetail.innerHTML = infoText;
    } else {
      readmBanner.style.display = 'none';
    }
  }

  // 2. แสดงการแจ้งเตือนสิ่งที่ควรติดตามในโรคเรื้อรัง (Chronic Care Gap)
  const gapBanner = document.getElementById('careGapBanner');
  const gapCountBadge = document.getElementById('careGapCountBadge');
  const gapList = document.getElementById('careGapList');
  if (gapBanner && gapCountBadge && gapList) {
    if (d.careGap && d.careGap.hasGap && Array.isArray(d.careGap.gaps) && d.careGap.gaps.length > 0) {
      gapBanner.style.display = 'block';
      gapCountBadge.textContent = `${d.careGap.gaps.length} รายการ`;
      gapList.innerHTML = d.careGap.gaps.map(g => `
        <div class="care-gap-item">
          <div class="care-gap-item-left">
            <span class="care-gap-tag">${escapeHtml(g.label)}</span>
            <div class="care-gap-text">
              <b>${escapeHtml(g.reason)}</b>
              ${g.lastDate ? `<br><small style="color:#92400e;">ตรวจล่าสุด: ${escapeHtml(g.lastDate)} (ผล: <b>${escapeHtml(g.lastValue)}</b>)</small>` : ''}
            </div>
          </div>
          <button type="button" class="btn-gap-chart" onclick="openLabHistory('${escapeHtml(g.type)}')" title="คลิกเพื่อดูกราฟแนวโน้ม ${escapeHtml(g.label)}">
            📈 ดูกราฟ
          </button>
        </div>
      `).join('');
    } else {
      gapBanner.style.display = 'none';
    }
  }

  // 3. แสดงรายการยาเดิมที่ได้รับในรอบ 30 วัน (Drug Overlap Check)
  const recentMedsCard = document.getElementById('recentMedsCard');
  const recentMedsCount = document.getElementById('recentMedsCount');
  const recentMedsList = document.getElementById('recentMedsList');
  if (recentMedsCard && recentMedsCount && recentMedsList) {
    const list = d.recentMeds30d || [];
    if (list.length > 0) {
      recentMedsCard.style.display = 'block';
      recentMedsCount.textContent = list.length;
      recentMedsList.innerHTML = list.map(m => `
        <div class="recent-med-item">
          <div class="recent-med-top">
            <span class="recent-med-name">${escapeHtml(m.name)} ${escapeHtml(m.strength || '')} <small style="color:#0f766e; font-weight:700;">x ${m.qty} ${escapeHtml(m.units || '')}</small></span>
            <span class="recent-med-time">${escapeHtml(m.vstdate_thai)} (${m.daysAgo} วันที่แล้ว)</span>
          </div>
          <div class="recent-med-usage">วิธีใช้: ${escapeHtml(m.usage)}</div>
        </div>
      `).join('');
    } else {
      recentMedsCard.style.display = 'none';
    }
  }

  // แถบน้ำหนัก ส่วนสูง และ BMI (vitals-strip)
  const bwVal = parseFloat(screening.bw);
  const htVal = parseFloat(screening.height);
  const bmiVal = parseFloat(screening.bmi);
  const elBw = document.getElementById('valBw');
  const elHt = document.getElementById('valHeight');
  const elBmi = document.getElementById('valBmi');
  if (elBw) elBw.textContent = (!isNaN(bwVal) && bwVal > 0) ? bwVal.toFixed(1) : '-';
  if (elHt) elHt.textContent = (!isNaN(htVal) && htVal > 0) ? Math.round(htVal) : '-';
  if (elBmi) elBmi.textContent = (!isNaN(bmiVal) && bmiVal > 0) ? bmiVal.toFixed(1) : '-';

  // คำนวณไต & สัญญาณชีพ
  const renalData = renderRenalAndVitals(patient, screening, labs);
  currentEgfr = renalData.egfr;
  currentCrcl = renalData.crcl;
  currentScr = renalData.cr;

  // ผลแล็บผิดปกติ (ส่งกลุ่มใบสั่งตรวจ d.labResults เพื่อจัดกลุ่มย่อ/ขยาย)
  const labAlertCount = renderLabAlerts(d.labResults || [], labs);

  // คำเตือนยา & เสนอยาสมุนไพร
  const herbAlertData = renderDrugAndHerbs(patient, screening, labs, diag, meds, visit, d.recentMeds30d || []);

  // วันนัด & คำนวณจำนวนเม็ดยา
  renderAppointmentAndCalc(appt);

  // 🔔 แสดง Alert Toast ทุกครั้งที่มีการเปลี่ยนผู้ป่วย / สลับ VN
  showPatientAlertToast({
    patient,
    visit,
    screening,
    renal: renalData,
    labCount: labAlertCount,
    herb: herbAlertData
  });
}

// ─── 4.1 ฟังก์ชันคำนวณไต & สัญญาณชีพ ───
function renderRenalAndVitals(patient, screening, labs) {
  // 1. Serum Creatinine
  let cr = null;
  const crLab = labs.find(l => /creatinine|cr\b/i.test(l.item_name || ''));
  if (crLab && !isNaN(parseFloat(crLab.result))) {
    cr = parseFloat(crLab.result);
  } else if (screening.cr && !isNaN(parseFloat(screening.cr)) && parseFloat(screening.cr) > 0) {
    cr = parseFloat(screening.cr);
  }

  // 2. Blood Pressure
  const bps = parseInt(screening.bps) || null;
  const bpd = parseInt(screening.bpd) || null;
  const bpEl = document.getElementById('valBp');
  const bpBox = document.getElementById('boxBp');
  const bpStatus = document.getElementById('valBpStatus');
  let isHighBp = false;

  if (bps && bpd) {
    bpEl.textContent = `${bps}/${bpd}`;
    if (bps >= 140 || bpd >= 90) {
      bpBox.className = 'metric-box clickable-metric stage-warn';
      bpStatus.textContent = '⚠️ ความดันโลหิตสูง';
      isHighBp = true;
    } else {
      bpBox.className = 'metric-box clickable-metric stage-good';
      bpStatus.textContent = `ปกติ (ชีพจร: ${screening.pulse || '-'} bpm)`;
    }
  } else {
    bpEl.textContent = '-/-';
    bpBox.className = 'metric-box clickable-metric';
    bpStatus.textContent = 'รอวัดความดัน';
  }

  // 3. eGFR (CKD-EPI)
  let egfr = null;
  const egfrLab = labs.find(l => /egfr/i.test(l.item_name || ''));
  if (egfrLab && !isNaN(parseFloat(egfrLab.result))) {
    egfr = parseFloat(egfrLab.result);
  } else if (screening.egfr && !isNaN(parseFloat(screening.egfr)) && parseFloat(screening.egfr) > 0) {
    egfr = parseFloat(screening.egfr);
  }

  const age = parseInt(patient.age_y) || parseInt(patient.age) || 50;
  const isFemale = (patient.sex === '2' || patient.sex === 'หญิง');
  currentPtActualWeight = parseFloat(screening.bw) || parseFloat(screening.weight) || 0;
  currentPtHeight = parseFloat(screening.height) || 0;
  currentPtIbw = null;
  currentPtAdjBw = null;
  isPatientObese = false;

  if (currentPtHeight > 0) {
    const heightInches = currentPtHeight / 2.54;
    if (heightInches > 60) {
      currentPtIbw = isFemale ? (45.5 + 2.3 * (heightInches - 60)) : (50.0 + 2.3 * (heightInches - 60));
    } else {
      currentPtIbw = isFemale ? 45.5 : 50.0;
    }

    if (currentPtActualWeight > 0 && currentPtIbw > 0) {
      if (currentPtActualWeight > 1.2 * currentPtIbw) {
        isPatientObese = true;
        currentPtAdjBw = currentPtIbw + 0.4 * (currentPtActualWeight - currentPtIbw);
      }
    }
  }

  // ถ้าไม่มี eGFR จากแล็บแต่มี Cr ให้คำนวณสูตร CKD-EPI 2021 (Race-free equation)
  if (!egfr && cr && cr > 0) {
    const k = isFemale ? 0.7 : 0.9;
    const a = isFemale ? -0.241 : -0.302;
    egfr = 142 * Math.pow(Math.min(cr / k, 1), a) * Math.pow(Math.max(cr / k, 1), -1.200) * Math.pow(0.9938, age) * (isFemale ? 1.012 : 1.0);
    egfr = Math.round(egfr * 10) / 10;
  }

  const egfrEl = document.getElementById('valEgfr');
  const egfrBox = document.getElementById('boxEgfr');
  const ckdEl = document.getElementById('valCkdStage');
  let ckdStageText = 'ไม่มีผล Cr';

  // ค่าเริ่มต้นบน Dashboard แสดง Stage 1-5 แบบคุ้นเคย (และมี Toggle สลับ KDIGO ได้ในป๊อปอัป)
  if (egfr && egfr > 0) {
    egfrEl.textContent = Math.round(egfr);
    if (egfr >= 90) {
      ckdStageText = '🟢 Stage 1';
      egfrBox.className = 'metric-box clickable-metric stage-good';
    } else if (egfr >= 60) {
      ckdStageText = '🟡 Stage 2';
      egfrBox.className = 'metric-box clickable-metric stage-good';
    } else if (egfr >= 45) {
      ckdStageText = '🟠 Stage 3a';
      egfrBox.className = 'metric-box clickable-metric stage-warn';
    } else if (egfr >= 30) {
      ckdStageText = '🟠 Stage 3b';
      egfrBox.className = 'metric-box clickable-metric stage-warn';
    } else if (egfr >= 15) {
      ckdStageText = '🔴 Stage 4';
      egfrBox.className = 'metric-box clickable-metric stage-danger';
    } else {
      ckdStageText = '🔴 Stage 5';
      egfrBox.className = 'metric-box clickable-metric stage-danger';
    }
    ckdEl.textContent = ckdStageText;
    egfrBox.title = 'สูตร CKD-EPI (คลิกดูประวัติ หรือสลับเกณฑ์สากล KDIGO ในป๊อปอัป)';
  } else {
    egfrEl.textContent = '-';
    egfrBox.className = 'metric-box clickable-metric';
    ckdEl.textContent = 'ไม่มีผล Cr';
  }

  // 4. CrCl (Cockcroft-Gault) ค่าเริ่มต้นคำนวณจากน้ำหนักจริง Actual BW ที่คุ้นเคย
  let crcl = null;
  if (screening.crcl && !isNaN(parseFloat(screening.crcl)) && parseFloat(screening.crcl) > 0) {
    crcl = parseFloat(screening.crcl);
  } else if (cr && cr > 0 && currentPtActualWeight > 0 && age > 0) {
    crcl = ((140 - age) * currentPtActualWeight) / (72 * cr);
    if (isFemale) crcl *= 0.85;
  }

  const crclEl = document.getElementById('valCrcl');
  const scrEl = document.getElementById('valScr');
  if (crcl && crcl > 0) {
    crclEl.textContent = Math.round(crcl);
    scrEl.textContent = cr ? `Cr: ${cr} mg/dL` : 'Cr: -';
  } else {
    crclEl.textContent = '-';
    scrEl.textContent = cr ? `Cr: ${cr} mg/dL` : 'Cr: -';
  }

  // 5. FBS / HbA1c
  const fbsLab = labs.find(l => /fbs|glucose/i.test(l.item_name || ''));
  const hba1cLab = labs.find(l => /hba1c/i.test(l.item_name || ''));
  const fbsVal = fbsLab ? fbsLab.result : (screening.fbs && parseFloat(screening.fbs) > 0 ? screening.fbs : '-');
  document.getElementById('valFbs').textContent = fbsVal;
  document.getElementById('valHba1c').textContent = hba1cLab ? `HbA1c: ${hba1cLab.result}%` : 'HbA1c: -';

  return {
    cr,
    egfr: egfr ? Math.round(egfr) : null,
    crcl: crcl ? Math.round(crcl) : null,
    ckdStageText,
    bps,
    bpd,
    isHighBp
  };
}

// ─── ฟังก์ชันประเมินผลแล็บทุกรายการใน HOSxP ว่าผิดปกติหรือไม่ ───
function evaluateLabResult(l) {
  const resultStr = String(l.result || '').trim();
  const val = parseFloat(resultStr.replace(/,/g, ''));
  const hasNum = !isNaN(val);
  const name = (l.item_name || '').toLowerCase();
  const normStr = String(l.normal_value || '').trim();

  let isAbnormal = false;
  let isCritical = !!l.critical;
  let direction = ''; // 'high', 'low', 'critical', 'abnormal'

  // 1. ตรวจสอบสถานะโดยตรงจาก HOSxP (lab_order.abnormal_result หรือ critical_result)
  if (l.critical) {
    isAbnormal = true;
    isCritical = true;
    direction = 'critical';
  } else if (l.abnormal) {
    isAbnormal = true;
  }

  // 2. ตรวจสอบเทียบกับช่วงค่าปกติ (normal_value) จากระบบ HOSxP (ตัด comma ออกเพื่อรองรับเช่น 140,000-400,000)
  const cleanNorm = normStr.replace(/,/g, '');
  if (cleanNorm && hasNum) {
    // ช่วงตัวเลข min - max (เช่น 70-115, 3.50-5.50, 10 - 50, 140000 - 400000)
    const rangeMatch = cleanNorm.match(/([0-9.]+)\s*[-–—]\s*([0-9.]+)/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      if (!isNaN(min) && val < min) {
        isAbnormal = true;
        direction = 'low';
      } else if (!isNaN(max) && val > max) {
        isAbnormal = true;
        direction = 'high';
      }
    } else {
      // รูปแบบ < X หรือ <= X
      const lessMatch = cleanNorm.match(/[<≤]\s*([0-9.]+)/);
      if (lessMatch) {
        const max = parseFloat(lessMatch[1]);
        if (!isNaN(max) && val > max) {
          isAbnormal = true;
          direction = 'high';
        }
      }
      // รูปแบบ > X หรือ >= X
      const greaterMatch = cleanNorm.match(/[>≥]\s*([0-9.]+)/);
      if (greaterMatch) {
        const min = parseFloat(greaterMatch[1]);
        if (!isNaN(min) && val < min) {
          isAbnormal = true;
          direction = 'low';
        }
      }
    }
  }

  // 3. ตรวจสอบผลเชิงคุณภาพ (Qualitative / Text Results)
  if (!hasNum || isNaN(val)) {
    if (/positive|reactive|detected|พบเชื้อ|trace|[1-4]\+/i.test(resultStr)) {
      isAbnormal = true;
      direction = 'abnormal';
    }
  }

  // 4. Clinical Knowledge Fallback สำหรับแล็บสำคัญมาตรฐาน รพ.
  if (hasNum) {
    // ตรวจสอบ Potassium (ป้องกันการสับสนกับ Anion Gap with K+)
    if (!/gap/i.test(name) && (/potassium/i.test(name) || /^\s*k(\+)?\s*$/i.test(name) || /^\s*k\s*\(/i.test(name))) {
      if (val < 3.5) { isAbnormal = true; direction = 'low'; if (val < 2.8) isCritical = true; }
      else if (val > 5.1) { isAbnormal = true; direction = 'high'; if (val > 6.0) isCritical = true; }
    } else if (/gap with k|anion gap/i.test(name)) {
      // Anion Gap with K+ เป็นดัชนีคำนวณ ไม่ใช่ Potassium (K)
      // ไม่เตือนค่าต่ำเพราะไม่ใช่ K และไม่มีนัยสำคัญทางคลินิก เตือนเฉพาะ High Anion Gap Metabolic Acidosis (>= 28)
      if (val >= 28) { isAbnormal = true; direction = 'high'; isCritical = true; }
    } else if (!/gap/i.test(name) && (/sodium/i.test(name) || /^\s*na(\+)?\s*$/i.test(name) || /^\s*na\s*\(/i.test(name))) {
      if (val < 135) { isAbnormal = true; direction = 'low'; if (val < 125) isCritical = true; }
      else if (val > 145) { isAbnormal = true; direction = 'high'; if (val > 155) isCritical = true; }
    } else if (/creatinine|\bcr\b/i.test(name) && !/crp|clearance/i.test(name)) {
      if (val > 1.2) { isAbnormal = true; direction = 'high'; if (val >= 2.5) isCritical = true; }
    } else if (/bun\b/i.test(name)) {
      if (val > 20) { isAbnormal = true; direction = 'high'; }
    } else if (/fbs|glucose|fpg\b/i.test(name)) {
      if (val < 70) { isAbnormal = true; direction = 'low'; if (val < 50) isCritical = true; }
      else if (val >= 126) { isAbnormal = true; direction = 'high'; if (val >= 300) isCritical = true; }
    } else if (/hba1c/i.test(name)) {
      if (val > 7.0) { isAbnormal = true; direction = 'high'; }
    } else if (/uric/i.test(name)) {
      if (val > 7.0) { isAbnormal = true; direction = 'high'; }
    } else if (/sgot|ast\b/i.test(name)) {
      if (val > 40) { isAbnormal = true; direction = 'high'; if (val > 200) isCritical = true; }
    } else if (/sgpt|alt\b/i.test(name)) {
      if (val > 40) { isAbnormal = true; direction = 'high'; if (val > 200) isCritical = true; }
    } else if (/wbc/i.test(name) && !/ua|urine/i.test(name)) {
      const isScaled = (val < 100); // หากเป็นหน่วย x10^3/uL เช่น 3.62
      const minWbc = isScaled ? 4.0 : 4000;
      const maxWbc = isScaled ? 11.0 : 11000;
      if (val < minWbc) { isAbnormal = true; direction = 'low'; }
      else if (val > maxWbc) { isAbnormal = true; direction = 'high'; }
    } else if (/platelet/i.test(name)) {
      if (val < 140000) { isAbnormal = true; direction = 'low'; if (val < 50000) isCritical = true; }
      else if (val > 450000) { isAbnormal = true; direction = 'high'; }
    } else if (/\bhb\b|hemoglobin/i.test(name)) {
      if (val < 12.0) { isAbnormal = true; direction = 'low'; if (val < 8.0) isCritical = true; }
      else if (val > 17.5) { isAbnormal = true; direction = 'high'; }
    } else if (/hct|hematocrit/i.test(name)) {
      if (val < 36.0) { isAbnormal = true; direction = 'low'; if (val < 25.0) isCritical = true; }
      else if (val > 52.0) { isAbnormal = true; direction = 'high'; }
    } else if (/cholesterol|chol\b/i.test(name) && !/hdl|ldl/i.test(name)) {
      if (val > 200) { isAbnormal = true; direction = 'high'; }
    } else if (/triglyceride|tg\b/i.test(name)) {
      if (val > 150) { isAbnormal = true; direction = 'high'; if (val >= 500) isCritical = true; }
    } else if (/\bldl\b/i.test(name)) {
      if (val > 130) { isAbnormal = true; direction = 'high'; }
    } else if (/urine protein|protein\s*\(u\)|microalbumin/i.test(name)) {
      if (/positive|[1-4]\+/i.test(resultStr) || val > 30) {
        isAbnormal = true;
        direction = 'high';
      }
    }
  }

  if (isAbnormal && !direction) direction = 'high';

  return {
    isAbnormal,
    isCritical,
    direction,
    normalValue: normStr
  };
}

// ─── 4.2 แจ้งเตือนผลแล็บผิดปกติแบบย่อ/ขยายตามใบสั่งตรวจ (Collapsible Accordion by Form) ───
function renderSingleLabItem(l) {
  let flagHtml = '';
  if (l.eval.isCritical) {
    flagHtml = '<span class="lab-flag critical">🚨 CRITICAL</span>';
  } else if (l.eval.direction === 'high') {
    flagHtml = '<span class="lab-flag high">🔺 HIGH</span>';
  } else if (l.eval.direction === 'low') {
    flagHtml = '<span class="lab-flag low">🔻 LOW</span>';
  } else {
    flagHtml = '<span class="lab-flag abnormal">⚠️ ผิดปกติ</span>';
  }

  const normHtml = l.eval.normalValue ? ('<span class="lab-normal-ref">(ปกติ: ' + escapeHtml(l.eval.normalValue) + ')</span>') : '';

  return (
    '<div class="lab-item abnormal clickable-lab" onclick="openLabHistory(\'' + escapeHtml(l.item_name || '') + '\')" title="คลิกดูแนวโน้มผลแล็บ ' + escapeHtml(l.item_name || '') + ' ย้อนหลัง 10 ครั้ง">' +
      '<span class="lab-name">' + escapeHtml(l.item_name || 'Lab') + normHtml + '</span>' +
      '<div class="lab-vals">' +
        '<span class="lab-val">' + escapeHtml(l.result) + ' ' + escapeHtml(l.unit || '') + '</span>' +
        flagHtml +
        '<span class="btn-lab-item-chart" title="ดูกราฟเปรียบเทียบย้อนหลัง">📈 10 ครั้ง</span>' +
      '</div>' +
    '</div>'
  );
}

window.toggleLabOrder = function(idx) {
  const card = document.getElementById('labOrderCard_' + idx);
  if (!card) return;
  const body = card.querySelector('.lab-order-body');
  const chevron = card.querySelector('.lab-order-chevron');
  const isOpen = card.classList.contains('open');
  if (isOpen) {
    card.classList.remove('open');
    if (body) body.style.display = 'none';
    if (chevron) chevron.textContent = '▶';
  } else {
    card.classList.add('open');
    if (body) body.style.display = 'block';
    if (chevron) chevron.textContent = '▼';
  }
};

window.toggleAllLabOrders = function() {
  const cards = document.querySelectorAll('.lab-order-card');
  if (cards.length === 0) return;
  const anyClosed = Array.from(cards).some(c => !c.classList.contains('open'));
  cards.forEach((c, idx) => {
    const body = c.querySelector('.lab-order-body');
    const chevron = c.querySelector('.lab-order-chevron');
    if (anyClosed) {
      c.classList.add('open');
      if (body) body.style.display = 'block';
      if (chevron) chevron.textContent = '▼';
    } else {
      if (idx === 0) {
        c.classList.add('open');
        if (body) body.style.display = 'block';
        if (chevron) chevron.textContent = '▼';
      } else {
        c.classList.remove('open');
        if (body) body.style.display = 'none';
        if (chevron) chevron.textContent = '▶';
      }
    }
  });
};

function renderLabAlerts(labGroups, flatLabs) {
  const container = document.getElementById('labAlertList');
  const badge = document.getElementById('labCountBadge');
  const btnToggleAll = document.getElementById('btnToggleAllLabs');

  const groups = Array.isArray(labGroups) && labGroups.length > 0 ? labGroups : [{
    form_name: 'ผลตรวจทางห้องปฏิบัติการ',
    items: flatLabs || []
  }];

  const orderCards = [];
  let totalAbnormalCount = 0;

  groups.forEach((group, groupIdx) => {
    const formName = group.form_name || 'ใบสั่งตรวจแล็บ';
    const dateText = group.order_date_thai || group.order_date || '';
    const timeText = group.order_time ? (group.order_time + ' น.') : '';
    const items = (group.items || []).map(it => ({
      item_code: it.code || it.lab_items_code,
      item_name: it.name || it.item_name || '',
      result: it.result || '',
      unit: it.unit || '',
      abnormal: !!(it.abnormal || it.abnormal_result === 'Y'),
      critical: !!(it.critical || it.critical_result === 'Y'),
      normal_value: it.normal_value || it.lab_items_normal_value || it.lab_items_normal_value_ref || '',
      range_min: it.range_min,
      range_max: it.range_max,
      form_name: formName
    })).map(l => ({ ...l, eval: evaluateLabResult(l) }));

    const abnormalItems = items.filter(l => l.eval.isAbnormal);
    if (abnormalItems.length > 0) {
      totalAbnormalCount += abnormalItems.length;
      const critCount = abnormalItems.filter(l => l.eval.isCritical).length;
      orderCards.push({
        idx: orderCards.length,
        orderNumber: group.lab_order_number || groupIdx,
        formName: formName,
        dateText: dateText,
        timeText: timeText,
        critCount: critCount,
        abnormalItems: abnormalItems,
        isExpanded: (orderCards.length === 0 || critCount > 0)
      });
    }
  });

  if (badge) badge.textContent = totalAbnormalCount;

  if (totalAbnormalCount === 0 || orderCards.length === 0) {
    if (btnToggleAll) btnToggleAll.style.display = 'none';
    container.innerHTML = 
      '<div class="empty-state" style="padding: 10px 12px; text-align: center;">' +
        '<div>ไม่มีผลแล็บวิกฤต/ผิดปกติใน Visit นี้</div>' +
        '<button type="button" class="btn-open-lab-trend-empty" onclick="openGeneralLabHistory()" title="คลิกเพื่อดูกราฟประวัติผลแล็บ">📈 ดูกราฟประวัติผลแล็บ</button>' +
      '</div>';
    return 0;
  }

  if (btnToggleAll) {
    btnToggleAll.style.display = orderCards.length > 1 ? 'inline-block' : 'none';
  }

  container.innerHTML = orderCards.map(card => {
    return (
      '<div class="lab-order-card ' + (card.isExpanded ? 'open' : '') + '" id="labOrderCard_' + card.idx + '">' +
        '<div class="lab-order-header" onclick="toggleLabOrder(' + card.idx + ')" title="คลิกเพื่อย่อ/ขยายใบสั่งตรวจนี้">' +
          '<div class="lab-order-header-left">' +
            '<span class="lab-order-chevron">' + (card.isExpanded ? '▼' : '▶') + '</span>' +
            '<span class="lab-order-icon">📋</span>' +
            '<span class="lab-order-name">' + escapeHtml(card.formName) + '</span>' +
            (card.dateText ? ('<span class="lab-order-time">' + escapeHtml(card.dateText) + (card.timeText ? (' (' + escapeHtml(card.timeText) + ')') : '') + '</span>') : '') +
          '</div>' +
          '<div class="lab-order-header-right">' +
            (card.critCount > 0 ? ('<span class="lab-pill-crit">🚨 วิกฤต ' + card.critCount + '</span>') : '') +
            '<span class="lab-pill-count">' + card.abnormalItems.length + ' รายการ</span>' +
          '</div>' +
        '</div>' +
        '<div class="lab-order-body" style="display: ' + (card.isExpanded ? 'block' : 'none') + ';">' +
          '<div class="lab-items-list">' +
            card.abnormalItems.map(renderSingleLabItem).join('') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  return totalAbnormalCount;
}

// ─── 4.3 คำเตือนยา & เสนอยาสมุนไพรทางเลือก (โมเดล รพ.บ้านด่านลานหอย) ───
function renderDrugAndHerbs(patient, screening, labs, diag, meds, visit, recentMeds = []) {
  const drugAlertBox = document.getElementById('boxDrugAlert');
  const drugTitle = document.getElementById('drugAlertTitle');
  const drugDesc = document.getElementById('drugAlertDesc');
  const herbContainer = document.getElementById('herbSuggestionsList');
  const peBox = document.getElementById('pePreviewBox');
  const peTextarea = document.getElementById('peTextarea');
  const realtimeTag = document.getElementById('herbRealtimeTag');

  // ตรวจ eGFR / Cr / Potassium
  let egfr = parseFloat(screening.egfr) || null;
  let cr = parseFloat(screening.cr) || null;
  const crLab = labs.find(l => /creatinine|cr\b/i.test(l.item_name || ''));
  if (crLab) cr = parseFloat(crLab.result);

  const kLab = labs.find(l => (/potassium|^k\b/i.test(l.item_name || '') && !/gap/i.test(l.item_name || '')));
  const kVal = kLab ? parseFloat(kLab.result) : null;

  const astLab = labs.find(l => /sgot|ast\b/i.test(l.item_name || ''));
  const altLab = labs.find(l => /sgpt|alt\b/i.test(l.item_name || ''));
  const astVal = astLab ? parseFloat(astLab.result) : 0;
  const altVal = altLab ? parseFloat(altLab.result) : 0;

  const curMeds = Array.isArray(meds) ? meds : [];
  const past30Meds = Array.isArray(recentMeds) && recentMeds.length ? recentMeds : (currentPatientData?.recentMeds30d || []);

  const criticalAlerts = [];
  const warningAlerts = [];
  const infoAlerts = [];

  const isOnWarfarin = !!(
    visit?.is_on_warfarin ||
    patient.warfarin === 'Y' ||
    curMeds.some(m => /warfarin/i.test(m.name || '')) ||
    past30Meds.some(m => /warfarin/i.test(m.name || ''))
  );

  // 1. Renal Dose Adjustment & Safety Rules
  // 1.1 Metformin
  const curMetformin = curMeds.find(m => /metformin|glucophage/i.test(m.name || ''));
  if (curMetformin) {
    if (egfr !== null && egfr > 0 && egfr < 30) {
      criticalAlerts.push({
        tag: 'ห้ามใช้ (eGFR < 30)',
        drug: curMetformin.name,
        text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min เสี่ยงต่อภาวะ Lactic Acidosis รุนแรงถึงแก่ชีวิต <b>ห้ามใช้ Metformin</b> (ควรหยุดยาทันที)`
      });
    } else if (egfr !== null && egfr >= 30 && egfr < 45) {
      warningAlerts.push({
        tag: 'ปรับลดขนาด (eGFR 30-44)',
        drug: curMetformin.name,
        text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min แนะนำปรับลดขนาดยาสูงสุดไม่เกิน <b>1,000 mg/วัน</b> (500 mg วันละ 2 ครั้ง) และติดตามค่าไตอย่างใกล้ชิด`
      });
    }
  } else if (egfr !== null && egfr > 0 && egfr < 45) {
    if (egfr < 30) {
      warningAlerts.push({
        tag: 'ข้อห้ามใช้ Metformin',
        drug: 'Metformin',
        text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min (CKD Stage 4-5) <b>ห้ามเริ่มยา Metformin</b> เสี่ยงต่อ Lactic Acidosis`
      });
    } else {
      warningAlerts.push({
        tag: 'ปรับลดขนาดหากสั่งใช้',
        drug: 'Metformin',
        text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min หากจำเป็นต้องใช้ ควรจำกัดขนาดยาไม่เกิน 1,000 mg/วัน`
      });
    }
  }

  // 1.2 NSAIDs
  const curNsaids = curMeds.filter(m => /ibuprofen|naproxen|diclofenac|meloxicam|celecoxib|piroxicam|mefenamic|indomethacin/i.test(m.name || ''));
  if (curNsaids.length > 0) {
    curNsaids.forEach(m => {
      if ((egfr !== null && egfr > 0 && egfr < 30) || (cr !== null && cr >= 2.0)) {
        criticalAlerts.push({
          tag: 'ห้ามใช้ (ไตเสื่อมรุนแรง)',
          drug: m.name,
          text: `ผู้ป่วยมี eGFR ${egfr ? Math.round(egfr) : '-'} mL/min / Cr ${cr || '-'} mg/dL เสี่ยงภาวะไตวายเฉียบพลัน (AKI) รุนแรง <b>หลีกเลี่ยง NSAIDs เด็ดขาด</b> (แนะนำ Paracetamol หรือยาทาภายนอก)`
        });
      } else if (egfr !== null && egfr >= 30 && egfr < 60) {
        warningAlerts.push({
          tag: 'เฝ้าระวังไต (eGFR 30-59)',
          drug: m.name,
          text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min ควรหลีกเลี่ยงการใช้ต่อเนื่อง หากจำเป็นควรใช้ขนาดยาต่ำสุดและระยะเวลาสั้นที่สุด (ไม่เกิน 3-5 วัน)`
        });
      }
    });

    if (curNsaids.length >= 2) {
      warningAlerts.push({
        tag: 'NSAIDs ซ้ำซ้อน 2 ขนาน',
        drug: curNsaids.map(m => m.name).join(' + '),
        text: `สั่งใช้ยาแก้ปวดกลุ่ม NSAIDs พร้อมกัน 2 ตัว เพิ่มความเสี่ยงต่อแผลในทางเดินอาหาร เลือดออก และไตวายเฉียบพลัน`
      });
    }
  } else if ((egfr !== null && egfr > 0 && egfr < 60) || (cr !== null && cr > 1.3)) {
    warningAlerts.push({
      tag: 'ระวังกลุ่มยา NSAIDs',
      drug: 'NSAIDs Precautions',
      text: `ผู้ป่วยมีภาวะการทำงานของไตลดลง (eGFR ${egfr ? Math.round(egfr) : '-'} / Cr ${cr || '-'}): ควรหลีกเลี่ยงการสั่งยาแก้ปวดกลุ่ม NSAIDs`
    });
  }

  // 1.3 Colchicine
  const curColchicine = curMeds.find(m => /colchicine/i.test(m.name || ''));
  if (curColchicine && egfr !== null && egfr > 0 && egfr < 30) {
    warningAlerts.push({
      tag: 'ปรับลดขนาด (eGFR < 30)',
      drug: curColchicine.name,
      text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min ขนาดยาสูงสุดไม่เกิน <b>0.5 mg วันเว้นวัน</b> (หรือ 0.3 mg/วัน) เพื่อหลีกเลี่ยง Neuromyopathy และความเป็นพิษสะสม`
    });
  }

  // 1.4 Allopurinol
  const curAllopurinol = curMeds.find(m => /allopurinol/i.test(m.name || ''));
  if (curAllopurinol && egfr !== null && egfr > 0 && egfr < 30) {
    warningAlerts.push({
      tag: 'ปรับลดขนาด (eGFR < 30)',
      drug: curAllopurinol.name,
      text: `ผู้ป่วยมี eGFR ${Math.round(egfr)} mL/min แนะนำเริ่มที่ <b>50-100 mg/วัน</b> เพื่อลดความเสี่ยงการเกิด Allopurinol Hypersensitivity Syndrome (AHS)`
    });
  }

  // 1.5 Spironolactone
  const curSpironolactone = curMeds.find(m => /spironolactone|aldactone/i.test(m.name || ''));
  if (curSpironolactone) {
    if ((egfr !== null && egfr > 0 && egfr < 30) || (kVal !== null && kVal >= 5.0)) {
      criticalAlerts.push({
        tag: 'ห้ามใช้ (เสี่ยง K สูงวิกฤต)',
        drug: curSpironolactone.name,
        text: `ผู้ป่วยมี eGFR ${egfr ? Math.round(egfr) : '-'} mL/min / Potassium ${kVal || '-'} mEq/L เสี่ยงต่อภาวะ <b>Severe Hyperkalemia</b> ที่เป็นอันตรายต่อชีวิต <b>ห้ามใช้ Spironolactone</b>`
      });
    }
  }

  // 2. Severe Drug-Drug Interactions (DDI)
  // 2.1 Warfarin + NSAIDs / Tramadol
  if (isOnWarfarin) {
    const curBleedRisk = curMeds.filter(m => /ibuprofen|naproxen|diclofenac|meloxicam|celecoxib|piroxicam|mefenamic|indomethacin|tramadol/i.test(m.name || ''));
    if (curBleedRisk.length > 0) {
      curBleedRisk.forEach(m => {
        criticalAlerts.push({
          tag: 'อันตรกิริยารุนแรง (Warfarin + NSAID/Tramadol)',
          drug: `Warfarin + ${m.name}`,
          text: `สั่งใช้ <b>${escapeHtml(m.name)}</b> ร่วมกับ <b>WARFARIN</b> เสี่ยงเกิด <b>เลือดออกทางเดินอาหารรุนแรง (Major GI Bleeding)</b> และรบกวนการเกาะกลุ่มของเกล็ดเลือด`
        });
      });
    } else {
      infoAlerts.push({
        tag: 'ผู้ป่วยได้รับ WARFARIN',
        drug: 'Warfarin Precautions',
        text: `ระวังการสั่งยาที่มีอันตรกิริยา เช่น NSAIDs, Tramadol, Fluoroquinolones, Macrolides, Azoles`
      });
    }
  }

  // 2.2 Dual RAAS Blockade (ACEI + ARB)
  const aceiList = curMeds.filter(m => /enalapril|lisinopril|ramipril|captopril/i.test(m.name || ''));
  const arbList = curMeds.filter(m => /losartan|valsartan|candesartan|telmisartan|irbesartan/i.test(m.name || ''));
  if (aceiList.length > 0 && arbList.length > 0) {
    criticalAlerts.push({
      tag: 'ห้ามสั่งคู่กัน (Dual RAAS Blockade)',
      drug: `${aceiList[0].name} + ${arbList[0].name}`,
      text: `สั่งใช้ <b>ACEI (${escapeHtml(aceiList[0].name)})</b> ร่วมกับ <b>ARB (${escapeHtml(arbList[0].name)})</b> พร้อมกัน เพิ่มความเสี่ยง Hyperkalemia, ความดันโลหิตตก และไตวายเฉียบพลัน โดยไม่มีประโยชน์เสริม`
    });
  }

  // 3. Therapeutic Duplication (ยาเดิมที่ได้รับในรอบ 30 วัน)
  if (curMeds.length > 0 && past30Meds.length > 0) {
    curMeds.forEach(curr => {
      const cName = (curr.name || '').trim().toLowerCase();
      const match = past30Meds.find(prev => {
        if (curr.icode && prev.icode && String(curr.icode) === String(prev.icode)) return true;
        const pName = (prev.name || '').trim().toLowerCase();
        const cBase = cName.split(/\s|\(|\*/)[0];
        const pBase = pName.split(/\s|\(|\*/)[0];
        return cBase.length >= 4 && cBase === pBase;
      });

      if (match && match.daysAgo <= 20) {
        warningAlerts.push({
          tag: 'ยาซ้ำซ้อน 30 วัน',
          drug: `${curr.name} ${curr.strength || ''}`,
          text: `เพิ่งได้รับไปเมื่อ <b>${escapeHtml(match.vstdate_thai)} (${match.daysAgo} วันที่แล้ว)</b> จำนวน <b>${match.qty} ${escapeHtml(match.units || 'เม็ด')}</b> อาจมียาเดิมเหลืออยู่ โปรดตรวจสอบก่อนสั่งซ้ำ`
        });
      }
    });
  }

  // Render alerts into Box
  const allAlerts = [...criticalAlerts, ...warningAlerts, ...infoAlerts];
  if (allAlerts.length > 0) {
    drugAlertBox.style.display = 'flex';
    const alertIconEl = drugAlertBox.querySelector('.alert-icon');
    if (criticalAlerts.length > 0) {
      drugAlertBox.className = 'alert-box alert-danger';
      if (alertIconEl) alertIconEl.textContent = '🚨';
      drugTitle.textContent = 'แจ้งเตือนความปลอดภัยด้านยาวิกฤต (Critical Drug Alerts)';
    } else if (warningAlerts.length > 0) {
      drugAlertBox.className = 'alert-box alert-warning';
      if (alertIconEl) alertIconEl.textContent = '⚠️';
      drugTitle.textContent = 'ข้อควรระวังเรื่องยา & ปรับขนาดยา (Drug Safety & Renal Dosing)';
    } else {
      drugAlertBox.className = 'alert-box alert-warning';
      if (alertIconEl) alertIconEl.textContent = 'ℹ️';
      drugTitle.textContent = 'ข้อมูลความปลอดภัยด้านยา (Medication Precautions)';
    }

    drugDesc.innerHTML = `
      <div class="drug-alert-list">
        ${allAlerts.map(a => `
          <div class="drug-alert-item ${a.tag.includes('ห้ามใช้') || a.tag.includes('วิกฤต') || a.tag.includes('รุนแรง') || a.tag.includes('ห้ามสั่ง') ? 'drug-alert-danger' : (a.tag.includes('WARFARIN') ? 'drug-alert-info' : 'drug-alert-warn')}">
            <div class="drug-alert-badge-row">
              <span class="drug-badge">${escapeHtml(a.tag)}</span>
              <b class="drug-name-head">${escapeHtml(a.drug)}</b>
            </div>
            <div class="drug-desc-text">${a.text}</div>
          </div>
        `).join('')}
      </div>
    `;
  } else {
    drugAlertBox.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════════════
  // ─── กฎความปลอดภัยเข้มงวด: ตรวจสอบภาวะเสี่ยงต่อการใช้สมุนไพร ───
  // (หากผู้ป่วยมีภาวะเสี่ยง ระบบจะงดแนะนำยาสมุนไพรทุกชนิดทันที)
  // ══════════════════════════════════════════════════════════════════
  const riskReasons = [];

  // 1. ผู้ป่วยได้รับยา Warfarin หรือ ยาต้านการแข็งตัวของเลือดอื่นๆ
  if (isOnWarfarin) {
    riskReasons.push('ได้รับยาวาร์ฟาริน (WARFARIN): เสี่ยงต่อการเกิดอันตรกิริยาระหว่างยา (Drug Interaction) และภาวะเลือดออก');
  } else {
    const hasAnticoag = (meds || []).some(m => /warfarin|rivaroxaban|apixaban|dabigatran|plavix|clopidogrel/i.test(m.name || ''));
    if (hasAnticoag) {
      riskReasons.push('ได้รับยาต้านการแข็งตัวของเลือด/เกล็ดเลือด: เสี่ยงต่อภาวะเลือดออกง่าย');
    }
  }

  // 2. ผู้ป่วยมีภาวะไตวายรุนแรง Stage 4-5 (eGFR < 30 หรือ Cr >= 2.0 mg/dL)
  if (egfr && egfr > 0 && egfr < 30) {
    riskReasons.push(`ภาวะไตวายรุนแรง Stage 4-5 (eGFR ${Math.round(egfr)} mL/min): ไตไม่สามารถกำจัดสารสำคัญและเมทาบอไลต์ของสมุนไพรได้อย่างปลอดภัย`);
  } else if (cr && cr >= 2.0) {
    riskReasons.push(`Serum Creatinine สูงวิกฤต (${cr} mg/dL): เสี่ยงต่อการเกิดพิษต่อเนื้อเยื่อไต (Nephrotoxicity)`);
  }

  // 3. การทำงานของตับผิดปกติรุนแรง (AST หรือ ALT > 100 U/L)
  if (astVal > 100 || altVal > 100) {
    riskReasons.push(`เอนไซม์ตับสูงผิดปกติ (AST ${astVal || '-'} / ALT ${altVal || '-'} U/L): ตับบกพร่อง ไม่ควรรับสมุนไพรที่ต้องผ่านการขับทางตับ`);
  }

  // 4. ผู้ป่วยตั้งครรภ์
  const isPregnant = (patient.pregnancy === 'Y' || screening.pregnancy === 'Y' || /pregnant|ตั้งครรภ์/i.test(screening.cc || ''));
  if (isPregnant) {
    riskReasons.push('ผู้ป่วยตั้งครรภ์ (Pregnancy): ห้ามใช้สมุนไพรที่มีฤทธิ์บีบมดลูกหรือส่งผลต่อทารกในครรภ์');
  }

  const hasHerbalRisk = (riskReasons.length > 0);

  if (hasHerbalRisk) {
    if (realtimeTag) {
      realtimeTag.textContent = '';
      realtimeTag.setAttribute('data-tooltip', '🛡️ งดแนะนำสมุนไพรในเคสนี้ (ตรวจพบภาวะเสี่ยง)');
      realtimeTag.style.backgroundColor = '#ef4444';
      realtimeTag.style.animation = 'none';
      realtimeTag.style.boxShadow = '0 0 0 2px #fecaca';
    }

    herbContainer.innerHTML = `
      <div style="padding: 12px 14px; background: #fff5f5; border: 1.5px solid #fca5a5; border-radius: 10px; color: #991b1b; font-size: 12.5px; line-height: 1.5;">
        <div style="display: flex; align-items: center; gap: 6px; font-weight: 700; margin-bottom: 4px;">
          <span style="font-size: 16px;">🛡️</span>
          <span>งดแนะนำยาสมุนไพรในผู้ป่วยรายนี้ (ตรวจพบภาวะเสี่ยง)</span>
        </div>
        <div style="font-size: 11.5px; color: #7f1d1d; padding-left: 22px;">
          ${riskReasons.map(r => `• ${escapeHtml(r)}`).join('<br>')}
        </div>
      </div>
    `;

    if (peBox) peBox.style.display = 'none';

    return {
      isOnWarfarin,
      hasHerbalRisk: true,
      riskReasons,
      herbs: [],
      instruments: []
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // ─── วิเคราะห์กลุ่มอาการตามวินิจฉัย Realtime (โมเดล รพ.บ้านด่านลานหอย) ───
  // ══════════════════════════════════════════════════════════════════
  const diagText = diag.map(d => `${d.icd10 || ''} ${d.name || ''} ${d.dx_code_note || ''}`).join(' ').toLowerCase();
  const liveText = (currentLiveDiag || '').toLowerCase();
  const ccText = (screening.cc || '').toLowerCase();
  const hpiText = (screening.hpi || '').toLowerCase();
  const allClinical = `${liveText} ${diagText} ${ccText} ${hpiText}`;

  if (realtimeTag) {
    realtimeTag.textContent = '';
    realtimeTag.style.backgroundColor = '#10b981';
    realtimeTag.style.animation = 'liveDotPulse 2s infinite cubic-bezier(0.4, 0, 0.6, 1)';
    realtimeTag.style.boxShadow = '0 0 0 0 rgba(16, 185, 129, 0.7)';
    if (currentLiveDiag) {
      realtimeTag.setAttribute('data-tooltip', `⚡ ตรวจจับขณะพิมพ์: "${currentLiveDiag.slice(0, 30)}"`);
    } else {
      realtimeTag.setAttribute('data-tooltip', 'ตรวจจับวินิจฉัยสด Real-time (ovstdiag)');
    }
  }

  // ฟังก์ชันตรวจสอบความปลอดภัยรายตัวยา (Suppression of Inappropriate/Contraindicated Herbs)
  function isHerbSafe(herbKey) {
    if (herbKey === 'fah_talai_jone') {
      return !isPregnant && !isOnWarfarin;
    }
    if (herbKey === 'thao_wan_priang') {
      const isSevereCkd = (egfr && egfr < 30) || (cr && cr >= 2.0);
      return !isSevereCkd && !isPregnant;
    }
    if (herbKey === 'sahastara') {
      const isHighBpNow = (screening.bps && parseFloat(screening.bps) >= 150) || (screening.bpd && parseFloat(screening.bpd) >= 95);
      const hasHighFever = (screening.temperature && parseFloat(screening.temperature) >= 38.0);
      return !isHighBpNow && !hasHighFever && !isPregnant && !isOnWarfarin;
    }
    if (herbKey === 'khamin_chan') {
      const hasBiliaryObstruction = /k80|k81|k82|k83|cholecyst|gallstone|biliary/i.test(allClinical);
      return !hasBiliaryObstruction && !isPregnant && !isOnWarfarin;
    }
    if (herbKey === 'chumhet_thet') {
      const hasBowelObstruction = /k56|ileus|bowel obstruct|ลำไส้อุดตัน/i.test(allClinical);
      return !hasBowelObstruction && !isPregnant;
    }
    return true;
  }

  const herbGroups = [];
  let suggestedPe = '';

  // 1. หวัด / เจ็บคอ / ไอ / มีเสมหะ (Common Cold / URI / Cough)
  if (/uri|common cold|cough|pharyng|หวัด|ไอ|เจ็บคอ|เสมหะ|คอแดง|j00|j02|j06|r05/i.test(allClinical)) {
    const coldHerbs = [
      {
        key: 'fah_talai_jone',
        name: '🌿 ฟ้าทะลายโจร (Andrographis)',
        sub: 'ดูสรรพคุณ • บัญชียาหลักแห่งชาติ'
      }
    ].filter(h => isHerbSafe(h.key));

    if (coldHerbs.length > 0) {
      herbGroups.push({
        groupTitle: 'หวัด / เจ็บคอ',
        diagTag: 'common cold',
        herbs: coldHerbs
      });
    }

    const coughHerbs = [
      {
        key: 'makham_pom',
        name: '🌿 ยาแก้ไอมะขามป้อม (ยาอม/ยาน้ำ)',
        sub: 'ชุ่มคอ ละลายเสมหะ'
      },
      {
        key: 'prasamaweang',
        name: '🌿 ยาประสะมะแว้ง (ยาอม)',
        sub: 'บรรเทาอาการไอ ขับเสมหะ'
      }
    ].filter(h => isHerbSafe(h.key));

    if (coughHerbs.length > 0) {
      herbGroups.push({
        groupTitle: 'ไอ / มีเสมหะ',
        diagTag: 'common cold',
        herbs: coughHerbs
      });
    }

    suggestedPe = 'HEENT: mild pharyngeal injection, tonsils not enlarged, no tonsillar exudate, no cervical lymphadenopathy\nChest: clear, normal breath sounds, no rhonchi, no wheezing\nHeart: normal S1S2, regular rate and rhythm, no murmur\nAbdomen: soft, not tender, normal bowel sounds';
  }

  // 2. ระบบกระดูกและกล้ามเนื้อ (Musculoskeletal / Pain / LBP / Cervicalgia / Knee OA)
  const isNeckOrHead = /ปวดท้ายทอย|ท้ายทอย|ปวดคอ|ต้นคอ|cervical|neck|m54\.?2|บ่า|สะบัก|trapezius|tension\s*headache|g44\.?2/i.test(allClinical);
  const isLowBack = /ปวดหลัง|ปวดเอว|low\s*back|lbp|lumbar|lumbago|sciatica|m54\.?5|m54\.?4|m51/i.test(allClinical);
  const isKnee = /เข่า|knee|osteoarthr|oa\s*knee|m17/i.test(allClinical);
  const isGeneralPain = /pain|myalgia|ปวดเมื่อย|กล้ามเนื้อ|m54|m79/i.test(allClinical);

  if (isNeckOrHead || isLowBack || isKnee || isGeneralPain) {
    const painHerbs = [
      {
        key: 'thao_wan_priang',
        name: '🌿 ยาแคปซูลสารสกัดเถาวัลย์เปรียง',
        sub: 'ลดการใช้ NSAIDs ถนอมไต'
      },
      {
        key: 'sahastara',
        name: '🌿 สหัสธาราแคปซูล (Sahastara)',
        sub: 'ขับลมในเส้น บรรเทาปวดข้อชาปลายมือเท้า'
      }
    ].filter(h => isHerbSafe(h.key));

    let groupTitle = 'ปวดกล้ามเนื้อ / ข้ออักเสบ';
    let diagTag = 'myalgia';
    if (isLowBack) {
      groupTitle = 'ปวดหลัง / กล้ามเนื้อหลังส่วนเอว';
      diagTag = 'myalgia / LBP';
    } else if (isNeckOrHead) {
      groupTitle = 'ปวดคอ / ท้ายทอย / กล้ามเนื้อบ่า';
      diagTag = 'cervical / myalgia';
    } else if (isKnee) {
      groupTitle = 'ปวดเข่า / ข้อเข่าเสื่อม';
      diagTag = 'OA Knee';
    }

    if (painHerbs.length > 0) {
      herbGroups.push({
        groupTitle,
        diagTag,
        herbs: painHerbs
      });
    }

    const physHerbs = [];
    if (isHerbSafe('plai_cream')) {
      physHerbs.push({
        key: 'plai_cream',
        name: '🌿 ครีมไพล / น้ำมันไพล (GPO)',
        sub: 'ทาและถูนวดเบาๆ วันละ 2-3 ครั้ง'
      });
    }

    // 🦺 เสื้อพยุงหลัง (LS Support): แนะนำเฉพาะกรณีปวดหลัง / ปวดเอว / LBP เท่านั้น! ไม่แนะนำในเคสปวดคอ ท้ายทอย หรือปวดเข่า
    if (isLowBack && isHerbSafe('ls_support')) {
      physHerbs.push({
        key: 'ls_support',
        name: '🦺 เสื้อพยุงหลัง (LS Support)',
        sub: 'สปสช. เคลม 1,000 บาท (ต้นทุน 200 กว่าบาท)',
        isInstrument: true
      });
    }

    if (physHerbs.length > 0) {
      herbGroups.push({
        groupTitle: 'ยาทาภายนอก & อุปกรณ์กายภาพบำบัด',
        diagTag: 'physical care',
        herbs: physHerbs
      });
    }

    // เลือกข้อความตรวจร่างกาย (PE) ให้ตรงกับตำแหน่งทางกายวิภาคที่คนไข้มาตรวจจริง
    if (!suggestedPe) {
      if (isNeckOrHead) {
        suggestedPe = 'Neck: mild tenderness at trapezius and suboccipital muscles, no limitation of range of motion, no cervical spine tenderness\nNeurological: motor power grade V both upper extremities, sensation intact, no radiculopathy (Spurling\'s test negative)';
      } else if (isLowBack) {
        suggestedPe = 'Back: mild lumbar paraspinal tenderness, no midline spinous process tenderness, no step-off deformity\nSLRT: negative bilaterally (both legs)\nExtremities: motor power grade V all, normal sensation and deep tendon reflexes (DTR 2+ equal)';
      } else if (isKnee) {
        suggestedPe = 'Knee: mild crepitus on active motion, no joint effusion, no local heat, range of motion within normal limits, McMurray test negative';
      } else {
        suggestedPe = 'Musculoskeletal: generalized muscle tenderness, normal range of motion all extremities, no localized swelling or inflammation, motor power grade V all';
      }
    }
  }

  // 3. แน่นท้อง / ท้องอืด / กรดไหลย้อน (Dyspepsia / GERD)
  if (/dyspepsia|gastritis|แน่นท้อง|จุกเสียด|กรดไหลย้อน|k29|k30/i.test(allClinical)) {
    const giHerbs = [
      {
        key: 'khamin_chan',
        name: '🌿 แคปซูลขมิ้นชัน (Turmeric)',
        sub: 'ขับลม เคลือบกระเพาะ ทดแทนยาลดกรด'
      }
    ].filter(h => isHerbSafe(h.key));

    if (giHerbs.length > 0) {
      herbGroups.push({
        groupTitle: 'แน่นท้อง / ท้องอืด / กรดไหลย้อน',
        diagTag: 'dyspepsia',
        herbs: giHerbs
      });
    }

    if (!suggestedPe) {
      suggestedPe = 'Abdomen: soft, mild epigastric tenderness, no guarding, no rebound tenderness, liver and spleen not palpable, normal bowel sounds';
    }
  }

  // 4. ท้องผูก (Constipation)
  if (/constipat|ท้องผูก|k590/i.test(allClinical)) {
    const constipHerbs = [
      {
        key: 'chumhet_thet',
        name: '🌿 ยาชงชุมเห็ดเทศ (Senna alata)',
        sub: 'ยาระบายสมุนไพรอ่อนๆ ชงน้ำดื่มก่อนนอน'
      }
    ].filter(h => isHerbSafe(h.key));

    if (constipHerbs.length > 0) {
      herbGroups.push({
        groupTitle: 'ยาระบายสมุนไพร',
        diagTag: 'constipation',
        herbs: constipHerbs
      });
    }

    if (!suggestedPe) {
      suggestedPe = 'Abdomen: soft, mild tenderness at left lower quadrant (LLQ), no palpable mass, active bowel sounds';
    }
  }

  // กรณีไม่พบอาการเฉพาะ หรือ ยาถูกคัดออกเนื่องจากไม่เหมาะสม:
  // ไม่แสดงสมุนไพรแบบเหมาโหล (Clean Case-Specific Suppression)
  if (herbGroups.length === 0) {
    herbContainer.innerHTML = `
      <div class="empty-state" style="padding: 18px 12px; color: #64748b; font-size: 12.5px; text-align: center;">
        🌿 ไม่พบรายการยาสมุนไพรที่ตรงกับกลุ่มอาการใน Visit นี้ (หรือผู้ป่วยมีข้อห้ามใช้)
      </div>
    `;
    if (peBox) peBox.style.display = 'none';

    return {
      isOnWarfarin: false,
      hasHerbalRisk: false,
      herbs: [],
      instruments: []
    };
  }

  // เรนเดอร์การ์ดกลุ่มสมุนไพรตามโมเดล รพ.บ้านด่านลานหอย (ผ่านการตรวจสอบความปลอดภัย PTC และบัญชียาหลักแห่งชาติ)
  let html = `
    <div style="font-size: 11px; color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 7px; padding: 4px 8px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
      <span>🛡️ ผ่านเกณฑ์ตรวจสอบความปลอดภัย PTC / บัญชียาหลักแห่งชาติ พ.ศ. 2566</span>
      <span style="font-size: 10px; color: #065f46; font-weight: 600;">CDS Guideline</span>
    </div>
  `;
  herbGroups.forEach(grp => {
    html += `
      <div class="bdlh-herb-group" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <b style="font-size: 13.5px; color: #92400e;">${escapeHtml(grp.groupTitle)}</b>
          <span style="font-size: 11px; background: #fef3c7; color: #b45309; padding: 1px 6px; border-radius: 4px; border: 1px solid #fde68a;">${escapeHtml(grp.diagTag)}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${grp.herbs.map(h => `
            <div class="herb-card ${h.isInstrument ? 'herb-card-instrument' : ''}" onclick="openHerbModal('${h.key}')" title="คลิกเพื่อดูสรรพคุณ ข้อห้ามใช้ และข้อควรระวัง">
              <div class="herb-title" style="font-size: 13.5px; font-weight: 700; color: ${h.isInstrument ? '#6d28d9' : '#0f766e'};">${escapeHtml(h.name)}</div>
              <div class="herb-indication" style="font-size: 11.5px; color: #64748b; margin-top: 2px;">${escapeHtml(h.sub)}</div>
              <div class="herb-card-click-hint" style="font-size: 11px; margin-top: 3px; color: ${h.isInstrument ? '#7c3aed' : '#0d9488'};">👆 ดูสรรพคุณ ข้อห้ามใช้ และข้อควรระวัง</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  html += `
    <div style="font-size: 10.5px; color: #64748b; margin-top: 6px; text-align: center; line-height: 1.4;">
      ระบบสนับสนุนการตัดสินใจทางคลินิก (Clinical Decision Support) เพื่อให้แพทย์และเภสัชกรพิจารณา ไม่ใช่การสั่งจ่ายยาอัตโนมัติ
    </div>
  `;

  herbContainer.innerHTML = html;

  // แสดงและอัปเดต PE Text Preview
  if (peBox && peTextarea) {
    peTextarea.value = suggestedPe;
    peBox.style.display = 'block';
  }

  return {
    isOnWarfarin: false,
    hasHerbalRisk: false,
    herbs: herbGroups.flatMap(g => g.herbs),
    instruments: []
  };
}

// ─── 4.4 คำนวณวันนัด & เม็ดยา ───
function renderAppointmentAndCalc(appt) {
  const dateEl = document.getElementById('valApptDate');
  const metaEl = document.getElementById('valApptDaysText');
  const clinicEl = document.getElementById('valApptClinic');

  const daysCount = parseInt(appt.days_count) || parseInt(appt.days) || 0;

  if (appt.nextdate_thai || appt.nextdate) {
    dateEl.textContent = appt.nextdate_thai || appt.nextdate;
    metaEl.textContent = `${daysCount} วัน`;
    clinicEl.textContent = appt.clinic_name || appt.clinic || 'คลินิกเดิม';

    if (daysCount > 0) {
      updatePillCalculation(daysCount);
      highlightDayChip(daysCount);
    } else {
      updatePillCalculation(selectedDays);
    }
  } else {
    dateEl.textContent = 'ไม่มีนัดตรวจ';
    metaEl.textContent = '- วัน';
    clinicEl.textContent = 'คลินิกเดิม';
    updatePillCalculation(selectedDays);
  }
}

// ─── 4.5 ระบบ Alert Toast แจ้งเตือนเวลาเปลี่ยน VN ผู้ป่วย (โมเดล รพ.บ้านด่านลานหอย) ───
function showPatientAlertToast(ctx) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const patient = ctx.patient || {};
  const visit = ctx.visit || {};
  const renal = ctx.renal || {};
  const labCount = ctx.labCount || 0;
  const herb = ctx.herb || {};

  const name = patient.name || 'ไม่ระบุชื่อ';
  const hn = patient.hn || '-';
  const vn = visit.vn || currentVn || '-';
  const age = patient.age_text || (patient.age ? patient.age + ' ปี' : '-');

  // ตรวจสอบระดับความเร่งด่วนของ Toast
  const isOnWarfarin = !!herb.isOnWarfarin;
  const isSevereKidney = (renal.egfr && renal.egfr < 30);
  const isModerateKidney = (renal.egfr && renal.egfr < 60);
  const isHighBp = !!renal.isHighBp;
  const hasCriticalAlerts = (isOnWarfarin || isSevereKidney || labCount >= 2);

  let toastType = 'toast-info';
  let toastIcon = '👤';
  if (hasCriticalAlerts) {
    toastType = 'toast-danger';
    toastIcon = '🚨';
  } else if (isModerateKidney || isHighBp || labCount > 0) {
    toastType = 'toast-warning';
    toastIcon = '⚠️';
  } else {
    toastType = 'toast-success';
    toastIcon = '🟢';
  }

  // สร้าง Tags แสดงสถานะทางคลินิกอย่างกระชับ
  const tagsHtml = [];
  if (isOnWarfarin) {
    tagsHtml.push(`<span class="toast-tag tag-red">🩸 ON WARFARIN (ระวัง Interaction)</span>`);
  }
  if (renal.egfr && renal.egfr > 0) {
    if (renal.egfr < 30) {
      tagsHtml.push(`<span class="toast-tag tag-red">🔴 ไตวาย Stage 4-5 (eGFR ${renal.egfr})</span>`);
    } else if (renal.egfr < 60) {
      tagsHtml.push(`<span class="toast-tag tag-amber">🟠 ไต Stage 3 (eGFR ${renal.egfr})</span>`);
    } else {
      tagsHtml.push(`<span class="toast-tag tag-green">🟢 ไตปกติ (eGFR ${renal.egfr})</span>`);
    }
  }
  if (isHighBp) {
    tagsHtml.push(`<span class="toast-tag tag-amber">⚠️ BP ${renal.bps}/${renal.bpd} mmHg</span>`);
  }
  if (labCount > 0) {
    tagsHtml.push(`<span class="toast-tag tag-red">🧪 ผลแล็บผิดปกติ ${labCount} รายการ</span>`);
  }
  if (herb.herbs && herb.herbs.length > 0) {
    const firstHerb = herb.herbs[0].name.replace('🌿 ', '').split('(')[0].trim();
    tagsHtml.push(`<span class="toast-tag tag-green">🌿 แนะนำ: ${escapeHtml(firstHerb)}</span>`);
  }
  if (herb.instruments && herb.instruments.length > 0) {
    tagsHtml.push(`<span class="toast-tag tag-purple">🦺 แนะนำ LS Support (สปสช. 1,000.-)</span>`);
  }

  // เคลียร์ Toast เดิมก่อน
  container.innerHTML = '';

  const toastEl = document.createElement('div');
  toastEl.className = `alert-toast ${toastType}`;
  toastEl.innerHTML = `
    <div class="toast-header">
      <div class="toast-title-group">
        <span class="toast-icon">${toastIcon}</span>
        <div>
          <div class="toast-title">${escapeHtml(name)}</div>
          <div class="toast-meta">HN: ${escapeHtml(hn)} · VN: ${escapeHtml(vn)} · อายุ: ${escapeHtml(age)}</div>
        </div>
      </div>
      <button class="toast-close" title="ปิดการแจ้งเตือน">✕</button>
    </div>
    <div class="toast-body">
      <div class="toast-tags">${tagsHtml.join('')}</div>
      <div class="toast-actions">
        <button class="btn-toast-link" data-target="secRenal">ไต & สัญญาณชีพ</button>
        ${labCount > 0 ? '<button class="btn-toast-link" data-target="secLabs">ผลแล็บ</button>' : ''}
        ${(herb.herbs?.length > 0 || herb.instruments?.length > 0) ? '<button class="btn-toast-link" data-target="secHerbs">สมุนไพร / อุปกรณ์</button>' : ''}
      </div>
    </div>
    ${!hasCriticalAlerts ? '<div class="toast-progress-bar"></div>' : ''}
  `;

  // ปุ่มปิด Toast
  toastEl.querySelector('.toast-close').addEventListener('click', () => {
    closeToast(toastEl);
  });

  // ปุ่มกระโดดไปยัง Card ที่เกี่ยวข้อง (Smooth Scroll)
  toastEl.querySelectorAll('.btn-toast-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetId = e.currentTarget.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        targetEl.style.transition = 'box-shadow 0.3s ease';
        targetEl.style.boxShadow = '0 0 0 3px #0f766e';
        setTimeout(() => { targetEl.style.boxShadow = ''; }, 1800);
      }
    });
  });

  container.appendChild(toastEl);

  // เล่นเสียงแจ้งเตือนเบาๆ นุ่มนวลผ่าน Web Audio API
  playAlertChime(hasCriticalAlerts);

  // ถ้าไม่ใช่เคสวิกฤต ให้ Auto-dismiss ใน 5.5 วินาที
  if (!hasCriticalAlerts) {
    if (activeToastTimeout) clearTimeout(activeToastTimeout);
    activeToastTimeout = setTimeout(() => {
      closeToast(toastEl);
    }, 5500);
  }
}

function closeToast(el) {
  if (!el || !el.parentElement) return;
  el.classList.add('toast-closing');
  setTimeout(() => {
    if (el.parentElement) el.parentElement.removeChild(el);
  }, 250);
}

// เล่นเสียง Synthesized Chime ผ่าน Web Audio API (ไม่ต้องพึ่งไฟล์เสียงจากภายนอก)
function playAlertChime(isCritical = false) {
  if (!audioEnabled || !sharedAudioContext || sharedAudioContext.state !== 'running') return;
  try {
    const ctx = sharedAudioContext;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    if (isCritical) {
      // 2 โทนเตือนเคสวิกฤต (Warfarin / ไตเสื่อมรุนแรง / ผลแล็บอันตราย)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(659.25, now + 0.12);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else {
      // โทนกระดิ่งนุ่มนวล (เปลี่ยนคนไข้ปกติ)
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.08); // A5
      gain.gain.setValueAtTime(0.03, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    }
  } catch (e) {
    // ปิดเสียงไว้เมื่อ browser ไม่พร้อม โดยไม่ขัดจังหวะงานหลัก
  }
}

function setupAudioAlerts() {
  const button = document.getElementById('btnAudioToggle');
  if (!button) return;
  try {
    audioEnabled = localStorage.getItem('doctorAssistantAudioMuted') !== 'true';
  } catch (_) { audioEnabled = true; }

  const updateButton = () => {
    button.textContent = audioEnabled ? '🔊' : '🔇';
    button.setAttribute('aria-pressed', String(audioEnabled));
    button.title = audioEnabled ? 'เปิดเสียงแจ้งเตือนอัตโนมัติอยู่ — กดเพื่อปิด' : 'เสียงแจ้งเตือนปิดอยู่ — กดเพื่อเปิด';
    button.setAttribute('aria-label', button.title);
  };

  const unlock = async () => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !audioEnabled) return false;
    try {
      if (!sharedAudioContext) sharedAudioContext = new AudioCtx();
      if (sharedAudioContext.state === 'suspended') await sharedAudioContext.resume();
      return sharedAudioContext.state === 'running';
    } catch (_) { return false; }
  };

  // Companion launches Chromium with autoplay enabled. In a regular browser, retry after any gesture if needed.
  const unlockOnGesture = () => { unlock(); };
  document.addEventListener('pointerdown', unlockOnGesture, { capture: true });
  document.addEventListener('keydown', unlockOnGesture, { capture: true });

  button.addEventListener('click', async () => {
    audioEnabled = !audioEnabled;
    try { localStorage.setItem('doctorAssistantAudioMuted', String(!audioEnabled)); } catch (_) { /* Optional browser storage. */ }
    updateButton();
    if (audioEnabled && await unlock()) playAlertChime(false);
  });
  updateButton();
  // Start alert audio automatically; the Companion's dedicated browser profile permits autoplay.
  unlock();
}

// ─── 4.6 เปิด/ปิด Modal ข้อมูลยาสมุนไพรและอุปกรณ์กายภาพบำบัด ───
window.openHerbModal = function(key) {
  const item = HERB_DATABASE[key];
  if (!item) return;

  const modal = document.getElementById('herbModal');
  if (!modal) return;

  document.getElementById('herbModalBadge').textContent = item.badge || 'HERBAL MEDICINE INFORMATION';
  document.getElementById('herbModalTitle').textContent = item.title;
  document.getElementById('herbModalScientific').textContent = item.scientific;
  document.getElementById('herbModalIndication').textContent = item.indication;
  document.getElementById('herbModalContraindication').textContent = item.contraindication;
  document.getElementById('herbModalPrecaution').textContent = item.precaution;
  document.getElementById('herbModalReference').textContent = item.reference;

  modal.style.display = 'flex';
};

function closeHerbModal() {
  const modal = document.getElementById('herbModal');
  if (modal) modal.style.display = 'none';
}

// ตั้งค่าชิปเลือกจำนวนวัน
function setupPillCalcChips() {
  const chips = document.querySelectorAll('.chip-day');
  const customInput = document.getElementById('inputCustomDays');

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const days = parseInt(chip.dataset.days) || 28;
      selectedDays = days;
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (customInput) customInput.value = '';
      updatePillCalculation(days);
    });
  });

  customInput?.addEventListener('input', () => {
    const val = parseInt(customInput.value);
    if (val && val > 0 && val <= 365) {
      selectedDays = val;
      chips.forEach(c => c.classList.remove('active'));
      updatePillCalculation(val);
    }
  });
}

function highlightDayChip(days) {
  const chips = document.querySelectorAll('.chip-day');
  let matched = false;
  chips.forEach(c => {
    if (parseInt(c.dataset.days) === days) {
      c.classList.add('active');
      matched = true;
    } else {
      c.classList.remove('active');
    }
  });

  const customInput = document.getElementById('inputCustomDays');
  if (!matched && customInput) {
    customInput.value = days;
  }
}

function updatePillCalculation(days) {
  const displayEl = document.getElementById('calcDaysDisplay');
  if (displayEl) displayEl.textContent = days;

  document.getElementById('calcOd').textContent = `${days * 1} เม็ด`;
  document.getElementById('calcBid').textContent = `${days * 2} เม็ด`;
  document.getElementById('calcTid').textContent = `${days * 3} เม็ด`;
  document.getElementById('calcQid').textContent = `${days * 4} เม็ด`;
  document.getElementById('calc2x2').textContent = `${days * 4} เม็ด`;
  document.getElementById('calcHs').textContent = `${days * 1} เม็ด`;
}

// ─── Utility ───
function setSyncState(isOnline, text) {
  const badge = document.getElementById('syncStatusBadge');
  const statusText = document.getElementById('syncStatusText');
  if (!badge || !statusText) return;
  statusText.textContent = text;
  if (!isOnline) {
    badge.style.background = '#fef2f2';
    badge.style.color = '#b91c1c';
    badge.style.borderColor = '#fecaca';
    badge.title = 'ระบบออฟไลน์';
  } else if (isManualSearchActive) {
    badge.style.background = '#eff6ff';
    badge.style.color = '#1d4ed8';
    badge.style.borderColor = '#bfdbfe';
    badge.title = 'กำลังดูคนไข้จากการค้นหาเอง (ค้างไว้ ไม่เปลี่ยนตาม HOSxP จนกว่าจะเลือกคนไข้ใหม่บน HOSxP หรือกด 🔄)';
  } else {
    badge.style.background = '#ecfdf5';
    badge.style.color = '#047857';
    badge.style.borderColor = '#a7f3d0';
    badge.title = 'ระบบเชื่อมต่อ HOSxP แบบ Real-Time อัตโนมัติ';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}

function showAppNotice(message, type = 'warning') {
  const region = document.getElementById('appNoticeRegion');
  if (!region) return;
  const notice = document.createElement('div');
  const kind = ['warning', 'error', 'success', 'info'].includes(type) ? type : 'warning';
  const icons = { warning: '⚠️', error: '!', success: '✓', info: 'i' };
  notice.className = `app-notice app-notice-${kind}`;
  notice.innerHTML = `<span class="app-notice-icon" aria-hidden="true">${icons[kind]}</span><div class="app-notice-message"></div><button class="app-notice-close" type="button" aria-label="ปิดการแจ้งเตือน">×</button>`;
  notice.querySelector('.app-notice-message').textContent = String(message || 'เกิดข้อผิดพลาด');
  const dismiss = () => { notice.classList.add('app-notice-exit'); setTimeout(() => notice.remove(), 220); };
  notice.querySelector('.app-notice-close').addEventListener('click', dismiss);
  region.appendChild(notice);
  setTimeout(dismiss, 5000);
}

// ─── 4.7 ระบบค้นหาผู้ป่วยด้วย HN, ชื่อ-สกุล หรือ VN พร้อม Dropdown แนะนำ ───
function setupPatientSearch() {
  const btnToggle = document.getElementById('btnToggleSearch');
  const searchBox = document.getElementById('patientSearchBox');
  const inputSearch = document.getElementById('inputPatientSearch');
  const btnClear = document.getElementById('btnSearchClear');
  const dropdownList = document.getElementById('searchDropdownList');

  btnToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!searchBox) return;
    const isHidden = (searchBox.style.display === 'none' || !searchBox.style.display);
    searchBox.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      inputSearch?.focus();
      inputSearch?.select();
    } else {
      if (dropdownList) dropdownList.style.display = 'none';
    }
  });

  btnClear?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (inputSearch) inputSearch.value = '';
    btnClear.style.display = 'none';
    if (dropdownList) {
      dropdownList.innerHTML = '';
      dropdownList.style.display = 'none';
    }
    inputSearch?.focus();
  });

  inputSearch?.addEventListener('input', () => {
    const query = (inputSearch.value || '').trim();
    if (btnClear) btnClear.style.display = query ? 'inline-flex' : 'none';

    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

    if (!query) {
      if (dropdownList) {
        dropdownList.innerHTML = '';
        dropdownList.style.display = 'none';
      }
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      performPatientSearch(query);
    }, 250);
  });

  inputSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dropdownList) dropdownList.style.display = 'none';
      if (searchBox) searchBox.style.display = 'none';
    } else if (e.key === 'Enter') {
      const firstItem = dropdownList?.querySelector('.search-item');
      if (firstItem) {
        firstItem.click();
      }
    }
  });

  // ปิด Dropdown เมื่อคลิกนอกพื้นที่
  document.addEventListener('click', (e) => {
    if (searchBox && !searchBox.contains(e.target) && e.target !== btnToggle) {
      if (dropdownList) dropdownList.style.display = 'none';
    }
  });
}

async function performPatientSearch(q) {
  const dropdownList = document.getElementById('searchDropdownList');
  if (!dropdownList) return;

  dropdownList.style.display = 'flex';
  dropdownList.innerHTML = '<div class="search-loading">กำลังค้นหาผู้ป่วย...</div>';

  try {
    const res = await fetch(`/api/assistant/search?q=${encodeURIComponent(q)}&limit=15`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `ค้นหาไม่สำเร็จ (HTTP ${res.status})`);
    const list = data.results || [];

    if (list.length === 0) {
      dropdownList.innerHTML = '<div class="search-empty">ไม่พบผู้ป่วยที่ตรงกับคำค้นหา</div>';
      return;
    }

    dropdownList.innerHTML = list.map(item => {
      const sexText = item.sex === '1' ? 'ชาย' : (item.sex === '2' ? 'หญิง' : '');
      const ageText = item.age ? `${item.age} ปี` : '';
      const dateText = item.vstdate_thai || item.vstdate || '';

      return `
        <div class="search-item" data-vn="${escapeHtml(item.vn || '')}" data-hn="${escapeHtml(item.hn || '')}">
          <div class="search-item-line1">
            <span class="search-hn-badge">HN ${escapeHtml(item.hn || '-')}</span>
            <span class="search-item-name">${escapeHtml(item.patient_name || '')}</span>
            <span class="search-item-meta">${escapeHtml(ageText)} ${escapeHtml(sexText)}</span>
          </div>
          <div class="search-item-line2">
            <span>VN: <b>${escapeHtml(item.vn || '-')}</b></span>
            <span>${escapeHtml(dateText)}</span>
          </div>
        </div>
      `;
    }).join('');

    dropdownList.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const vn = el.getAttribute('data-vn');
        const hn = el.getAttribute('data-hn');
        if (vn) {
          isManualSearchActive = true; // ค้างคนไข้ที่ค้นหาเองไว้ ไม่เปลี่ยนตาม HOSxP จนกว่าจะเลือกคนไข้ใหม่บน HOSxP
          loadPatientData(vn, hn);
          dropdownList.style.display = 'none';
          const searchBox = document.getElementById('patientSearchBox');
          if (searchBox) searchBox.style.display = 'none';
        }
      });
    });

  } catch (err) {
    dropdownList.innerHTML = `<div class="search-empty" style="color: #ef4444;">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── 5. ระบบดูประวัติย้อนหลัง 10 ครั้งล่าสุด (ความดัน / ไต / น้ำตาล / ผลแล็บ) ───
// ตามโมเดล รพ.บ้านด่านลานหอย เพื่อวิเคราะห์การตอบสนองต่อยา, ตรวจสอบ AKI vs CKD และแนวโน้มผลแล็บ
window.openHistoryModal = function(type, title, subtitle, preferredTab = null) {
  if (!currentHn) {
    showAppNotice('กรุณาเลือกหรือรอโหลดข้อมูลผู้ป่วยก่อนเปิดดูประวัติย้อนหลัง', 'warning');
    return;
  }
  // เคลียร์และซ่อนกราฟเดิมเสมอ ป้องกันกราฟค้างข้ามผู้ป่วยหรือข้ามเมนู
  const chartCard = document.getElementById('histChartCard');
  const svgEl = document.getElementById('histChartSvg');
  if (chartCard) chartCard.style.display = 'none';
  if (svgEl) svgEl.innerHTML = '';

  currentModalMode = type;
  currentHistoryLimit = 10;
  currentHistoryTitle = title;
  currentHistorySubtitle = subtitle;

  const modal = document.getElementById('historyModal');
  if (!modal) return;

  document.getElementById('histTitle').textContent = title;
  const subText = subtitle ? ` · ${subtitle}` : '';
  document.getElementById('histSubtitle').textContent = `HN: ${currentHn} · ผู้ป่วย: ${currentPatientName || '-'}${subText}`;

  const modalTabs = document.getElementById('histModalTabs');
  const tab1 = document.getElementById('tabHist1');
  const tab2 = document.getElementById('tabHist2');
  const wrapTable = document.getElementById('wrapHistTable');
  const wrapDose = document.getElementById('wrapRenalDose');
  const btnLoadMore = document.getElementById('btnHistLoadMore');

  if (type === 'renal') {
    if (modalTabs) modalTabs.style.display = 'flex';
    if (tab1) tab1.textContent = '📈 แนวโน้มค่าไต';
    if (tab2) {
      tab2.textContent = '💊 การปรับขนาดยา';
      tab2.style.display = 'inline-flex';
    }
    if (preferredTab === 'dose' || subtitle.includes('CrCl') || title.includes('CrCl')) {
      switchModalTab('dose');
    } else {
      switchModalTab('trend');
    }
  } else if (type === 'vitals') {
    if (modalTabs) modalTabs.style.display = 'flex';
    if (tab1) tab1.textContent = '💓 ความดัน & ชีพจร';
    if (tab2) {
      tab2.textContent = '⚖️ น้ำหนัก & ส่วนสูง';
      tab2.style.display = 'inline-flex';
    }
    if (preferredTab === 'bw') {
      switchModalTab('bw');
    } else {
      switchModalTab('bp');
    }
  } else {
    // sugar หรือ lab_*
    if (modalTabs) modalTabs.style.display = 'none';
    if (wrapTable) wrapTable.style.display = 'block';
    if (wrapDose) wrapDose.style.display = 'none';
    const wrapLoadMore = document.getElementById('wrapTableLoadMore');
    if (btnLoadMore) {
      btnLoadMore.style.display = 'inline-flex';
      btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
    }
    if (wrapLoadMore) wrapLoadMore.style.display = 'block';
    currentHistoryType = type;
    fetchAndRenderHistory(type, 10);
  }

  modal.style.display = 'flex';
};

window.closeHistoryModal = function() {
  const modal = document.getElementById('historyModal');
  if (modal) modal.style.display = 'none';
  const chartCard = document.getElementById('histChartCard');
  const svgEl = document.getElementById('histChartSvg');
  if (chartCard) chartCard.style.display = 'none';
  if (svgEl) svgEl.innerHTML = '';
};

window.loadMoreHistory = function() {
  currentHistoryLimit += 10;
  fetchAndRenderHistory(currentHistoryType, currentHistoryLimit);
};

window.openLabHistory = function(labName) {
  if (!labName) return;
  const lKey = String(labName).toLowerCase().trim();
  let displayTitle = labName;
  if (/^hematocrit\d*$|^hct\d*$/i.test(lKey)) displayTitle = 'Hct (Hematocrit)';
  else if (lKey === 'hba1c' || lKey === 'a1c') displayTitle = 'HbA1c (น้ำตาลสะสม)';
  else if (lKey === 'cr' || lKey === 'creatinine') displayTitle = 'Creatinine (การทำงานของไต)';
  else if (lKey === 'ldl') displayTitle = 'LDL-C (ไขมันเลว)';
  else if (lKey === 'uacr') displayTitle = 'uACR (โปรตีนรั่วในปัสสาวะ)';
  else if (lKey === 'potassium' || lKey === 'k') displayTitle = 'Potassium (K)';
  openHistoryModal('lab_' + labName, `ประวัติผลตรวจแล็บ: ${displayTitle}`, 'ติดตามแนวโน้มผลตรวจทางห้องปฏิบัติการย้อนหลัง');
};

async function fetchAndRenderHistory(type, limit) {
  const thead = document.getElementById('histThead');
  const tbody = document.getElementById('histTbody');
  const statsBar = document.getElementById('histStatsBar');
  const btnLoadMore = document.getElementById('btnHistLoadMore');
  const chartCard = document.getElementById('histChartCard');
  const svgEl = document.getElementById('histChartSvg');

  // เคลียร์และซ่อนกราฟทุกครั้งที่เริ่มโหลด ป้องกันกราฟค้างข้ามแท็บ
  if (chartCard) chartCard.style.display = 'none';
  if (svgEl) svgEl.innerHTML = '';

  const critBar = document.getElementById('renalCriteriaToggleBar');
  if (critBar) {
    critBar.style.display = (type === 'renal') ? 'flex' : 'none';
  }
  const btnCritHosxp = document.getElementById('btnCriteriaHosxp');
  const btnCritKdigo = document.getElementById('btnCriteriaKdigo');
  btnCritHosxp?.classList.toggle('active', currentRenalCriteria === 'hosxp');
  btnCritKdigo?.classList.toggle('active', currentRenalCriteria === 'kdigo');

  // จัดการแถบ Quick Chips สำหรับประวัติแล็บ
  const labChipsBar = document.getElementById('labQuickChips');
  if (labChipsBar) {
    labChipsBar.style.display = (type.startsWith('lab_')) ? 'flex' : 'none';
    if (type.startsWith('lab_')) {
      const rawLabKey = type.replace('lab_', '').toLowerCase();
      const activeLabKey = (/^hematocrit\d*$|^hct\d*$/i.test(rawLabKey)) ? 'hct' :
                           (/^platelet|^plt/i.test(rawLabKey)) ? 'platelet' :
                           (/^potassium|^k$/i.test(rawLabKey)) ? 'potassium' :
                           (/^sodium|^na$/i.test(rawLabKey)) ? 'sodium' :
                           (/^creatinine|^cr$/i.test(rawLabKey)) ? 'cr' :
                           (/^hba1c|^a1c$/i.test(rawLabKey)) ? 'hba1c' :
                           (/^ldl/i.test(rawLabKey)) ? 'ldl' :
                           (/^uacr/i.test(rawLabKey)) ? 'uacr' :
                           rawLabKey;
      labChipsBar.querySelectorAll('.btn-toggle-pill').forEach(btn => {
        const key = (btn.dataset.lab || '').toLowerCase();
        btn.classList.toggle('active', activeLabKey === key || key.includes(activeLabKey) || activeLabKey.includes(key));
      });
    }
  }

  if (statsBar) statsBar.style.display = 'none';
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 24px; color: #64748b;">กำลังโหลดข้อมูลย้อนหลัง ${limit} ครั้งล่าสุด...</td></tr>`;
  }

  try {
    if (type === 'bp') {
      // ตารางความดัน & ชีพจร (4 คอลัมน์ กระชับ ไม่รวม นน./สส. และ แผนก)
      thead.innerHTML = `
        <tr>
          <th style="width: 24%;">วันที่</th>
          <th style="width: 26%;">ความดัน</th>
          <th style="width: 22%;">ชีพจร</th>
          <th style="width: 24%;">การประเมิน</th>
        </tr>
      `;

      const res = await fetch(`/api/assistant/patient-vitals-history/${encodeURIComponent(currentHn)}?type=bp&limit=${limit}`);
      const json = await res.json();
      const list = json.data || [];

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px; color: #94a3b8;">ไม่พบประวัติความดันโลหิตย้อนหลัง</td></tr>`;
        if (btnLoadMore) btnLoadMore.style.display = 'none';
        if (chartCard) chartCard.style.display = 'none';
        if (svgEl) svgEl.innerHTML = '';
        return;
      }

      let sumSbp = 0, sumDbp = 0, sumPr = 0;
      let maxSbp = -1, minSbp = 999;
      let countBp = 0, countPr = 0;

      renderHistoryTrendChart('bp', list);

      tbody.innerHTML = list.map(r => {
        const bps = parseInt(r.bps) || 0;
        const bpd = parseInt(r.bpd) || 0;
        const pr = parseInt(r.pulse) || 0;

        if (bps > 0 && bpd > 0) {
          sumSbp += bps;
          sumDbp += bpd;
          countBp++;
          if (bps > maxSbp) maxSbp = bps;
          if (bps < minSbp) minSbp = bps;
        }
        if (pr > 0) {
          sumPr += pr;
          countPr++;
        }

        const isHighBp = (bps >= 140 || bpd >= 90);
        const bpBadge = (bps > 0 && bpd > 0)
          ? (isHighBp
              ? `<span class="val-text text-danger">${bps}/${bpd}</span>`
              : `<span class="val-text text-normal">${bps}/${bpd}</span>`)
          : '-';

        let prBadge = '-';
        if (pr > 100) prBadge = `<span class="val-text text-danger">${pr} bpm</span>`;
        else if (pr < 60 && pr > 0) prBadge = `<span class="val-text text-warn">${pr} bpm</span>`;
        else if (pr > 0) prBadge = `<span class="val-text text-normal">${pr} bpm</span>`;

        let evalBadge = '-';
        if (bps > 0) {
          if (isHighBp) evalBadge = `<span class="val-text text-danger">ความดันสูง</span>`;
          else if (bps < 90) evalBadge = `<span class="val-text text-warn">ความดันต่ำ</span>`;
          else evalBadge = `<span class="val-text text-normal">ปกติ</span>`;
        }

        let rowClass = '';
        if (bps >= 160 || bpd >= 100) {
          rowClass = 'row-danger';
        } else if (bps >= 140 || bpd >= 90 || (bps < 90 && bps > 0)) {
          rowClass = 'row-warn';
        }

        const timeTip = r.vsttime ? `🕒 เวลาที่มาตรวจ: ${r.vsttime.slice(0, 5)} น.` : '🕒 เวลาที่มาตรวจ: ไม่ระบุ';

        return `
          <tr class="${rowClass}">
            <td class="cell-date-tip" data-tooltip="${escapeHtml(timeTip)}">${escapeHtml(r.vstdate_thai || r.vstdate)}</td>
            <td><b>${bpBadge}</b></td>
            <td>${prBadge}</td>
            <td>${evalBadge}</td>
          </tr>
        `;
      }).join('');

      if (countBp > 0 && statsBar) {
        const avgSbp = Math.round(sumSbp / countBp);
        const avgDbp = Math.round(sumDbp / countBp);
        const avgPr = countPr > 0 ? Math.round(sumPr / countPr) : '-';
        document.getElementById('statAvg').textContent = `เฉลี่ย: ${avgSbp}/${avgDbp} · PR ${avgPr}`;
        document.getElementById('statMax').textContent = `SBP สูงสุด ${maxSbp}`;
        document.getElementById('statMin').textContent = `SBP ต่ำสุด ${minSbp}`;
        statsBar.style.display = 'flex';
      }

      const wrapLoadMore = document.getElementById('wrapTableLoadMore');
      if (btnLoadMore) {
        const hasMore = (list.length >= limit);
        if (wrapLoadMore) wrapLoadMore.style.display = hasMore ? 'block' : 'none';
        btnLoadMore.style.display = hasMore ? 'inline-flex' : 'none';
        btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
      }

    } else if (type === 'bw') {
      // ตารางประวัติน้ำหนัก ส่วนสูง และ BMI (แยกออกจาก BP/PR ตามสั่ง)
      thead.innerHTML = `
        <tr>
          <th style="width: 24%;">วันที่</th>
          <th style="width: 18%;">น้ำหนัก</th>
          <th style="width: 18%;">ส่วนสูง</th>
          <th style="width: 16%;">BMI</th>
          <th style="width: 20%;">การประเมิน</th>
        </tr>
      `;

      const res = await fetch(`/api/assistant/patient-vitals-history/${encodeURIComponent(currentHn)}?type=bw&limit=${limit}`);
      const json = await res.json();
      const list = json.data || [];

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #94a3b8;">ไม่พบประวัติน้ำหนักส่วนสูงย้อนหลัง</td></tr>`;
        if (btnLoadMore) btnLoadMore.style.display = 'none';
        if (chartCard) chartCard.style.display = 'none';
        if (svgEl) svgEl.innerHTML = '';
        return;
      }

      renderHistoryTrendChart('bw', list);

      let maxBw = -1, minBw = 999;
      let latestBw = null;

      tbody.innerHTML = list.map((r, idx) => {
        const bwVal = parseFloat(r.bw);
        const htVal = parseFloat(r.height);
        const bmiVal = parseFloat(r.bmi);

        if (!isNaN(bwVal) && bwVal > 0) {
          if (latestBw === null) latestBw = bwVal;
          if (bwVal > maxBw) maxBw = bwVal;
          if (bwVal < minBw) minBw = bwVal;
        }

        const bwText = (!isNaN(bwVal) && bwVal > 0) ? `${bwVal.toFixed(1)} kg` : '-';
        const htText = (!isNaN(htVal) && htVal > 0) ? `${Math.round(htVal)} cm` : '-';
        const bmiText = (!isNaN(bmiVal) && bmiVal > 0) ? bmiVal.toFixed(1) : '-';

        let evalBadge = '-';
        let rowClass = '';
        if (!isNaN(bmiVal) && bmiVal > 0) {
          if (bmiVal >= 30) { evalBadge = `<span class="val-text text-danger">อ้วนมาก</span>`; rowClass = 'row-danger'; }
          else if (bmiVal >= 25) { evalBadge = `<span class="val-text text-warn">อ้วน</span>`; rowClass = 'row-warn'; }
          else if (bmiVal >= 23) { evalBadge = `<span class="val-text text-warn">น้ำหนักเกิน</span>`; rowClass = 'row-warn'; }
          else if (bmiVal >= 18.5) { evalBadge = `<span class="val-text text-normal">ปกติ</span>`; }
          else { evalBadge = `<span class="val-text text-warn">ผอม</span>`; rowClass = 'row-warn'; }
        }

        const timeTip = r.vsttime ? `🕒 เวลาที่มาตรวจ: ${r.vsttime.slice(0, 5)} น.` : '🕒 เวลาที่มาตรวจ: ไม่ระบุ';

        return `
          <tr class="${rowClass}">
            <td class="cell-date-tip" data-tooltip="${escapeHtml(timeTip)}">${escapeHtml(r.vstdate_thai || r.vstdate)}</td>
            <td><b>${bwText}</b></td>
            <td>${htText}</td>
            <td><b>${bmiText}</b></td>
            <td>${evalBadge}</td>
          </tr>
        `;
      }).join('');

      if (latestBw !== null && statsBar) {
        document.getElementById('statAvg').textContent = `ล่าสุด: ${latestBw.toFixed(1)} kg`;
        document.getElementById('statMax').textContent = maxBw > 0 ? `นน.สูงสุด ${maxBw.toFixed(1)} kg` : '-';
        document.getElementById('statMin').textContent = minBw < 999 ? `นน.ต่ำสุด ${minBw.toFixed(1)} kg` : '-';
        statsBar.style.display = 'flex';
      }

      const wrapLoadMore = document.getElementById('wrapTableLoadMore');
      if (btnLoadMore) {
        const hasMore = (list.length >= limit);
        if (wrapLoadMore) wrapLoadMore.style.display = hasMore ? 'block' : 'none';
        btnLoadMore.style.display = hasMore ? 'inline-flex' : 'none';
        btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
      }

    } else if (type === 'renal') {
      thead.innerHTML = `
        <tr>
          <th style="width: 25%;">วันที่</th>
          <th style="width: 19%;">Creatinine</th>
          <th style="width: 18%;">eGFR</th>
          <th style="width: 18%;">CrCl</th>
          <th style="width: 20%;">${currentRenalCriteria === 'kdigo' ? 'KDIGO' : 'สภาวะไต'}</th>
        </tr>
      `;

      const res = await fetch(`/api/assistant/patient-lab-history/${encodeURIComponent(currentHn)}?type=cr&limit=${limit * 3}`);
      const json = await res.json();
      const list = json.data || [];

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #94a3b8;">ไม่พบประวัติผลตรวจการทำงานของไต (Serum Cr / eGFR)</td></tr>`;
        if (btnLoadMore) btnLoadMore.style.display = 'none';
        if (chartCard) chartCard.style.display = 'none';
        if (svgEl) svgEl.innerHTML = '';
        return;
      }

      const visitMap = new Map();
      list.forEach(item => {
        const key = `${item.order_date}_${item.order_time || ''}`;
        if (!visitMap.has(key)) {
          visitMap.set(key, {
            order_date: item.order_date,
            order_date_thai: item.order_date_thai,
            order_time: item.order_time,
            cr: null,
            egfr: null,
            clcr: null
          });
        }
        const v = visitMap.get(key);
        const name = (item.lab_items_name || '').toLowerCase();
        const resVal = parseFloat(item.lab_order_result);

        if (!isNaN(resVal)) {
          if (name.includes('creatinine') || name === 'cr' || name.startsWith('cr (')) {
            v.cr = resVal;
          } else if (name.includes('egfr')) {
            v.egfr = resVal;
          } else if (name.includes('clcr') || name.includes('crcl')) {
            v.clcr = resVal;
          }
        }
      });

      const visits = Array.from(visitMap.values()).slice(0, limit);
      const chronological = [...visits].reverse();
      const rawAkiFlags = new Map();
      const kdigoAkiFlags = new Map();

      // คำนวณการเปรียบเทียบ AKI ทั้ง 2 เกณฑ์
      for (let i = 0; i < chronological.length; i++) {
        const cur = chronological[i];
        if (cur.cr === null) continue;

        // 1. Raw Comparison กับครั้งก่อนหน้า (โหมด HOSxP ดั้งเดิม)
        if (i > 0) {
          const prev = chronological[i - 1];
          if (prev.cr !== null && prev.cr > 0) {
            const rawDelta = cur.cr - prev.cr;
            const rawRatio = cur.cr / prev.cr;
            if (rawDelta >= 0.3 || rawRatio >= 1.5) {
              rawAkiFlags.set(`${cur.order_date}_${cur.order_time || ''}`, {
                isAki: true,
                label: `🚨 สงสัย AKI (+${rawDelta.toFixed(2)})`,
                criterion: `เปรียบเทียบกับครั้งก่อนหน้า: Cr เพิ่มขึ้น ${rawDelta.toFixed(2)} mg/dL (จาก ${prev.cr} สู่ ${cur.cr})`
              });
            }
          }
        }

        // 2. KDIGO 2012 สากล (เกณฑ์ 48 ชม. Cr เพิ่มขึ้น >= 0.3 หรือ 7 วัน Cr เพิ่มขึ้น >= 1.5 เท่า)
        const curDate = new Date(`${cur.order_date}T${cur.order_time || '00:00:00'}`);
        const curTime = curDate.getTime();
        if (isNaN(curTime)) continue;

        for (let j = i - 1; j >= 0; j--) {
          const prev = chronological[j];
          if (prev.cr === null) continue;

          const prevDate = new Date(`${prev.order_date}T${prev.order_time || '00:00:00'}`);
          const prevTime = prevDate.getTime();
          if (isNaN(prevTime)) continue;

          const diffHours = (curTime - prevTime) / (1000 * 60 * 60);
          if (diffHours < 0) continue;

          const delta = cur.cr - prev.cr;
          const ratio = cur.cr / prev.cr;

          if (diffHours <= 48 && delta >= 0.3) {
            kdigoAkiFlags.set(`${cur.order_date}_${cur.order_time || ''}`, {
              isAki: true,
              label: `สงสัย AKI (+${delta.toFixed(2)} ใน ${Math.round(diffHours)}ชม.)`,
              criterion: `KDIGO 48h: Cr เพิ่มขึ้น ${delta.toFixed(2)} mg/dL (จาก ${prev.cr} สู่ ${cur.cr}) ภายใน ${Math.round(diffHours)} ชม.`,
              delta: delta.toFixed(2),
              prevCr: prev.cr
            });
            break;
          } else if (diffHours <= 168 && ratio >= 1.5) {
            kdigoAkiFlags.set(`${cur.order_date}_${cur.order_time || ''}`, {
              isAki: true,
              label: `สงสัย AKI (x${ratio.toFixed(1)} ใน ${Math.round(diffHours / 24)}วัน)`,
              criterion: `KDIGO 7d: Cr เพิ่มขึ้น ${ratio.toFixed(1)} เท่าของ Baseline (จาก ${prev.cr} สู่ ${cur.cr}) ภายใน ${Math.round(diffHours / 24)} วัน`,
              delta: delta.toFixed(2),
              prevCr: prev.cr
            });
            break;
          } else if (diffHours > 168) {
            break;
          }
        }
      }

      // ตรวจสอบการยืนยันโรคไตเรื้อรัง (CKD) ตามเกณฑ์ KDIGO (eGFR < 60 นานกว่า 90 วัน)
      const sub60Visits = visits.filter(v => v.egfr !== null && v.egfr < 60);
      let ckdConfirmedText = '';
      if (sub60Visits.length >= 2) {
        const dOldest = new Date(sub60Visits[sub60Visits.length - 1].order_date);
        const dNewest = new Date(sub60Visits[0].order_date);
        const daySpan = Math.round((dNewest - dOldest) / (1000 * 60 * 60 * 24));
        if (daySpan >= 90) {
          ckdConfirmedText = `เข้าเกณฑ์ CKD (eGFR < 60 นาน ${daySpan} วัน > 3 เดือน)`;
        }
      }

      let maxCr = -1, minCr = 999;
      let countCr = 0, latestCr = null;

      renderHistoryTrendChart('renal', visits);

      tbody.innerHTML = visits.map((v, idx) => {
        const key = `${v.order_date}_${v.order_time || ''}`;
        const crVal = v.cr;
        const egfrVal = v.egfr;

        if (crVal !== null) {
          countCr++;
          if (idx === 0) latestCr = crVal;
          if (crVal > maxCr) maxCr = crVal;
          if (crVal < minCr) minCr = crVal;
        }

        // ประเมินสภาวะไต (Stage 1-5 สำหรับ HOSxP หรือ Cat. G1-G5 สำหรับ KDIGO)
        let stageBadge = '<span class="val-text text-muted">-</span>';
        if (egfrVal !== null && egfrVal > 0) {
          if (currentRenalCriteria === 'kdigo') {
            if (egfrVal >= 90) stageBadge = '<span class="val-text text-normal">Cat. G1</span>';
            else if (egfrVal >= 60) stageBadge = '<span class="val-text text-normal">Cat. G2</span>';
            else if (egfrVal >= 45) stageBadge = '<span class="val-text text-warn">Cat. G3a</span>';
            else if (egfrVal >= 30) stageBadge = '<span class="val-text text-warn">Cat. G3b</span>';
            else if (egfrVal >= 15) stageBadge = '<span class="val-text text-danger">Cat. G4</span>';
            else stageBadge = '<span class="val-text text-danger">Cat. G5</span>';
          } else {
            // HOSxP ดั้งเดิม (Stage 1-5)
            if (egfrVal >= 90) stageBadge = '<span class="val-text text-normal">Stage 1</span>';
            else if (egfrVal >= 60) stageBadge = '<span class="val-text text-normal">Stage 2</span>';
            else if (egfrVal >= 45) stageBadge = '<span class="val-text text-warn">Stage 3a</span>';
            else if (egfrVal >= 30) stageBadge = '<span class="val-text text-warn">Stage 3b</span>';
            else if (egfrVal >= 15) stageBadge = '<span class="val-text text-danger">Stage 4</span>';
            else stageBadge = '<span class="val-text text-danger">Stage 5</span>';
          }
        }

        const activeAki = (currentRenalCriteria === 'kdigo') ? kdigoAkiFlags.get(key) : rawAkiFlags.get(key);

        let evalHtml = stageBadge;
        if (activeAki && activeAki.isAki) {
          const akiTip = activeAki.criterion ? `title="${escapeHtml(activeAki.criterion)}"` : '';
          evalHtml = `
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span class="val-text text-danger" ${akiTip}>${escapeHtml(activeAki.label)}</span>
              ${stageBadge}
            </div>
          `;
        }

        const crDisplay = crVal !== null
          ? (crVal > 1.3 ? `<span class="val-text text-danger">${crVal.toFixed(2)}</span>` : `<span class="val-text text-normal">${crVal.toFixed(2)}</span>`)
          : '-';

        let rowClass = '';
        if (activeAki?.isAki || (egfrVal !== null && egfrVal < 30) || (crVal !== null && crVal >= 2.0)) {
          rowClass = 'row-danger';
        } else if ((egfrVal !== null && egfrVal < 60) || (crVal !== null && crVal > 1.3)) {
          rowClass = 'row-warn';
        }

        const timeTip = v.order_time ? `🕒 เวลาสั่งตรวจแล็บ: ${v.order_time.slice(0, 5)} น.` : '🕒 เวลาสั่งตรวจแล็บ: ไม่ระบุ';

        return `
          <tr class="${rowClass}">
            <td class="cell-date-tip" data-tooltip="${escapeHtml(timeTip)}">${escapeHtml(v.order_date_thai || v.order_date)}</td>
            <td><b>${crDisplay}</b></td>
            <td><b>${egfrVal !== null ? egfrVal.toFixed(1) : '-'}</b></td>
            <td>${v.clcr !== null ? v.clcr.toFixed(1) : '-'}</td>
            <td>${evalHtml}</td>
          </tr>
        `;
      }).join('');

      if (countCr > 0 && statsBar) {
        document.getElementById('statAvg').textContent = latestCr !== null ? `ล่าสุด: Cr ${latestCr.toFixed(2)}` : '-';
        document.getElementById('statMax').textContent = `Cr สูงสุด ${maxCr.toFixed(2)}`;
        if (currentRenalCriteria === 'kdigo' && ckdConfirmedText) {
          document.getElementById('statMin').textContent = ckdConfirmedText;
        } else {
          document.getElementById('statMin').textContent = `Cr ต่ำสุด ${minCr.toFixed(2)}`;
        }
        statsBar.style.display = 'flex';
      }

      const wrapLoadMore = document.getElementById('wrapTableLoadMore');
      if (btnLoadMore) {
        const hasMore = (visits.length >= limit);
        if (wrapLoadMore) wrapLoadMore.style.display = hasMore ? 'block' : 'none';
        btnLoadMore.style.display = hasMore ? 'inline-flex' : 'none';
        btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
      }

    } else if (type === 'sugar') {
      thead.innerHTML = `
        <tr>
          <th style="width: 26%;">วันที่</th>
          <th style="width: 20%;">รายการ</th>
          <th style="width: 18%;">ผลตรวจ</th>
          <th style="width: 16%;">หน่วย</th>
          <th style="width: 20%;">การประเมิน</th>
        </tr>
      `;

      const [resHba1c, resFbs] = await Promise.all([
        fetch(`/api/assistant/patient-lab-history/${encodeURIComponent(currentHn)}?type=hba1c&limit=${limit}`).then(r => r.json()).catch(() => ({ data: [] })),
        fetch(`/api/assistant/patient-lab-history/${encodeURIComponent(currentHn)}?type=fbs&limit=${limit}`).then(r => r.json()).catch(() => ({ data: [] }))
      ]);

      const combined = [...(resHba1c.data || []), ...(resFbs.data || [])];
      combined.sort((a, b) => {
        const da = `${a.order_date} ${a.order_time || ''}`;
        const db = `${b.order_date} ${b.order_time || ''}`;
        return db.localeCompare(da);
      });

      const list = combined.slice(0, limit);

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #94a3b8;">ไม่พบประวัติผลตรวจน้ำตาล / HbA1c</td></tr>`;
        if (btnLoadMore) btnLoadMore.style.display = 'none';
        if (chartCard) chartCard.style.display = 'none';
        if (svgEl) svgEl.innerHTML = '';
        return;
      }

      renderHistoryTrendChart('sugar', list);

      tbody.innerHTML = list.map(r => {
        const name = r.lab_items_name || 'Glucose';
        const val = parseFloat(r.lab_order_result);
        const isHba1c = /hba1c|a1c/i.test(name);
        let evalBadge = '-';

        let rowClass = '';
        if (!isNaN(val)) {
          if (isHba1c) {
            if (val < 6.5) evalBadge = `<span class="val-text text-normal">ดีมาก (&lt;6.5)</span>`;
            else if (val <= 7.0) evalBadge = `<span class="val-text text-normal">ตามเป้า (&le;7.0)</span>`;
            else if (val <= 8.0) { evalBadge = `<span class="val-text text-warn">สูง (7.1-8.0)</span>`; rowClass = 'row-warn'; }
            else { evalBadge = `<span class="val-text text-danger">สูงมาก (&gt;8.0)</span>`; rowClass = 'row-danger'; }
          } else {
            if (val < 100 && val >= 70) evalBadge = `<span class="val-text text-normal">ปกติ</span>`;
            else if (val < 126 && val >= 100) { evalBadge = `<span class="val-text text-warn">เสี่ยงเบาหวาน</span>`; rowClass = 'row-warn'; }
            else if (val >= 126) { evalBadge = `<span class="val-text text-danger">เบาหวาน (&ge;126)</span>`; rowClass = 'row-danger'; }
            else { evalBadge = `<span class="val-text text-warn">น้ำตาลต่ำ</span>`; rowClass = 'row-warn'; }
          }
        }

        const timeTip = r.order_time ? `🕒 เวลาสั่งตรวจแล็บ: ${r.order_time.slice(0, 5)} น.` : '🕒 เวลาสั่งตรวจแล็บ: ไม่ระบุ';

        return `
          <tr class="${rowClass}">
            <td class="cell-date-tip" data-tooltip="${escapeHtml(timeTip)}">${escapeHtml(r.order_date_thai || r.order_date)}</td>
            <td><b>${escapeHtml(name)}</b></td>
            <td><b>${escapeHtml(r.lab_order_result)}</b></td>
            <td>${escapeHtml(r.lab_items_unit || (isHba1c ? '%' : 'mg/dL'))}</td>
            <td>${evalBadge}</td>
          </tr>
        `;
      }).join('');

      const wrapLoadMore = document.getElementById('wrapTableLoadMore');
      if (btnLoadMore) {
        const hasMore = (list.length >= limit);
        if (wrapLoadMore) wrapLoadMore.style.display = hasMore ? 'block' : 'none';
        btnLoadMore.style.display = hasMore ? 'inline-flex' : 'none';
        btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
      }

    } else if (type.startsWith('lab_')) {
      const rawLabName = type.replace('lab_', '');
      const queryLab = (/^hematocrit\d*$|^hct\d*$/i.test(rawLabName)) ? 'hct' : rawLabName;
      thead.innerHTML = `
        <tr>
          <th style="width: 24%;">วันที่</th>
          <th style="width: 28%;">รายการแล็บ</th>
          <th style="width: 18%;">ผลตรวจ</th>
          <th style="width: 14%;">หน่วย</th>
          <th style="width: 16%;">ค่าปกติ</th>
        </tr>
      `;

      const res = await fetch(`/api/assistant/patient-lab-history/${encodeURIComponent(currentHn)}?type=${encodeURIComponent(queryLab)}&limit=${limit}`);
      const json = await res.json();
      const list = json.data || [];

      const wrapLoadMore = document.getElementById('wrapTableLoadMore');
      if (list.length === 0) {
        const displayLabName = (/^hematocrit\d*$|^hct\d*$/i.test(rawLabName)) ? 'Hct / Hematocrit' : rawLabName;
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #94a3b8;">ไม่พบประวัติผลตรวจแล็บ ${escapeHtml(displayLabName)}</td></tr>`;
        if (wrapLoadMore) wrapLoadMore.style.display = 'none';
        if (btnLoadMore) btnLoadMore.style.display = 'none';
        if (chartCard) chartCard.style.display = 'none';
        if (svgEl) svgEl.innerHTML = '';
        return;
      }

      renderHistoryTrendChart(type, list);

      tbody.innerHTML = list.map(r => {
        const timeTip = r.order_time ? `🕒 เวลาสั่งตรวจแล็บ: ${r.order_time.slice(0, 5)} น.` : '🕒 เวลาสั่งตรวจแล็บ: ไม่ระบุ';
        const labEval = evaluateLabResult({
          item_name: r.lab_items_name || labName,
          result: r.lab_order_result,
          normal_value: r.lab_items_normal_value,
          abnormal: r.abnormal_result === 'Y',
          critical: r.critical_result === 'Y'
        });

        let rowClass = '';
        let badgeHtml = `<span class="val-text text-normal">${escapeHtml(r.lab_order_result)}</span>`;
        if (labEval.isCritical) {
          rowClass = 'row-danger';
          badgeHtml = `<span class="val-text text-danger">${escapeHtml(r.lab_order_result)} (วิกฤต)</span>`;
        } else if (labEval.isAbnormal) {
          rowClass = 'row-warn';
          badgeHtml = `<span class="val-text text-warn">${escapeHtml(r.lab_order_result)}</span>`;
        }

        return `
          <tr class="${rowClass}">
            <td class="cell-date-tip" data-tooltip="${escapeHtml(timeTip)}">${escapeHtml(r.order_date_thai || r.order_date)}</td>
            <td><b>${escapeHtml(r.lab_items_name || labName)}</b></td>
            <td>${badgeHtml}</td>
            <td>${escapeHtml(r.lab_items_unit || '')}</td>
            <td style="color: #64748b;">${escapeHtml(r.lab_items_normal_value || '-')}</td>
          </tr>
        `;
      }).join('');

      if (btnLoadMore) {
        const hasMore = (list.length >= limit);
        if (wrapLoadMore) wrapLoadMore.style.display = hasMore ? 'block' : 'none';
        btnLoadMore.style.display = hasMore ? 'inline-flex' : 'none';
        btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
      }
    }

  } catch (err) {
    console.error('fetchAndRenderHistory error:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 20px; color: #dc2626;">เกิดข้อผิดพลาดในการโหลดข้อมูล: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ─── ฟังก์ชันคัดลอกข้อความ PE (ไปวางใน HOSxP) ───
function setupCopyPeButton() {
  const btn = document.getElementById('btnCopyPe');
  const textarea = document.getElementById('peTextarea');
  if (!btn || !textarea) return;

  btn.addEventListener('click', () => {
    const text = (textarea.value || '').trim();
    if (!text) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showCopySuccess();
      }).catch(() => {
        fallbackCopy(textarea);
      });
    } else {
      fallbackCopy(textarea);
    }
  });

  function fallbackCopy(el) {
    el.select();
    try {
      document.execCommand('copy');
      showCopySuccess();
    } catch (e) {
      showAppNotice('คัดลอกอัตโนมัติไม่สำเร็จ กรุณากด Ctrl+C เพื่อคัดลอกข้อความ', 'info');
    }
  }

  function showCopySuccess() {
    btn.textContent = '✓ คัดลอกสำเร็จ!';
    btn.style.background = '#059669';
    playAlertChime(false);
    setTimeout(() => {
      btn.textContent = '📋 คัดลอกข้อความ PE';
      btn.style.background = '#0f766e';
    }, 2200);
  }
}

// ─── ตั้งค่าแท็บใน History Modal และตัวกรองกลุ่มยา ───
function setupModalTabsAndDoseFilter() {
  const tab1 = document.getElementById('tabHist1');
  const tab2 = document.getElementById('tabHist2');
  const filterChips = document.querySelectorAll('.chip-filter');

  tab1?.addEventListener('click', () => {
    if (currentModalMode === 'renal') {
      switchModalTab('trend');
    } else if (currentModalMode === 'vitals') {
      switchModalTab('bp');
    }
  });

  tab2?.addEventListener('click', () => {
    if (currentModalMode === 'renal') {
      switchModalTab('dose');
    } else if (currentModalMode === 'vitals') {
      switchModalTab('bw');
    }
  });

  // Toggle สลับเกณฑ์การแสดงผลค่าไตใน History Modal (HOSxP ทั่วไป vs KDIGO สากล)
  const btnCritHosxp = document.getElementById('btnCriteriaHosxp');
  const btnCritKdigo = document.getElementById('btnCriteriaKdigo');

  btnCritHosxp?.addEventListener('click', () => {
    currentRenalCriteria = 'hosxp';
    btnCritHosxp.classList.add('active');
    btnCritKdigo?.classList.remove('active');
    fetchAndRenderHistory('renal', currentHistoryLimit);
  });

  btnCritKdigo?.addEventListener('click', () => {
    currentRenalCriteria = 'kdigo';
    btnCritKdigo.classList.add('active');
    btnCritHosxp?.classList.remove('active');
    fetchAndRenderHistory('renal', currentHistoryLimit);
  });

  // Toggle สลับน้ำหนักคำนวณ Cockcroft-Gault (Actual BW vs AdjBW vs IBW)
  const btnWtAbw = document.getElementById('btnWeightAbw');
  const btnWtAdjbw = document.getElementById('btnWeightAdjbw');
  const btnWtIbw = document.getElementById('btnWeightIbw');

  btnWtAbw?.addEventListener('click', () => {
    currentDoseWeightChoice = 'abw';
    renderRenalDoseGuide();
  });

  btnWtAdjbw?.addEventListener('click', () => {
    currentDoseWeightChoice = 'adjbw';
    renderRenalDoseGuide();
  });

  btnWtIbw?.addEventListener('click', () => {
    currentDoseWeightChoice = 'ibw';
    renderRenalDoseGuide();
  });

  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentDoseFilter = chip.dataset.cat || 'all';
      renderRenalDoseGuide();
    });
  });

  // ปุ่มสลับรายการผลแล็บ Quick Chips ใน Modal
  document.querySelectorAll('#labChipGroup .btn-toggle-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const labKey = btn.dataset.lab;
      if (labKey) openLabHistory(labKey);
    });
  });

  // ปุ่ม ดูกราฟแล็บ ที่ส่วนหัวแจ้งเตือนผลแล็บ
  document.getElementById('btnLabTrendHeader')?.addEventListener('click', () => {
    openGeneralLabHistory();
  });

  // ปุ่มย่อ/ขยายกราฟแนวโน้มใน Modal
  const btnToggleChart = document.getElementById('btnToggleChart');
  const chartBody = document.getElementById('histChartBody');
  btnToggleChart?.addEventListener('click', () => {
    isHistoryChartVisible = !isHistoryChartVisible;
    if (chartBody) {
      chartBody.style.display = isHistoryChartVisible ? 'block' : 'none';
    }
    btnToggleChart.textContent = isHistoryChartVisible ? '📉 ซ่อนกราฟ' : '📈 แสดงกราฟ';
  });
}

function switchModalTab(tabKey) {
  currentActiveModalTab = tabKey;
  const tab1 = document.getElementById('tabHist1');
  const tab2 = document.getElementById('tabHist2');
  const wrapTable = document.getElementById('wrapHistTable');
  const wrapDose = document.getElementById('wrapRenalDose');
  const statsBar = document.getElementById('histStatsBar');
  const btnLoadMore = document.getElementById('btnHistLoadMore');
  const wrapLoadMore = document.getElementById('wrapTableLoadMore');

  if (tabKey === 'dose') {
    tab1?.classList.remove('active');
    tab2?.classList.add('active');
    if (wrapTable) wrapTable.style.display = 'none';
    if (wrapDose) wrapDose.style.display = 'flex';
    if (statsBar) statsBar.style.display = 'none';
    if (wrapLoadMore) wrapLoadMore.style.display = 'none';
    if (btnLoadMore) btnLoadMore.style.display = 'none';
    const chartCard = document.getElementById('histChartCard');
    if (chartCard) chartCard.style.display = 'none';
    renderRenalDoseGuide(currentCrcl, currentEgfr);
  } else if (tabKey === 'trend') {
    tab2?.classList.remove('active');
    tab1?.classList.add('active');
    if (wrapTable) wrapTable.style.display = 'block';
    if (wrapDose) wrapDose.style.display = 'none';
    if (btnLoadMore) btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
    currentHistoryType = 'renal';
    fetchAndRenderHistory('renal', currentHistoryLimit);
  } else if (tabKey === 'bw') {
    tab1?.classList.remove('active');
    tab2?.classList.add('active');
    if (wrapTable) wrapTable.style.display = 'block';
    if (wrapDose) wrapDose.style.display = 'none';
    if (btnLoadMore) btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
    currentHistoryType = 'bw';
    fetchAndRenderHistory('bw', currentHistoryLimit);
  } else if (tabKey === 'bp') {
    tab2?.classList.remove('active');
    tab1?.classList.add('active');
    if (wrapTable) wrapTable.style.display = 'block';
    if (wrapDose) wrapDose.style.display = 'none';
    if (btnLoadMore) btnLoadMore.textContent = 'ดูประวัติเพิ่มเติม';
    currentHistoryType = 'bp';
    fetchAndRenderHistory('bp', currentHistoryLimit);
  }
}

// ─── เรนเดอร์ตารางแนวทางการปรับขนาดยาตาม CrCl ───
function renderRenalDoseGuide(crcl = null, egfr = null) {
  const container = document.getElementById('renalDoseList');
  const bannerDesc = document.getElementById('renalDoseBannerDesc');
  if (!container) return;

  // 1. ตรวจสอบน้ำหนักที่เลือกตาม Toggle (abw / adjbw / ibw)
  let weightUsed = currentPtActualWeight;
  let weightName = 'Actual BW';

  if (currentDoseWeightChoice === 'adjbw') {
    weightUsed = currentPtAdjBw || currentPtActualWeight;
    weightName = 'AdjBW';
  } else if (currentDoseWeightChoice === 'ibw') {
    weightUsed = currentPtIbw || currentPtActualWeight;
    weightName = 'IBW';
  } else {
    weightUsed = currentPtActualWeight;
    weightName = 'Actual BW';
  }

  // อัปเดตปุ่ม Toggle น้ำหนักคำนวณ Cockcroft-Gault ให้สั้นกระชับ ไม่ล้นจอ
  const btnAbw = document.getElementById('btnWeightAbw');
  const btnAdjbw = document.getElementById('btnWeightAdjbw');
  const btnIbw = document.getElementById('btnWeightIbw');

  const abwTxt = currentPtActualWeight > 0 ? `น้ำหนักจริง(${currentPtActualWeight.toFixed(1)} kg)` : 'น้ำหนักจริง(ABW)';
  const adjTxt = 'ปรับลด(AdjBW)';
  const ibwTxt = currentPtIbw ? `อุดมคติ(${currentPtIbw.toFixed(1)} kg)` : 'อุดมคติ(IBW)';

  if (btnAbw) {
    btnAbw.textContent = abwTxt;
    btnAbw.classList.toggle('active', currentDoseWeightChoice === 'abw');
  }
  if (btnAdjbw) {
    btnAdjbw.textContent = adjTxt;
    btnAdjbw.classList.toggle('active', currentDoseWeightChoice === 'adjbw');
  }
  if (btnIbw) {
    btnIbw.textContent = ibwTxt;
    btnIbw.classList.toggle('active', currentDoseWeightChoice === 'ibw');
  }

  // แสดงคำเตือนถ้าผู้ป่วยอ้วน (>120% IBW) และกำลังใช้น้ำหนักจริง Actual BW
  const obeseAlert = document.getElementById('doseObeseAlert');
  if (obeseAlert) {
    if (isPatientObese && currentDoseWeightChoice === 'abw') {
      obeseAlert.style.display = 'block';
    } else {
      obeseAlert.style.display = 'none';
    }
  }

  // คำนวณ CrCl แบบไดนามิกตามน้ำหนักที่เลือก
  const age = parseInt(currentPatientData?.age_y) || parseInt(currentPatientData?.age) || 50;
  const isFemale = (currentPatientData?.sex === '2' || currentPatientData?.sex === 'หญิง');
  let dynamicCrcl = null;

  if (currentScr && currentScr > 0 && weightUsed > 0 && age > 0) {
    dynamicCrcl = ((140 - age) * weightUsed) / (72 * currentScr);
    if (isFemale) dynamicCrcl *= 0.85;
  } else if (crcl !== null && !isNaN(crcl)) {
    dynamicCrcl = parseFloat(crcl);
  } else if (currentCrcl !== null) {
    dynamicCrcl = currentCrcl;
  }

  const validCrcl = (dynamicCrcl !== null && !isNaN(dynamicCrcl)) ? parseFloat(dynamicCrcl) : ((currentEgfr !== null && !isNaN(currentEgfr)) ? parseFloat(currentEgfr) : 100);
  const crclDisplay = (dynamicCrcl !== null && !isNaN(dynamicCrcl)) ? Math.round(dynamicCrcl) : '-';
  const egfrDisplay = (currentEgfr !== null && !isNaN(currentEgfr)) ? Math.round(currentEgfr) : '-';
  const scrDisplay = (currentScr !== null && !isNaN(currentScr)) ? currentScr + ' mg/dL' : '-';

  if (bannerDesc) {
    const wtLabel = `${weightName} (${weightUsed > 0 ? weightUsed.toFixed(1) + ' kg' : '-'})`;
    bannerDesc.textContent = `CrCl: ${crclDisplay} mL/min (Cockcroft-Gault, ใช้น้ำหนัก ${wtLabel}) · eGFR: ${egfrDisplay} mL/min/1.73m² (สูตร CKD-EPI) · Serum Cr: ${scrDisplay}`;
  }

  // ค้นหายาของผู้ป่วยที่ตรงกับตารางปรับยา
  const matchedPrescriptions = [];
  RENAL_DOSE_GUIDELINES.forEach(guide => {
    const foundMed = (currentPatientMeds || []).find(m => guide.matchRegex.test(m.name || ''));
    if (foundMed) {
      matchedPrescriptions.push({ guide, med: foundMed });
    }
  });

  // กรองตามหมวดหมู่หรือสถานะที่ต้องปรับยา
  const filtered = RENAL_DOSE_GUIDELINES.filter(item => {
    const evalResult = item.evaluate(validCrcl);
    const isPrescribed = matchedPrescriptions.some(m => m.guide.id === item.id);

    if (currentDoseFilter === 'action_required') {
      return evalResult.status === 'contraindicated' || evalResult.status === 'reduce' || isPrescribed;
    }
    if (currentDoseFilter === 'patient_meds') {
      return isPrescribed;
    }
    if (currentDoseFilter === 'all') return true;
    return item.category === currentDoseFilter;
  });

  if (filtered.length === 0) {
    if (currentDoseFilter === 'action_required') {
      container.innerHTML = `
        <div style="text-align: center; padding: 28px 18px; color: #065f46; background: #ecfdf5; border: 1.5px solid #a7f3d0; border-radius: 12px; margin-top: 8px;">
          <div style="font-size: 28px; margin-bottom: 6px;">🟢</div>
          <b style="font-size: 15px; color: #047857;">ไม่พบยาที่ต้องปรับลดขนาดหรือมีข้อห้ามใช้ในระดับ CrCl ปัจจุบัน</b>
          <p style="font-size: 12.5px; color: #065f46; margin-top: 6px; line-height: 1.5;">
            ผู้ป่วยมีค่าไต CrCl <b>${crclDisplay} mL/min</b> อยู่ในระดับปลอดภัย สามารถใช้ขนาดยาปกติได้ หรือกดเลือกแท็บ <b>"แสดงทั้งหมด"</b> เพื่อดูสารานุกรมขนาดยาทั้งหมด
          </p>
        </div>
      `;
    } else if (currentDoseFilter === 'patient_meds') {
      container.innerHTML = `
        <div style="text-align: center; padding: 28px 18px; color: #475569; background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 12px; margin-top: 8px;">
          <div style="font-size: 26px; margin-bottom: 6px;">💊</div>
          <b style="font-size: 14px; color: #334155;">ยังไม่พบยาในใบสั่งยาเคสนี้ที่ตรงกับตารางยาปรับตามค่าไต</b>
          <p style="font-size: 12px; color: #64748b; margin-top: 6px;">
            หากแพทย์กำลังจะสั่งจ่ายยาใหม่ สามารถเลือกดูคำแนะนำตามหมวดหมู่ยาด้านบนได้ทันที
          </p>
        </div>
      `;
    } else {
      container.innerHTML = '<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">ไม่พบรายการยาในหมวดหมู่นี้</div>';
    }
    return;
  }

  // จัดเรียง: นำยาที่ผู้ป่วยกำลังได้รับจริงมาไว้บนสุด
  filtered.sort((a, b) => {
    const aPrescribed = matchedPrescriptions.some(m => m.guide.id === a.id);
    const bPrescribed = matchedPrescriptions.some(m => m.guide.id === b.id);
    if (aPrescribed && !bPrescribed) return -1;
    if (!aPrescribed && bPrescribed) return 1;
    return 0;
  });

  container.innerHTML = filtered.map(item => {
    const evalResult = item.evaluate(validCrcl);
    const isPrescribed = matchedPrescriptions.some(m => m.guide.id === item.id);
    const prescribedMed = matchedPrescriptions.find(m => m.guide.id === item.id)?.med;

    let cardClass = 'card-standard';
    let badgeClass = 'badge-standard';
    if (evalResult.status === 'contraindicated') {
      cardClass = 'card-contraindicated';
      badgeClass = 'badge-contraindicated';
    } else if (evalResult.status === 'reduce') {
      cardClass = 'card-reduce';
      badgeClass = 'badge-reduce';
    }

    return `
      <div class="renal-drug-card ${cardClass} ${isPrescribed ? 'patient-prescribed' : ''}">
        <div class="drug-card-header">
          <div class="drug-name-group">
            <span class="drug-name">${escapeHtml(item.name)}</span>
            <span class="drug-category-tag">${escapeHtml(item.catName)}</span>
            ${isPrescribed ? `<span class="badge-prescribed-now">⚠️ ผู้ป่วยกำลังได้รับยานี้ (${escapeHtml(prescribedMed.name || '')})</span>` : ''}
          </div>
          <span class="drug-action-badge ${badgeClass}">${evalResult.badgeText}</span>
        </div>
        <div class="drug-recommendation">${escapeHtml(evalResult.recommendation)}</div>
        <div class="drug-caution">💡 ข้อควรระวัง: ${escapeHtml(evalResult.caution)}</div>
      </div>
    `;
  }).join('');
}

// ─── Global Floating Tooltip Controller (สไตล์ Modern Slate มืด เรียบหรู ไร้ดีเลย์) ───
function setupFloatingTooltip() {
  const tooltipEl = document.getElementById('appFloatingTooltip');
  if (!tooltipEl) return;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;

    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    tooltipEl.textContent = text;
    tooltipEl.classList.add('show');

    const rect = target.getBoundingClientRect();
    const tipWidth = tooltipEl.offsetWidth;
    const tipHeight = tooltipEl.offsetHeight;

    let left = rect.left + (rect.width / 2) - (tipWidth / 2);
    let top = rect.top - tipHeight - 7;

    // ตรวจสอบขอบจอไม่ให้ล้นออกนอกจอ
    if (left < 8) left = 8;
    if (left + tipWidth > window.innerWidth - 8) left = window.innerWidth - tipWidth - 8;
    if (top < 8) top = rect.bottom + 7;

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (target) {
      tooltipEl.classList.remove('show');
    }
  });
}

// ─── 4.7 ระบบปรับขนาดตัวอักษรของ Sidebar (Font Scaler Controller) ───
const FONT_SCALES = [90, 100, 110, 120, 130];
let currentFontScaleIndex = 1; // ค่าเริ่มต้น 100%

function applyFontScale(scale) {
  FONT_SCALES.forEach(s => document.body.classList.remove(`scale-${s}`));
  document.body.classList.add(`scale-${scale}`);

  const label = document.getElementById('fontScaleText');
  if (label) label.textContent = `${scale}%`;

  try {
    localStorage.setItem('doc_sidebar_font_scale', String(scale));
  } catch (e) {}
}

function setupFontScaler() {
  const btnDown = document.getElementById('btnFontDown');
  const btnUp = document.getElementById('btnFontUp');

  // โหลดค่าเดิมจาก localStorage
  try {
    const saved = parseInt(localStorage.getItem('doc_sidebar_font_scale'), 10);
    const idx = FONT_SCALES.indexOf(saved);
    if (idx !== -1) {
      currentFontScaleIndex = idx;
    }
  } catch (e) {}

  applyFontScale(FONT_SCALES[currentFontScaleIndex]);

  btnDown?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentFontScaleIndex > 0) {
      currentFontScaleIndex--;
      applyFontScale(FONT_SCALES[currentFontScaleIndex]);
    }
  });

  btnUp?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentFontScaleIndex < FONT_SCALES.length - 1) {
      currentFontScaleIndex++;
      applyFontScale(FONT_SCALES[currentFontScaleIndex]);
    }
  });
}


// ══════════════════════════════════════════════════════════════════
// ─── ระบบวาดกราฟเส้นเปรียบเทียบแนวโน้ม (History Trend Line Chart) ───
// แบบ Pure Vector SVG สวยงาม ตอบสนองทุกขนาดหน้าจอ ทำงานออฟไลน์ 100%
// ══════════════════════════════════════════════════════════════════

function formatShortChartDate(str) {
  if (!str) return '';
  const s = String(str).trim();
  // เช่น "28 ต.ค. 2569" หรือ "28 ต.ค. 69" -> "28 ต.ค."
  const mThai = s.match(/([0-9]{1,2})\s+([ก-๙a-zA-Z.]+)/);
  if (mThai) {
    const day = mThai[1];
    const month = mThai[2].replace(/\./g, '');
    return `${day} ${month}`;
  }
  // เช่น "2026-10-28" -> "28/10"
  const mIso = s.match(/[0-9]{4}-([0-9]{2})-([0-9]{2})/);
  if (mIso) {
    return `${mIso[2]}/${mIso[1]}`;
  }
  return s.slice(0, 7);
}

function renderHistoryTrendChart(type, data) {
  const card = document.getElementById('histChartCard');
  const titleEl = document.getElementById('histChartTitle');
  const legendEl = document.getElementById('histChartLegend');
  const svgEl = document.getElementById('histChartSvg');
  if (!card || !svgEl) return;

  if (!data || data.length === 0) {
    card.style.display = 'none';
    return;
  }

  let title = 'กราฟแนวโน้ม';
  const seriesList = [];
  const refLines = [];

  if (type === 'renal') {
    title = 'แนวโน้มการทำงานของไต (eGFR & Serum Creatinine)';
    const chrono = [...data].reverse();
    const egfrPts = [];
    const crPts = [];

    chrono.forEach(v => {
      const dt = formatShortChartDate(v.order_date_thai || v.order_date);
      if (v.egfr !== null && !isNaN(v.egfr)) {
        egfrPts.push({
          date: dt,
          val: parseFloat(v.egfr),
          displayVal: parseFloat(v.egfr).toFixed(1),
          unit: 'mL/min',
          tip: `${dt}: eGFR ${parseFloat(v.egfr).toFixed(1)} mL/min/1.73m²`
        });
      }
      if (v.cr !== null && !isNaN(v.cr)) {
        crPts.push({
          date: dt,
          val: parseFloat(v.cr),
          displayVal: parseFloat(v.cr).toFixed(2),
          unit: 'mg/dL',
          tip: `${dt}: Serum Cr ${parseFloat(v.cr).toFixed(2)} mg/dL`
        });
      }
    });

    if (egfrPts.length >= 2 || crPts.length >= 2) {
      if (egfrPts.length >= 2) {
        seriesList.push({
          id: 'egfr',
          name: 'eGFR',
          color: '#10b981',
          data: egfrPts,
          unit: 'mL/min',
          yAxis: 'primary',
          valPos: 'top'
        });
      }
      if (crPts.length >= 2) {
        seriesList.push({
          id: 'cr',
          name: 'Serum Cr',
          color: '#f59e0b',
          data: crPts,
          unit: 'mg/dL',
          yAxis: 'secondary',
          valPos: 'bottom'
        });
      }
      refLines.push({ yVal: 60, yAxis: 'primary', label: 'eGFR 60 (เกณฑ์ CKD)', color: '#d97706' });
    }

  } else if (type === 'bp') {
    title = 'แนวโน้มความดันโลหิต & ชีพจร (BP & Heart Rate Trend)';
    const chrono = [...data].reverse();
    const sbpPts = [];
    const dbpPts = [];
    const prPts = [];

    chrono.forEach(r => {
      const dt = formatShortChartDate(r.vstdate_thai || r.vstdate);
      const s = parseInt(r.bps) || 0;
      const d = parseInt(r.bpd) || 0;
      const p = parseInt(r.pulse) || 0;

      if (s > 0) sbpPts.push({ date: dt, val: s, displayVal: s, unit: 'mmHg', tip: `${dt}: SBP ${s} mmHg`, valPos: 'top' });
      if (d > 0) dbpPts.push({ date: dt, val: d, displayVal: d, unit: 'mmHg', tip: `${dt}: DBP ${d} mmHg`, valPos: 'bottom' });
      if (p > 0) prPts.push({ date: dt, val: p, displayVal: p, unit: 'bpm', tip: `${dt}: ชีพจร ${p} bpm`, valPos: 'top' });
    });

    if (sbpPts.length >= 2) {
      seriesList.push({ id: 'sbp', name: 'SBP (ตัวบน)', color: '#0284c7', data: sbpPts, unit: 'mmHg', yAxis: 'primary', valPos: 'top' });
    }
    if (dbpPts.length >= 2) {
      seriesList.push({ id: 'dbp', name: 'DBP (ตัวล่าง)', color: '#8b5cf6', data: dbpPts, unit: 'mmHg', yAxis: 'primary', valPos: 'bottom' });
    }
    if (prPts.length >= 2) {
      seriesList.push({ id: 'pr', name: 'ชีพจร (PR)', color: '#10b981', data: prPts, unit: 'bpm', yAxis: 'primary', valPos: 'top' });
    }
    refLines.push({ yVal: 140, yAxis: 'primary', label: 'เกณฑ์ 140 mmHg', color: '#ef4444' });
    refLines.push({ yVal: 90, yAxis: 'primary', label: 'เกณฑ์ 90 mmHg', color: '#f59e0b' });

  } else if (type === 'bw') {
    title = 'แนวโน้มน้ำหนักตัว & ค่าดัชนีมวลกาย (BMI Trend)';
    const chrono = [...data].reverse();
    const bwPts = [];
    const bmiPts = [];

    chrono.forEach(r => {
      const dt = formatShortChartDate(r.vstdate_thai || r.vstdate);
      const bw = parseFloat(r.bw);
      const bmi = parseFloat(r.bmi);

      if (!isNaN(bw) && bw > 0) bwPts.push({ date: dt, val: bw, displayVal: bw.toFixed(1), unit: 'kg', tip: `${dt}: น้ำหนัก ${bw.toFixed(1)} kg`, valPos: 'top' });
      if (!isNaN(bmi) && bmi > 0) bmiPts.push({ date: dt, val: bmi, displayVal: bmi.toFixed(1), unit: '', tip: `${dt}: BMI ${bmi.toFixed(1)}`, valPos: 'bottom' });
    });

    if (bwPts.length >= 2) {
      seriesList.push({ id: 'bw', name: 'น้ำหนัก (kg)', color: '#4f46e5', data: bwPts, unit: 'kg', yAxis: 'primary', valPos: 'top' });
    }
    if (bmiPts.length >= 2) {
      seriesList.push({ id: 'bmi', name: 'BMI', color: '#059669', data: bmiPts, unit: '', yAxis: 'secondary', valPos: 'bottom' });
      refLines.push({ yVal: 23, yAxis: 'secondary', label: 'BMI 23 (น้ำหนักเกิน)', color: '#d97706' });
    }

  } else if (type === 'sugar') {
    title = 'แนวโน้มระดับน้ำตาลในเลือด & HbA1c';
    const chrono = [...data].reverse();
    const fbsPts = [];
    const a1cPts = [];

    chrono.forEach(r => {
      const dt = formatShortChartDate(r.order_date_thai || r.order_date);
      const val = parseFloat(r.lab_order_result);
      const isA1c = /hba1c|a1c/i.test(r.lab_items_name || '');

      if (!isNaN(val) && val > 0) {
        if (isA1c) {
          a1cPts.push({ date: dt, val: val, displayVal: val.toFixed(1), unit: '%', tip: `${dt}: HbA1c ${val.toFixed(1)}%`, valPos: 'bottom' });
        } else {
          fbsPts.push({ date: dt, val: val, displayVal: Math.round(val), unit: 'mg/dL', tip: `${dt}: FBS ${Math.round(val)} mg/dL`, valPos: 'top' });
        }
      }
    });

    if (fbsPts.length >= 2) {
      seriesList.push({ id: 'fbs', name: 'น้ำตาล FBS (mg/dL)', color: '#d97706', data: fbsPts, unit: 'mg/dL', yAxis: 'primary', valPos: 'top' });
      refLines.push({ yVal: 126, yAxis: 'primary', label: 'FBS 126 (เบาหวาน)', color: '#ef4444' });
    }
    if (a1cPts.length >= 2) {
      seriesList.push({ id: 'a1c', name: 'HbA1c (%)', color: '#7c3aed', data: a1cPts, unit: '%', yAxis: 'secondary', valPos: 'bottom' });
      refLines.push({ yVal: 7.0, yAxis: 'secondary', label: 'HbA1c 7.0%', color: '#d97706' });
    }

  } else if (type.startsWith('lab_')) {
    const rawTarget = type.replace('lab_', '').trim();
    const targetKey = rawTarget.toLowerCase();
    const displayTargetName = (/^hematocrit\d*$|^hct\d*$/i.test(targetKey)) ? 'HCT (HEMATOCRIT)' :
                              (targetKey === 'ldl') ? 'LDL-C (ไขมันเลว)' :
                              (targetKey === 'uacr') ? 'uACR (โปรตีนรั่วในปัสสาวะ)' :
                              (targetKey === 'hba1c' || targetKey === 'a1c') ? 'HbA1c (น้ำตาลสะสม)' :
                              (targetKey === 'cr' || targetKey === 'creatinine') ? 'CREATININE (ค่าไต)' :
                              (targetKey === 'potassium' || targetKey === 'k') ? 'POTASSIUM (K)' :
                              rawTarget.toUpperCase();
    title = `แนวโน้มผลตรวจทางห้องปฏิบัติการ: ${displayTargetName}`;
    const chrono = [...data].reverse();

    // จัดกลุ่มตามชื่อรายการแล็บจริง (lab_items_name) เพื่อไม่นำค่าคนละตัวมาต่อเส้นเดียวกัน
    const itemMap = new Map();
    const palette = ['#0f766e', '#d97706', '#2563eb', '#7c3aed', '#dc2626'];

    chrono.forEach(r => {
      const itemName = String(r.lab_items_name || targetKey).trim();
      const itemLower = itemName.toLowerCase();
      const rawRes = String(r.lab_order_result || '').replace(/,/g, '').trim();
      const val = parseFloat(rawRes);
      if (isNaN(val)) return;

      // กรองเฉพาะรายการที่สัมพันธ์กับที่เลือก (เช่น ถ้าเลือก wbc ไม่ดึง platelet หรือ urine มาปน)
      if (targetKey !== 'cbc') {
        const isHctMatch = (/^hematocrit\d*$|^hct\d*$/i.test(itemLower) && /^hematocrit\d*$|^hct\d*$/i.test(targetKey));
        const isKMatch = ((/potassium|^k$/i.test(itemLower) && /potassium|^k$/i.test(targetKey)) && !itemLower.includes('gap'));
        const isNaMatch = (/sodium|^na$/i.test(itemLower) && /sodium|^na$/i.test(targetKey));
        const isPltMatch = (/platelet|plt/i.test(itemLower) && /platelet|plt/i.test(targetKey));
        const isAstMatch = (/ast|sgot/i.test(itemLower) && /ast|sgot/i.test(targetKey));
        const isAltMatch = (/alt|sgpt/i.test(itemLower) && /alt|sgpt/i.test(targetKey));
        const isCrMatch = (/creatinine|^cr\b/i.test(itemLower) && /creatinine|^cr\b/i.test(targetKey));
        const isLdlMatch = (/^ldl|cholesterol.*ldl/i.test(itemLower) && /ldl/i.test(targetKey));
        const isUacrMatch = (/uacr|microalbumin/i.test(itemLower) && /uacr|microalbumin/i.test(targetKey));
        const isA1cMatch = (/a1c|hba1c/i.test(itemLower) && /a1c|hba1c/i.test(targetKey));

        const matchesTarget = isHctMatch || isKMatch || isNaMatch || isPltMatch || isAstMatch || isAltMatch || isCrMatch || isLdlMatch || isUacrMatch || isA1cMatch ||
          itemLower.includes(targetKey) || targetKey.includes(itemLower);

        if (!matchesTarget) return;
        if (targetKey === 'wbc' && (itemLower.includes('ua') || itemLower.includes('urine'))) return;
        if (targetKey === 'k' && itemLower.includes('gap')) return;
        if (targetKey === 'ldl' && !itemLower.includes('ldl')) return;
      }

      // สำหรับ Hct ให้จัดกลุ่มรวมทั้ง Hematocrit และ Hematocrit2 เพื่อพล็อตเป็นเส้นแนวโน้มเดียวกัน
      const groupKey = (/^hematocrit\d*$|^hct\d*$/i.test(itemName)) ? 'Hematocrit' : itemName;

      if (!itemMap.has(groupKey)) {
        let nMin = null, nMax = null;
        if (r.lab_items_normal_value) {
          const m = String(r.lab_items_normal_value).match(/([0-9.]+)\s*[-–—]\s*([0-9.]+)/);
          if (m) {
            nMin = parseFloat(m[1]);
            nMax = parseFloat(m[2]);
          }
        }
        itemMap.set(groupKey, {
          name: groupKey,
          unit: r.lab_items_unit || (groupKey === 'Hematocrit' ? '%' : ''),
          normMin: nMin,
          normMax: nMax,
          pts: []
        });
      }

      const dt = formatShortChartDate(r.order_date_thai || r.order_date);
      itemMap.get(groupKey).pts.push({
        date: dt,
        val: val,
        displayVal: Number.isInteger(val) ? val : (val >= 100 ? Math.round(val) : val.toFixed(1)),
        unit: r.lab_items_unit || (groupKey === 'Hematocrit' ? '%' : ''),
        tip: `${dt}: ${itemName} = ${val} ${r.lab_items_unit || (groupKey === 'Hematocrit' ? '%' : '')}`
      });
    });

    let sIdx = 0;
    itemMap.forEach((grp, name) => {
      if (grp.pts.length >= 2 && sIdx < 3) {
        const sColor = palette[sIdx % palette.length];
        seriesList.push({
          id: `lab_${sIdx}`,
          name: name,
          color: sColor,
          data: grp.pts,
          unit: grp.unit,
          yAxis: (sIdx === 1 && itemMap.size > 1) ? 'secondary' : 'primary',
          valPos: sIdx % 2 === 0 ? 'top' : 'bottom'
        });
        if (sIdx === 0) {
          if (grp.normMin !== null && !isNaN(grp.normMin)) {
            refLines.push({ yVal: grp.normMin, yAxis: 'primary', label: `ต่ำสุด (${grp.normMin})`, color: '#10b981' });
          }
          if (grp.normMax !== null && !isNaN(grp.normMax)) {
            refLines.push({ yVal: grp.normMax, yAxis: 'primary', label: `สูงสุด (${grp.normMax})`, color: '#ef4444' });
          } else if (targetKey === 'ldl') {
            refLines.push({ yVal: 100, yAxis: 'primary', label: 'เกณฑ์ปกติ (<100)', color: '#10b981' });
          } else if (targetKey === 'hba1c' || targetKey === 'a1c') {
            refLines.push({ yVal: 7.0, yAxis: 'primary', label: 'เป้าหมาย DM (7.0%)', color: '#d97706' });
          } else if (targetKey === 'uacr') {
            refLines.push({ yVal: 30, yAxis: 'primary', label: 'Microalbuminuria (30)', color: '#d97706' });
          }
        }
        sIdx++;
      }
    });
  }

  // หากไม่มีข้อมูลเพียงพอสำหรับพล็อตเส้น
  if (seriesList.length === 0 || seriesList.every(s => s.data.length < 2)) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  if (titleEl) titleEl.textContent = title;

  // เรนเดอร์ Legend
  if (legendEl) {
    legendEl.innerHTML = seriesList.map(s => {
      const lastPt = s.data[s.data.length - 1];
      const valStr = lastPt ? ` (${lastPt.displayVal} ${lastPt.unit || ''})`.trim() : '';
      return `
        <span class="hist-legend-item">
          <span class="hist-legend-dot" style="background-color: ${s.color};"></span>
          <span>${escapeHtml(s.name)}</span>
          <b style="color: ${s.color}; font-size: 10.5px;">${escapeHtml(valStr)}</b>
        </span>
      `;
    }).join('');
  }

  // วาด SVG
  drawSvgChart(svgEl, seriesList, refLines);
}

function drawSvgChart(svgEl, seriesList, refLines) {
  const W = 540;
  const H = 135;
  const padLeft = 40;
  const padRight = 30;
  const padTop = 18;
  const padBottom = 24;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  // แยกชุดข้อมูลตามแกน Y (Primary / Secondary)
  const primarySeries = seriesList.filter(s => s.yAxis !== 'secondary');
  const secondarySeries = seriesList.filter(s => s.yAxis === 'secondary');
  const hasSecondary = secondarySeries.length > 0;

  // 1. คำนวณช่วงค่าแกนหลัก (Primary Y-axis)
  let pMin = Infinity, pMax = -Infinity;
  primarySeries.forEach(s => {
    s.data.forEach(pt => {
      if (pt.val < pMin) pMin = pt.val;
      if (pt.val > pMax) pMax = pt.val;
    });
  });
  refLines.filter(r => r.yAxis !== 'secondary').forEach(r => {
    if (r.yVal < pMin) pMin = r.yVal;
    if (r.yVal > pMax) pMax = r.yVal;
  });
  if (pMin === Infinity) { pMin = 0; pMax = 100; }
  if (pMin === pMax) { pMin = Math.max(0, pMin - 10); pMax = pMax + 10; }
  const pSpan = pMax - pMin;
  pMin = Math.max(0, Math.floor(pMin - pSpan * 0.12));
  pMax = Math.ceil(pMax + pSpan * 0.15);
  if (pMax <= pMin) pMax = pMin + 10;

  // 2. คำนวณช่วงค่าแกนรอง (Secondary Y-axis)
  let sMin = Infinity, sMax = -Infinity;
  if (hasSecondary) {
    secondarySeries.forEach(s => {
      s.data.forEach(pt => {
        if (pt.val < sMin) sMin = pt.val;
        if (pt.val > sMax) sMax = pt.val;
      });
    });
    refLines.filter(r => r.yAxis === 'secondary').forEach(r => {
      if (r.yVal < sMin) sMin = r.yVal;
      if (r.yVal > sMax) sMax = r.yVal;
    });
    if (sMin === Infinity) { sMin = 0; sMax = 10; }
    if (sMin === sMax) { sMin = Math.max(0, sMin - 1); sMax = sMax + 1; }
    const sSpan = sMax - sMin;
    sMin = Math.max(0, Math.floor((sMin - sSpan * 0.1) * 10) / 10);
    sMax = Math.ceil((sMax + sSpan * 0.15) * 10) / 10;
    if (sMax <= sMin) sMax = sMin + 1;
  }

  // ฟังก์ชันสเกล Y
  const scaleY = (val, isSec) => {
    const min = isSec ? sMin : pMin;
    const max = isSec ? sMax : pMax;
    const norm = (val - min) / (max - min || 1);
    return padTop + plotH - (norm * plotH);
  };

  // 4. เส้น Grid แนวนอน (3 เส้น)
  let gridHtml = '';
  [0, 0.5, 1].forEach(ratio => {
    const y = padTop + plotH * (1 - ratio);
    const pTickVal = Math.round(pMin + ratio * (pMax - pMin));
    gridHtml += `<line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="#e2e8f0" stroke-dasharray="3,3" stroke-width="1"/>`;
    gridHtml += `<text x="${padLeft - 5}" y="${y + 3.5}" font-size="8.5" font-weight="600" fill="#94a3b8" text-anchor="end">${pTickVal}</text>`;

    if (hasSecondary) {
      const sTickVal = (sMin + ratio * (sMax - sMin)).toFixed(1);
      const sColor = secondarySeries[0]?.color || '#94a3b8';
      gridHtml += `<text x="${padLeft + plotW + 5}" y="${y + 3.5}" font-size="8.5" font-weight="600" fill="${sColor}" text-anchor="start">${sTickVal}</text>`;
    }
  });

  // 5. เส้นอ้างอิงทางคลินิก (Reference Lines)
  let refLinesHtml = '';
  refLines.forEach(ref => {
    const isSec = (ref.yAxis === 'secondary');
    const y = scaleY(ref.yVal, isSec);
    if (y >= padTop - 2 && y <= padTop + plotH + 2) {
      refLinesHtml += `
        <line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="${ref.color}" stroke-dasharray="4,3" stroke-width="1.2" opacity="0.85"/>
        <text x="${padLeft + plotW - 4}" y="${y - 3.5}" font-size="8.5" font-weight="700" fill="${ref.color}" text-anchor="end">${escapeHtml(ref.label)}</text>
      `;
    }
  });

  // 6. Gradient Defs
  let defsHtml = '<defs>';
  seriesList.forEach(s => {
    defsHtml += `
      <linearGradient id="grad_${s.id}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0.01"/>
      </linearGradient>
    `;
  });
  defsHtml += '</defs>';

  // 7. พล็อตเส้นแต่ละ Series
  let seriesHtml = '';
  const xLabelsMap = new Map();

  seriesList.forEach(s => {
    const isSec = (s.yAxis === 'secondary');
    const pts = s.data;
    const n = pts.length;
    if (n === 0) return;

    const coords = pts.map((pt, i) => {
      const x = (n === 1) ? (padLeft + plotW / 2) : (padLeft + (i / (n - 1)) * plotW);
      const y = scaleY(pt.val, isSec);
      if (!xLabelsMap.has(i)) {
        xLabelsMap.set(i, { x, date: pt.date });
      }
      return { x, y, pt };
    });

    // Path เส้น
    const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');

    // Path แรเงาใต้เส้น
    const firstX = coords[0].x.toFixed(1);
    const lastX = coords[coords.length - 1].x.toFixed(1);
    const bottomY = (padTop + plotH).toFixed(1);
    const areaPath = `M ${firstX} ${bottomY} L ${coords.map(c => `${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' L ')} L ${lastX} ${bottomY} Z`;

    seriesHtml += `
      <path d="${areaPath}" fill="url(#grad_${s.id})"/>
      <path d="${linePath}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    `;

    // จุดวงกลมและตัวเลข
    coords.forEach(c => {
      const isTop = (s.valPos !== 'bottom');
      const textY = isTop ? (c.y - 6.5) : (c.y + 13.5);

      seriesHtml += `
        <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4.2" fill="#ffffff" stroke="${s.color}" stroke-width="2.2" class="chart-point" data-tooltip="${escapeHtml(c.pt.tip)}"/>
        <text x="${c.x.toFixed(1)}" y="${textY.toFixed(1)}" font-size="9.5" font-weight="700" fill="${s.color}" text-anchor="middle" style="pointer-events: none;">${c.pt.displayVal}</text>
      `;
    });
  });

  // 8. วันที่บนแกน X ด้านล่าง
  let xLabelsHtml = '';
  xLabelsMap.forEach(({ x, date }) => {
    xLabelsHtml += `<text x="${x.toFixed(1)}" y="${H - 5}" font-size="9" font-weight="600" fill="#64748b" text-anchor="middle">${escapeHtml(date)}</text>`;
  });

  svgEl.innerHTML = `
    ${defsHtml}
    ${gridHtml}
    ${refLinesHtml}
    ${seriesHtml}
    ${xLabelsHtml}
  `;
}


// ─── ฟังก์ชันเปิดดูประวัติและกราฟแล็บทั่วไป (จากปุ่ม ดูกราฟแล็บ) ───
window.openGeneralLabHistory = function() {
  if (!currentHn) {
    showAppNotice('กรุณาเลือกหรือรอโหลดข้อมูลผู้ป่วยจาก HOSxP ก่อน', 'warning');
    return;
  }
  // ถ้าใน Visit ปัจจุบันมีผลแล็บ ให้เปิดตัวแรก หรือถ้าไม่มีให้เปิด CBC เป็นค่าเริ่มต้น
  const labs = currentPatientData?.labs || [];
  let targetLab = 'cbc';
  if (labs.length > 0 && labs[0].item_name) {
    targetLab = labs[0].item_name;
  }
  openLabHistory(targetLab);
};


// ─── ระบบเลือกดู Visit ย้อนหลังของผู้ป่วย (Patient Visit Picker พร้อมปุ่มดูเพิ่มเติม) ───
function setupVisitPicker() {
  const btnSelect = document.getElementById('btnSelectVisit');
  const dropdown = document.getElementById('visitDropdownList');
  if (!btnSelect || !dropdown) return;

  let currentVisitLimit = 12;

  async function fetchAndRenderVisits(limit) {
    dropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #64748b; font-size: 11px;">กำลังโหลดประวัติ Visit...</div>';
    try {
      const res = await fetch(`/api/assistant/patient-visits/${encodeURIComponent(currentHn)}?limit=${limit}`);
      const json = await res.json();
      const visits = json.visits || [];

      if (visits.length === 0) {
        dropdown.innerHTML = '<div style="padding: 12px; text-align: center; color: #94a3b8; font-size: 11px;">ไม่พบประวัติ Visit อื่นๆ</div>';
        return;
      }

      dropdown.innerHTML = visits.map(v => {
        const isActive = (v.vn === currentVn);
        const timeText = v.vsttime ? v.vsttime.slice(0, 5) + ' น.' : '';
        const diagText = v.diag_text ? `วินิจฉัย: ${escapeHtml(v.diag_text)}` : (v.cc ? `CC: ${escapeHtml(v.cc.slice(0, 45))}` : '');

        return `
          <div class="visit-item ${isActive ? 'active' : ''}" data-vn="${escapeHtml(v.vn)}">
            <div class="visit-item-line1">
              <span>🗓️ ${escapeHtml(v.vstdate_thai || v.vstdate)} ${timeText ? `<span style="font-size:10px;color:#64748b;font-weight:normal;">(${timeText})</span>` : ''}</span>
              <span class="visit-item-dep">${escapeHtml(v.department_name || 'OPD')}</span>
            </div>
            <div class="visit-item-line2">
              <span>VN: <b>${escapeHtml(v.vn)}</b></span>
              <span style="color: #0f766e; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${diagText}</span>
            </div>
          </div>
        `;
      }).join('');

      dropdown.querySelectorAll('.visit-item').forEach(el => {
        el.addEventListener('click', () => {
          const chosenVn = el.getAttribute('data-vn');
          if (chosenVn) {
            isManualSearchActive = true;
            loadPatientData(chosenVn, currentHn);
            dropdown.style.display = 'none';
          }
        });
      });

      // ถ้าผลลัพธ์มีจำนวนถึง limit แสดงปุ่มดู visit เพิ่มเติมต่อท้าย
      if (visits.length >= limit && limit < 100) {
        const wrapMore = document.createElement('div');
        wrapMore.className = 'visit-load-more-wrap';
        wrapMore.innerHTML = '<button type="button" class="btn-load-more-visits">ดู visit เพิ่มเติม (+15)</button>';
        const btnMore = wrapMore.querySelector('button');
        btnMore.addEventListener('click', (e) => {
          e.stopPropagation();
          currentVisitLimit += 15;
          fetchAndRenderVisits(currentVisitLimit);
        });
        dropdown.appendChild(wrapMore);
      }

    } catch (err) {
      dropdown.innerHTML = `<div style="padding: 12px; text-align: center; color: #ef4444; font-size: 11px;">โหลดไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    }
  }

  btnSelect.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentHn) {
      showAppNotice('กรุณาเลือกหรือรอโหลดข้อมูลคนไข้ก่อนเลือก Visit', 'warning');
      return;
    }

    const isHidden = (dropdown.style.display === 'none' || !dropdown.style.display);
    dropdown.style.display = isHidden ? 'flex' : 'none';

    if (isHidden) {
      currentVisitLimit = 12;
      fetchAndRenderVisits(currentVisitLimit);
    }
  });

  document.addEventListener('click', (e) => {
    if (dropdown && !dropdown.contains(e.target) && e.target !== btnSelect) {
      dropdown.style.display = 'none';
    }
  });
}
