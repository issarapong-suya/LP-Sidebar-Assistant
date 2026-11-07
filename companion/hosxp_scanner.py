# companion/hosxp_scanner.py — ตรวจจับ VN, HN และข้อมูลคนไข้จากหน้าจอ HOSxP อัตโนมัติ (Win32 API 64-bit)
import ctypes
from ctypes import wintypes
import re
import urllib.request
import urllib.parse
import json
import socket
import threading
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# ── 64-bit Win32 API Explicit Signatures ──
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int

user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

user32.SendMessageW.restype = wintypes.LPARAM

# ใช้ ctypes.c_void_p สำหรับ lParam เพื่อรองรับ 64-bit Memory Address ป้องกัน OverflowError
user32.SendMessageTimeoutA.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p,
    wintypes.UINT, wintypes.UINT, ctypes.POINTER(wintypes.DWORD)
]
user32.SendMessageTimeoutA.restype = ctypes.c_int64

user32.SendMessageTimeoutW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, ctypes.c_void_p,
    wintypes.UINT, wintypes.UINT, ctypes.POINTER(wintypes.DWORD)
]
user32.SendMessageTimeoutW.restype = ctypes.c_int64

user32.IsHungAppWindow.argtypes = [wintypes.HWND]
user32.IsHungAppWindow.restype = wintypes.BOOL

user32.CloseDesktop.argtypes = [wintypes.HANDLE]
user32.CloseDesktop.restype = wintypes.BOOL

user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL

user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD

user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL

user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.CloseClipboard.argtypes = []
user32.CloseClipboard.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.restype = wintypes.BOOL

def get_clipboard_text():
    """ ดึงข้อความจาก Clipboard ด้วย Win32 API โดยตรง (100% Native ไม่ต้องพึ่งพา tkinter) """
    try:
        CF_UNICODETEXT = 13
        if user32.OpenClipboard(None):
            h_data = user32.GetClipboardData(CF_UNICODETEXT)
            if h_data:
                ptr = kernel32.GlobalLock(h_data)
                if ptr:
                    val = ctypes.c_wchar_p(ptr).value
                    kernel32.GlobalUnlock(h_data)
                    user32.CloseClipboard()
                    return val or ""
            user32.CloseClipboard()
    except Exception:
        pass
    return ""

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
WM_MDIGETACTIVE = 0x0229
SMTO_ABORTIFHUNG = 0x0002
SMTO_NORMAL = 0x0000
GW_CHILD = 5
GW_HWNDNEXT = 2

_initialized_threads = set()

def ensure_default_desktop():
    """ สลับ Thread ไปยัง WinSta0\\Default เพื่อให้เข้าถึงหน้าต่าง HOSxP ของผู้ใช้งานได้อย่างสมบูรณ์ (พร้อมคืน Handle ป้องกัน Memory/Handle Leak) """
    tid = threading.get_ident()
    if tid in _initialized_threads:
        return
    try:
        hDesk = user32.OpenDesktopW("Default", 0, False, 0x01FF) # DESKTOP_ALL
        if hDesk:
            user32.SetThreadDesktop(hDesk)
            user32.CloseDesktop(hDesk) # ปิด Handle ทันทีหลังจาก SetThreadDesktop
            _initialized_threads.add(tid)
    except Exception:
        pass

def get_window_text(hwnd):
    try:
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            return buff.value
    except Exception:
        pass
    return ""

def get_class_name(hwnd):
    try:
        buff = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, buff, 256)
        return buff.value
    except Exception:
        pass
    return ""

def get_process_id(hwnd):
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value
    except Exception:
        return 0

def get_control_text(hwnd):
    """ อ่านข้อความจาก Control ภายใน Delphi/Windows อย่างสมบูรณ์แบบ ทั้ง CP874 (TIS-620) และ UTF-16 พร้อม Timeout ป้องกันค้าง """
    try:
        if not user32.IsWindow(hwnd) or user32.IsHungAppWindow(hwnd):
            return ""

        result = wintypes.DWORD()

        # 1. พยายามอ่านโดยตรงผ่าน SendMessageTimeoutW (WM_GETTEXT) บัฟเฟอร์ 512 ตัวอักษร
        buf_w = ctypes.create_unicode_buffer(512)
        ok_w = user32.SendMessageTimeoutW(
            hwnd, WM_GETTEXT, 512, ctypes.cast(buf_w, ctypes.c_void_p),
            SMTO_ABORTIFHUNG, 35, ctypes.byref(result)
        )
        if ok_w and buf_w.value and len(buf_w.value.strip()) > 0:
            return buf_w.value.strip()

        # 2. พยายามอ่านโดยตรงผ่าน SendMessageTimeoutA (WM_GETTEXT แบบ CP874) สำหรับ Delphi ANSI
        buf_a = ctypes.create_string_buffer(512)
        ok_a = user32.SendMessageTimeoutA(
            hwnd, WM_GETTEXT, 512, ctypes.cast(buf_a, ctypes.c_void_p),
            SMTO_ABORTIFHUNG, 35, ctypes.byref(result)
        )
        if ok_a and buf_a.value:
            try:
                t = buf_a.value.decode('cp874').strip()
                if t:
                    return t
            except Exception:
                try:
                    t = buf_a.value.decode('utf-8', errors='ignore').strip()
                    if t:
                        return t
                except Exception:
                    pass

        # 3. Fallback ผ่าน GetWindowTextW
        user32.GetWindowTextW(hwnd, buf_w, 512)
        if buf_w.value and len(buf_w.value.strip()) > 0:
            return buf_w.value.strip()

        # 4. Fallback ผ่าน GetWindowTextA (CP874)
        user32.GetWindowTextA(hwnd, buf_a, 512)
        if buf_a.value:
            try:
                t = buf_a.value.decode('cp874').strip()
                if t:
                    return t
            except Exception:
                pass

    except Exception:
        pass

    return ""

def get_process_image_path(hwnd):
    try:
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return ""
        hProc = kernel32.OpenProcess(0x1000, False, pid)
        if not hProc:
            return ""
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        success = kernel32.QueryFullProcessImageNameW(hProc, 0, buf, ctypes.byref(size))
        kernel32.CloseHandle(hProc)
        if success:
            return buf.value
    except Exception:
        pass
    return ""

def get_friendly_title(cls, title):
    if title and title.strip() not in ['', ',', '-']:
        return title.strip()
    friendly_map = {
        'TDentalEntryForm': 'ห้องทันตกรรม (Dental)',
        'TOVSTDiagForm': 'ห้องตรวจแพทย์ (Doctor Room)',
        'TOpdScreenForm': 'จุดซักประวัติ / คัดกรอง (OPD Screen)',
        'TDoctorDeskForm': 'ห้องทำงานแพทย์ (Doctor Desk)',
        'TPatientForm': 'ข้อมูลผู้ป่วย (Patient Info)',
        'TMainForm': 'หน้าต่างหลัก HOSxP'
    }
    return friendly_map.get(cls, cls)

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400

class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('BaseAddress', ctypes.c_void_p),
        ('AllocationBase', ctypes.c_void_p),
        ('AllocationProtect', wintypes.DWORD),
        ('RegionSize', ctypes.c_size_t),
        ('State', wintypes.DWORD),
        ('Protect', wintypes.DWORD),
        ('Type', wintypes.DWORD),
    ]

MEM_COMMIT = 0x1000
PAGE_READABLE = {0x02, 0x04, 0x20, 0x40}

kernel32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
kernel32.ReadProcessMemory.restype = wintypes.BOOL

RE_THAI_NAME = re.compile(r'((?:นาย|นางสาว|นาง|น\.ส\.|นพ\.|พญ\.|ทพ\.|ทพญ\.|ภก\.|ภญ\.|พว\.)?\s*[\u0E01-\u0E5B]+(?:\s+[\u0E01-\u0E5B]+)+)')

_CACHED_LOGIN_USER = None
_CACHED_LOGIN_DEPT = None
_CACHED_PID = None
_CACHED_LOGIN_CHECK_AT = 0.0

def extract_login_user_from_pid(pid):
    """ สแกนหาชื่อ User และแผนก ที่ใช้ล็อกอินเข้า HOSxP (BMS HOSxP) จาก Process Memory โดยตรง """
    global _CACHED_LOGIN_USER, _CACHED_LOGIN_DEPT, _CACHED_PID, _CACHED_LOGIN_CHECK_AT
    # Recheck often enough to detect a user switch while the HOSxP process stays open.
    # A short cache avoids rescanning all process memory on every 1.5s monitor tick.
    now = time.monotonic()
    if _CACHED_PID == pid and _CACHED_LOGIN_USER and now - _CACHED_LOGIN_CHECK_AT < 2.0:
        return _CACHED_LOGIN_USER

    hProcess = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not hProcess:
        return None

    pat_json_utf16 = 'hospital_user_name'.encode('utf-16le')
    pat_json_ascii = 'hospital_user_name'.encode('ascii')
    pat_in_time_utf16 = ',ในเวลา'.encode('utf-16le')
    pat_out_time_utf16 = ',นอกเวลา'.encode('utf-16le')
    pat_in_time_cp874 = ',ในเวลา'.encode('cp874')
    pat_out_time_cp874 = ',นอกเวลา'.encode('cp874')
    pat_leave_utf16 = tuple(value.encode('utf-16le') for value in (', ใบลา', ',ใบลา'))
    pat_leave_cp874 = tuple(value.encode('cp874') for value in (', ใบลา', ',ใบลา'))

    addr = 0
    mbi = MEMORY_BASIC_INFORMATION()
    mbi_size = ctypes.sizeof(mbi)
    found_user = None
    found_dept = None

    re_sb = re.compile(r'([\u0E01-\u0E5B\w\.\s]+)\s*\(([^)]+)\)\s*:\s*([^:]+)\s*:\s*([^,]+)')

    while kernel32.VirtualQueryEx(hProcess, ctypes.c_void_p(addr), ctypes.byref(mbi), mbi_size):
        base = mbi.BaseAddress or 0
        size = mbi.RegionSize or 0
        if mbi.State == MEM_COMMIT and (mbi.Protect & 0xFF) in PAGE_READABLE and size < 25 * 1024 * 1024:
            buf = ctypes.create_string_buffer(size)
            bytesRead = ctypes.c_size_t()
            if kernel32.ReadProcessMemory(hProcess, ctypes.c_void_p(base), buf, size, ctypes.byref(bytesRead)):
                raw = buf.raw[:bytesRead.value]

                # 1. hospital_user_name (UTF-16)
                idx = raw.find(pat_json_utf16)
                if idx != -1:
                    chunk = raw[idx:idx + 400]
                    try:
                        txt = chunk.decode('utf-16le', errors='ignore')
                        m = re.search(r'hospital_user_name":\s*"([^"]+)"', txt)
                        if m and m.group(1).strip():
                            found_user = m.group(1).strip()
                            break
                    except Exception:
                        pass

                # 2. hospital_user_name (ASCII / UTF-8)
                idx = raw.find(pat_json_ascii)
                if idx != -1:
                    chunk = raw[idx:idx + 400]
                    try:
                        txt = chunk.decode('utf-8', errors='ignore')
                        m = re.search(r'hospital_user_name":\s*"([^"]+)"', txt)
                        if m and m.group(1).strip():
                            found_user = m.group(1).strip()
                            break
                    except Exception:
                        pass

                # 3. Status Bar (UTF-16) รูปแบบ: ชื่อ (แผนก) : กลุ่มสิทธิ์ : user,ในเวลา
                for pat in (pat_in_time_utf16, pat_out_time_utf16, *pat_leave_utf16):
                    idx = raw.find(pat)
                    if idx != -1:
                        chunk = raw[max(0, idx - 300):idx + len(pat)]
                        try:
                            txt = chunk.decode('utf-16le', errors='ignore')
                            m = re_sb.search(txt)
                            if m:
                                cand = m.group(1).strip()
                                m_clean = re.search(r'[\u0E01-\u0E5B]{2,}(?:\s+[\u0E01-\u0E5B]{2,})+', cand)
                                if m_clean:
                                    found_user = m_clean.group(0).strip()
                                    if m.group(2):
                                        found_dept = m.group(2).strip()
                                    break
                        except Exception:
                            pass
                if found_user:
                    break

                # 4. Status Bar (CP874)
                for pat in (pat_in_time_cp874, pat_out_time_cp874, *pat_leave_cp874):
                    idx = raw.find(pat)
                    if idx != -1:
                        chunk = raw[max(0, idx - 200):idx + len(pat)]
                        try:
                            txt = chunk.decode('cp874', errors='ignore')
                            m = re_sb.search(txt)
                            if m:
                                cand = m.group(1).strip()
                                m_clean = re.search(r'[\u0E01-\u0E5B]{2,}(?:\s+[\u0E01-\u0E5B]{2,})+', cand)
                                if m_clean:
                                    found_user = m_clean.group(0).strip()
                                    if m.group(2):
                                        found_dept = m.group(2).strip()
                                    break
                        except Exception:
                            pass
                if found_user:
                    break

        addr = base + size
        if addr >= 0x7FFFFFFF:
            break

    kernel32.CloseHandle(hProcess)
    if found_user:
        _CACHED_PID = pid
        _CACHED_LOGIN_USER = found_user
        _CACHED_LOGIN_DEPT = found_dept
        _CACHED_LOGIN_CHECK_AT = time.monotonic()
    return found_user

def get_hosxp_login_dept():
    global _CACHED_LOGIN_DEPT
    if _CACHED_LOGIN_DEPT:
        return _CACHED_LOGIN_DEPT
    get_hosxp_active_user()
    return _CACHED_LOGIN_DEPT or "งานคอมพิวเตอร์"

def extract_hosxp_user(texts):
    """ ค้นหาชื่อผู้ใช้งาน HOSxP (Fallback หากไม่สามารถสแกนจาก Memory ได้) """
    for text in texts:
        if not text:
            continue
        t = str(text).strip()
        # HOSxP V3 status bar commonly shows:
        # "ชื่อผู้ใช้ (แผนก): role : ชื่อผู้ใช้, ใบลา".
        # Accept the visible status suffix (including ใบลา) instead of requiring
        # only the older in-time/out-time markers used by the memory scanner.
        status_match = re.search(
            r'(?P<name>[\u0E01-\u0E5B]{2,}(?:\s+[\u0E01-\u0E5B]{2,})+)\s*'
            r'\([^()\r\n]{1,80}\)\s*:\s*[^:,\r\n]{1,80}\s*:\s*[^,\r\n]{1,80}\s*,\s*[^,\r\n]{1,40}',
            t
        )
        if status_match:
            return status_match.group('name').strip()
        m2 = re.search(r'(?:ผู้ใช้งาน|Login|User|Staff)\s*[:=]\s*([^\r\n,]+)', t, re.IGNORECASE)
        if m2:
            val = m2.group(1).strip()
            if 4 <= len(val) <= 45 and not val.isdigit() and not any(bad in val for bad in ['เลือก', 'แล้ว', 'การวินิจฉัย', 'หัตถการ', 'ตรวจสอบ', 'บริการ']):
                return val

    return None

def get_hosxp_active_user():
    """ ตรวจสอบ Process HOSxP (HOSMy.exe / HOSxP.exe) เพื่อดึงชื่อผู้ใช้งาน/แพทย์ที่กำลังล็อกอิน HOSxP อยู่จริง """
    global _CACHED_LOGIN_USER, _CACHED_PID
    ensure_default_desktop()

    hos_pids = []
    is_main_open = [False]
    main_hwnds = []

    def enum_cb(h, lp):
        if user32.IsWindowVisible(h):
            cls = get_class_name(h)
            t = get_window_text(h)
            if cls == 'TMainForm' or ':: hosxp ::' in t.lower():
                is_main_open[0] = True
                main_hwnds.append(h)

            pid = get_process_id(h)
            if pid and pid not in hos_pids:
                hProc = kernel32.OpenProcess(0x1000, False, pid)
                if hProc:
                    buf = ctypes.create_unicode_buffer(512)
                    sz = wintypes.DWORD(512)
                    if kernel32.QueryFullProcessImageNameW(hProc, 0, buf, ctypes.byref(sz)):
                        val = buf.value.lower()
                        if any(proc in val for proc in ['hosmy.exe', 'hosxp.exe', 'hosxp_pcu.exe']):
                            hos_pids.append(pid)
                    kernel32.CloseHandle(hProc)
        return True

    WNDENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUM(enum_cb), 0)

    # หาก HOSxP ปิดอยู่ หรือไม่ได้อยู่ในหน้าต่างหลัก (เช่น ปิดโปรแกรม หรืออยู่หน้า Login) ให้ล้างแคชและคืนค่า None ทันที
    if not is_main_open[0] or not hos_pids:
        _CACHED_LOGIN_USER = None
        _CACHED_PID = None
        return None

    # 1. สแกนหาชื่อแพทย์/ผู้ใช้งานจาก Memory ของแต่ละ Process (ตรวจจับการเปลี่ยนผู้ใช้แบบ Real-time)
    for pid in hos_pids:
        u = extract_login_user_from_pid(pid)
        if u:
            _CACHED_LOGIN_USER = u
            _CACHED_PID = pid
            return u

    # 2. ตรวจสอบจากข้อความในหน้าต่าง TMainForm หรือ Child Windows (ตรวจจับผู้ใช้ใหม่จากหน้าต่างหลัก)
    for mh in main_hwnds:
        texts = scan_window_hierarchy(mh, visible_only=True)
        u = extract_hosxp_user(texts)
        if u:
            _CACHED_LOGIN_USER = u
            return u

    # Fail closed: a running HOSxP process or a stale cached username is not proof
    # that a named user is currently logged in. Do not activate patient APIs.
    _CACHED_LOGIN_USER = None
    _CACHED_PID = None
    return None

def get_hosxp_live_typing_text():
    """
    ดักจับข้อความที่แพทย์กำลังพิมพ์อยู่ในห้องตรวจ HOSxP (เช่น ช่องการวินิจฉัย, ค้นหาโรค, CC, PE) แบบ Real-time
    เพื่อส่งให้ Sidebar Assistant แนะนำยาสมุนไพรและข้อความ PE ทันที
    """
    ensure_default_desktop()
    found_typing = ""
    try:
        fore_hwnd = user32.GetForegroundWindow()
        if fore_hwnd:
            pid = wintypes.DWORD()
            tid = user32.GetWindowThreadProcessId(fore_hwnd, ctypes.byref(pid))
            if pid.value:
                hProc = kernel32.OpenProcess(0x1000, False, pid.value)
                if hProc:
                    buf = ctypes.create_unicode_buffer(512)
                    sz = wintypes.DWORD(512)
                    if kernel32.QueryFullProcessImageNameW(hProc, 0, buf, ctypes.byref(sz)):
                        val = buf.value.lower()
                        if any(proc in val for proc in ['hosmy.exe', 'hosxp.exe', 'hosxp_pcu.exe']):
                            cur_tid = kernel32.GetCurrentThreadId()
                            user32.AttachThreadInput(cur_tid, tid, True)
                            focus = user32.GetFocus()
                            user32.AttachThreadInput(cur_tid, tid, False)
                            if focus:
                                txt = get_control_text(focus)
                                if txt and len(txt.strip()) >= 2:
                                    # กรองตัวเลขล้วน หรือคำสั่งระบบ
                                    clean = txt.strip()
                                    if not clean.isdigit() and len(clean) <= 100:
                                        found_typing = clean
                    kernel32.CloseHandle(hProc)
    except Exception:
        pass
    return found_typing

def extract_identifiers(texts):
    """ ค้นหา VN (12 หลัก), CID (13 หลัก), HN (7 หลัก) และชื่อคนไข้จากข้อความที่สแกนได้ """
    found_vn = None
    found_cid = None
    found_hn = None
    found_name = None

    for text in texts:
        if not text:
            continue
        t = str(text).strip()

        # 1. ค้นหา VN 12 หลัก (ขึ้นต้นด้วยปี พ.ศ. 6x เช่น 691026060008, 68..., 67...)
        # ต้องไม่ใช่ตัวเลขทศนิยม ป้องกันจับค่าผลแล็บ / BMI / GFR
        if not found_vn and '.' not in t:
            m = re.search(r'(?<![\d\.])(6\d{11})(?![\d\.])', t)
            if m:
                found_vn = m.group(1)
            elif re.search(r'VN[:\s#\-\.]*(\d{12})', t, re.IGNORECASE):
                found_vn = re.search(r'VN[:\s#\-\.]*(\d{12})', t, re.IGNORECASE).group(1)

        # 2. ค้นหา CID 13 หลัก (ต้องไม่มีจุดทศนิยม ป้องกันจับค่า BMI / GFR)
        if not found_cid and '.' not in t:
            m = re.search(r'(?<![\d\.])([1-8]\d{12})(?![\d\.])', t)
            if m:
                found_cid = m.group(1)

        # 3. ค้นหา HN 7 หลัก (เช่น 0083768, 0107155) หรือมีคำว่า HN: กำกับ (ครอบคลุมทั้ง 00... และ 01... ทุกหมวด)
        if not found_hn and '.' not in t:
            m = re.search(r'HN[:\s#\-\.]*(\d{4,9})\b', t, re.IGNORECASE)
            if m:
                found_hn = m.group(1)
            elif re.search(r'(?<![\d\.])(0\d{6})(?![\d\.])', t):
                found_hn = re.search(r'(?<![\d\.])(0\d{6})(?![\d\.])', t).group(1)
            elif re.search(r'(?<![\d\.])(\d{7})(?![\d\.])', t):
                found_hn = re.search(r'(?<![\d\.])(\d{7})(?![\d\.])', t).group(1)

        # 4. ค้นหาชื่อคนไข้ภาษาไทย (ครอบคลุมคำนำหน้าทุกประเภท)
        if not found_name:
            m = re.search(r'((?:นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|พระ|สามเณร|นพ\.|พญ\.|ทพ\.|ทพญ\.|ภก\.|ภญ\.)\s*[\u0E01-\u0E5B]+(?:\s+[\u0E01-\u0E5B]+)+)', t)
            if m:
                found_name = m.group(1)

    return {
        "vn": found_vn,
        "cid": found_cid,
        "hn": found_hn,
        "name": found_name
    }

def scan_window_hierarchy(hwnd, visible_only=True):
    """ สแกนข้อความในหน้าต่างและ Control ลูกทั้งหมด โดยรองรับทั้ง Top-level และ Child Controls ของ Delphi VCL """
    ensure_default_desktop()
    texts = []
    w_title = get_window_text(hwnd)
    if w_title:
        texts.append(w_title)

    def enum_child(child_hwnd, lparam):
        try:
            if not user32.IsWindow(child_hwnd):
                return True
            if visible_only:
                # ข้ามกรณีที่ Control หรือ Parent ถูกซ่อนจริง (เช่น อยู่ในแท็บ/Page ที่ไม่ได้เปิดอยู่) หรือถูก Minimize
                if user32.IsIconic(child_hwnd):
                    return True
                if not user32.IsWindowVisible(child_hwnd):
                    return True

            txt = get_control_text(child_hwnd)
            if txt and len(txt.strip()) > 0:
                texts.append(txt.strip())
        except Exception:
            pass
        return True

    cb_func = WNDENUMPROC(enum_child)
    try:
        user32.EnumChildWindows(hwnd, cb_func, 0)
    except Exception:
        pass
    return texts

def find_mdi_client(h_main):
    """ ค้นหาหน้าต่าง MDIClient ภายใน TMainForm ของ HOSxP """
    mdi_hwnd = [None]
    def enum_mdi(h, lp):
        if get_class_name(h) == "MDIClient":
            mdi_hwnd[0] = h
            return False
        return True
    user32.EnumChildWindows(h_main, WNDENUMPROC(enum_mdi), 0)
    return mdi_hwnd[0]

def resolve_patient_via_server(server_url, query):
    """ ถาม Server API เพื่อดึง VN ล่าสุดของผู้ป่วยจาก HN, CID หรือชื่อ (โดยระบบ API จะให้ความสำคัญกับ Visit วันนี้ CURDATE() เป็นอันดับ 1 เสมอ) """
    if not query or not server_url:
        return None
    try:
        url = f"{server_url}/api/search?q={urllib.parse.quote(str(query).strip())}"
        req = urllib.request.Request(url, headers={"User-Agent": "OPDCompanion/1.0"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode())
            if data.get("success") and data.get("vn"):
                return {
                    "vn": data["vn"],
                    "hn": data.get("patient", {}).get("hn") or (data.get("results") and data["results"][0].get("hn")),
                    "patient_name": data.get("patient", {}).get("patient_name") or (data.get("results") and data["results"][0].get("patient_name"))
                }
    except Exception:
        pass
    return None

def scan_hosxp_patient(server_url="http://localhost:3030"):
    """
    ตรวจจับคนไข้จากหน้าจอ HOSxP ด้วยกลยุทธ์ตาม Z-order ของหน้าต่างจริง:
    1. หน้าต่างคนไข้ที่ลอยอยู่ด้านหน้าสุดของ HOSMy.exe (Active Patient Form / Popup)
       เช่น TDoctorDeskForm (ห้องทำงาน / จุดซักประวัติ / ห้องตรวจ), TOpdScreenForm, TPatientForm ฯลฯ
    2. หน้าต่าง Foreground Window กรณีเปิดเป็น Modal Dialog ชั่วคราว
    3. Active MDI Child Form ภายใน TMainForm (เช่น TOVSTDiagForm หน้าห้องตรวจแพทย์ที่เปิดแบบ MDI)
    4. หน้าต่าง TMainForm (แถบหัวด้านบน หรือคิวคนไข้)
    5. Clipboard
    6. Server Live Sync
    """
    ensure_default_desktop()

    hos_top_windows = []

    def enum_all(h, lp):
        if user32.IsWindowVisible(h) and not user32.IsIconic(h):
            pid = get_process_id(h)
            hProc = kernel32.OpenProcess(0x1000, False, pid)
            if hProc:
                buf = ctypes.create_unicode_buffer(512)
                sz = wintypes.DWORD(512)
                if kernel32.QueryFullProcessImageNameW(hProc, 0, buf, ctypes.byref(sz)):
                    val = buf.value.lower()
                    if any(proc in val for proc in ['hosmy.exe', 'hosxp.exe', 'hosxp_pcu.exe']):
                        cls = get_class_name(h)
                        t = get_window_text(h)
                        if 'doctorassistant' not in cls.lower() and 'doctor assistant' not in t.lower() and 'opdpaperless' not in cls.lower() and 'opd paperless' not in t.lower():
                            hos_top_windows.append((h, cls, t))
                kernel32.CloseHandle(hProc)
        return True

    user32.EnumWindows(WNDENUMPROC(enum_all), 0)

    # ── ลำดับที่ 1: ตรวจสอบหน้าต่าง HOSxP ตามลำดับ Z-Order จริง (หน้าสุดไปหลังสุด) ──
    cached_hos_user = get_hosxp_active_user() or ""

    for h, cls, t in hos_top_windows:
        if cls == 'TMainForm' or ":: hosxp ::" in t.lower():
            # ผู้ใช้กำลังดู/ใช้งาน TMainForm:
            # ตรวจสอบ Active MDI Child Form ก่อน (เช่น TOVSTDiagForm หน้าห้องตรวจแพทย์ หรือ TOpdScreenForm)
            h_mdi = find_mdi_client(h)
            if h_mdi:
                h_active = user32.SendMessageW(h_mdi, WM_MDIGETACTIVE, 0, 0)
                if h_active and user32.IsWindowVisible(h_active) and not user32.IsIconic(h_active):
                    texts = scan_window_hierarchy(h_active, visible_only=True)
                    ids = extract_identifiers(texts)
                    u = cached_hos_user or extract_hosxp_user(texts) or ""
                    if ids["vn"]:
                        return {
                            "vn": ids["vn"],
                            "hn": ids["hn"] or "",
                            "patient_name": ids["name"] or "",
                            "user": u,
                            "source": "hosxp_active_mdi",
                            "title": get_window_text(h_active) or get_class_name(h_active)
                        }
                    if ids["hn"] or ids["cid"] or ids["name"]:
                        resolved = resolve_patient_via_server(server_url, ids["hn"] or ids["cid"] or ids["name"])
                        if resolved and resolved.get("vn"):
                            return {
                                "vn": resolved["vn"],
                                "hn": resolved.get("hn", ids["hn"] or ""),
                                "patient_name": resolved.get("patient_name", ids["name"] or ""),
                                "user": u,
                                "source": "hosxp_active_mdi_resolved",
                                "title": get_window_text(h_active) or get_class_name(h_active)
                            }

            # หากไม่มี Active MDI หรือยังไม่ได้เปิดคนไข้ใน MDI ให้ตรวจดูที่ TMainForm (เช่น ช่องค้นหาคนไข้ด้านบนขวา)
            texts = scan_window_hierarchy(h, visible_only=True)
            ids = extract_identifiers(texts)
            u = cached_hos_user or extract_hosxp_user(texts) or ""
            if ids["vn"]:
                return {
                    "vn": ids["vn"],
                    "hn": ids["hn"] or "",
                    "patient_name": ids["name"] or "",
                    "user": u,
                    "source": "hosxp_main_form",
                    "title": t
                }
            if ids["hn"] or ids["cid"]:
                resolved = resolve_patient_via_server(server_url, ids["hn"] or ids["cid"])
                if resolved and resolved.get("vn"):
                    return {
                        "vn": resolved["vn"],
                        "hn": resolved.get("hn", ids["hn"] or ""),
                        "patient_name": resolved.get("patient_name", ids["name"] or ""),
                        "user": u,
                        "source": "hosxp_main_form_resolved",
                        "title": t
                    }

        elif cls not in ['TApplication']:
            # ผู้ใช้กำลังดู/ใช้งานหน้าต่างลอยด้านหน้า (Active Floating Forms)
            # เช่น TDentalEntryForm (ห้องทันตกรรม), TDoctorDeskForm (ห้องทำงานจุดซักประวัติ/ห้องตรวจ), TOpdScreenForm, TDoctorRoomForm
            texts = scan_window_hierarchy(h, visible_only=True)
            ids = extract_identifiers(texts)
            u = cached_hos_user or extract_hosxp_user(texts) or ""
            friendly_title = get_friendly_title(cls, t)
            if ids["vn"]:
                return {
                    "vn": ids["vn"],
                    "hn": ids["hn"] or "",
                    "patient_name": ids["name"] or "",
                    "user": u,
                    "source": "hosxp_front_form",
                    "title": friendly_title
                }
            if ids["hn"] or ids["cid"] or ids["name"]:
                resolved = resolve_patient_via_server(server_url, ids["hn"] or ids["cid"] or ids["name"])
                if resolved and resolved.get("vn"):
                    return {
                        "vn": resolved["vn"],
                        "hn": resolved.get("hn", ids["hn"] or ""),
                        "patient_name": resolved.get("patient_name", ids["name"] or ""),
                        "user": u,
                        "source": "hosxp_front_form_resolved",
                        "title": friendly_title
                    }

    # ── ลำดับที่ 5: ตรวจจาก Clipboard (Win32 Native 100%) ──
    clip = get_clipboard_text()
    if clip:
        ids = extract_identifiers([clip])
        u = cached_hos_user or ""
        if ids["vn"]:
            return {"vn": ids["vn"], "hn": ids["hn"] or "", "user": u, "source": "clipboard", "title": "Clipboard"}
        if ids["cid"] or ids["hn"]:
            resolved = resolve_patient_via_server(server_url, ids["cid"] or ids["hn"])
            if resolved and resolved.get("vn"):
                return {"vn": resolved["vn"], "hn": resolved.get("hn",""), "user": u, "source": "clipboard_resolved", "title": "Clipboard"}

    # หากไม่พบหน้าต่าง HOSxP หรือไม่มีข้อมูลคนไข้ใน HOSxP/Clipboard ให้ส่งคืน None ทันที
    return None

if __name__ == '__main__':
    res = scan_hosxp_patient()
    print("Scan Result:", res)
