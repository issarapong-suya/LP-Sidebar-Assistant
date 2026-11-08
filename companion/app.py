# Doctor Assistant Companion — ไอคอนพี่หมอสำหรับ Sidebar Doctor Assistant
# 100% True 32-bit Transparent Layered Window (Win32 API)
import os
import sys
import json
import time
import socket
import ctypes
from ctypes import wintypes
import threading
import webbrowser
import subprocess
import shutil
import urllib.error
import urllib.parse
import urllib.request
import numpy as np
from PIL import Image, ImageEnhance, ImageDraw

# ตัวสแกน HOSxP
from hosxp_scanner import scan_hosxp_patient, ensure_default_desktop, get_hosxp_active_user, get_hosxp_login_dept, get_hosxp_live_typing_text

if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
    EXE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    EXE_DIR = BASE_DIR

CONFIG_FILE = os.path.join(EXE_DIR, "config.json")
ICON_PATH = os.path.join(BASE_DIR, "doctor_icon.png")
INSTALL_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "SidebarDoctorAssistant")
INSTALLED_EXE = os.path.join(INSTALL_DIR, "DoctorAssistantCompanion.exe")

COMPANION_VERSION = "1"
COMPANION_BUILD = "20261108.03"

# ค่าเริ่มต้น (ไม่เก็บรหัสผ่านเป็น plain text ใน config.json เพื่อความปลอดภัยสูงสุด)
DEFAULT_CONFIG = {
    "server_url": "http://localhost:3030",
    "auto_view": True,
    "open_new_tab": False,
    "always_on_top": True,
    "app_mode": True,
    "widget_x": -1,
    "widget_y": -1,
    "companion_version": COMPANION_VERSION,
    "companion_build": COMPANION_BUILD,
    "companion_token": "",
}

def server_url_from_download(exe_path=None):
    """Read the originating server URL from Windows' download zone metadata."""
    exe_path = exe_path or sys.executable
    try:
        with open(f"{exe_path}:Zone.Identifier", "r", encoding="utf-8", errors="ignore") as stream:
            for line in stream:
                key, _, value = line.partition("=")
                if key.strip().lower() not in ("hosturl", "referrerurl"):
                    continue
                parsed = urllib.parse.urlparse(value.strip())
                if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
                    continue
                return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", "")).rstrip("/")
    except (OSError, ValueError):
        pass
    return ""

def enrollment_ticket_from_download(exe_path=None):
    """Read the one-time install ticket embedded in the download request URL."""
    exe_path = exe_path or sys.executable
    try:
        with open(f"{exe_path}:Zone.Identifier", "r", encoding="utf-8", errors="ignore") as stream:
            for line in stream:
                key, _, value = line.partition("=")
                if key.strip().lower() not in ("hosturl", "referrerurl"):
                    continue
                parsed = urllib.parse.urlparse(value.strip())
                ticket = urllib.parse.parse_qs(parsed.query).get("ticket", [""])[0]
                if len(ticket) == 32 and all(ch in "0123456789abcdefABCDEF" for ch in ticket):
                    return ticket.lower()
    except (OSError, ValueError):
        pass
    return ""

def get_windows_special_folder(csidl):
    """ ค้นหาโฟลเดอร์ระบบของ Windows (เช่น Desktop จริง แม้จะถูก Redirect ไป OneDrive) """
    try:
        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, buf)
        return buf.value
    except Exception:
        return ""

def ensure_shortcuts(target_exe):
    """สร้างทางลัดบน Desktop และ Startup folder ของ Windows เพื่อให้เปิดอัตโนมัติเมื่อเปิดเครื่อง"""
    try:
        work_dir = os.path.dirname(target_exe)
        desktop_dir = get_windows_special_folder(0) or os.path.join(os.environ.get("USERPROFILE", os.path.expanduser("~")), "Desktop")
        startup_dir = get_windows_special_folder(7) or os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs\Startup")
        
        shortcuts = [
            os.path.join(desktop_dir, "Doctor Assistant.lnk"),
            os.path.join(startup_dir, "Doctor Assistant.lnk")
        ]
        
        CREATE_NO_WINDOW = 0x08000000
        for lnk in shortcuts:
            try:
                target_dir = os.path.dirname(lnk)
                if not os.path.exists(target_dir):
                    continue
                ps_cmd = (
                    f"$ws = New-Object -ComObject WScript.Shell; "
                    f"$s = $ws.CreateShortcut('{lnk}'); "
                    f"$s.TargetPath = '{target_exe}'; "
                    f"$s.WorkingDirectory = '{work_dir}'; "
                    f"$s.Description = 'Sidebar Doctor Assistant Companion'; "
                    f"$s.Save()"
                )
                subprocess.run(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_cmd],
                               capture_output=True, timeout=8, creationflags=CREATE_NO_WINDOW)
            except Exception:
                pass
    except Exception as e:
        print(f"[Companion] Shortcut creation notice: {e}")

def install_companion_copy():
    """Move the downloaded single-file app into the current user's app folder and configure it."""
    if not getattr(sys, "frozen", False):
        return True
    try:
        source = os.path.abspath(sys.executable)
        destination = os.path.abspath(INSTALLED_EXE)
        if os.path.normcase(source) == os.path.normcase(destination):
            ensure_shortcuts(destination)
            return True

        # ปิดกระบวนการ Companion เดิมที่กำลังเปิดอยู่ เพื่อปลดล็อกไฟล์ก่อนอัปเดต
        ensure_single_instance_restart()
        time.sleep(0.3)

        os.makedirs(INSTALL_DIR, exist_ok=True)
        destination_config = os.path.join(INSTALL_DIR, "config.json")
        new_server = server_url_from_download(source)
        new_ticket = enrollment_ticket_from_download(source)

        if os.path.exists(destination_config):
            try:
                with open(destination_config, "r", encoding="utf-8") as stream:
                    cfg = json.load(stream)
            except Exception:
                cfg = DEFAULT_CONFIG.copy()
            if new_server:
                cfg["server_url"] = new_server
            if new_ticket:
                cfg["install_ticket"] = new_ticket
                cfg["companion_token"] = ""
            with open(destination_config, "w", encoding="utf-8") as stream:
                json.dump(cfg, stream, indent=2, ensure_ascii=False)
        else:
            if os.path.isfile(CONFIG_FILE):
                shutil.copy2(CONFIG_FILE, destination_config)
            else:
                initial_config = DEFAULT_CONFIG.copy()
                initial_config["server_url"] = new_server or initial_config["server_url"]
                initial_config["install_ticket"] = new_ticket
                with open(destination_config, "w", encoding="utf-8") as stream:
                    json.dump(initial_config, stream, indent=2, ensure_ascii=False)

        temp_exe = destination + ".new"
        shutil.copy2(source, temp_exe)
        try:
            os.replace(temp_exe, destination)
        except PermissionError:
            ensure_single_instance_restart()
            time.sleep(0.6)
            os.replace(temp_exe, destination)

        ensure_shortcuts(destination)
        subprocess.Popen([destination], cwd=INSTALL_DIR, close_fds=True, creationflags=0x08000000)
        return False
    except Exception as error:
        print(f"[Companion] Could not install to user profile: {type(error).__name__} ({error})")
        return True

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                # ลบ admin_password ออกจาก config ทันทีหากมีค้างอยู่
                cfg.pop("admin_password", None)
                res = {**DEFAULT_CONFIG, **cfg}
                if "app_mode" not in cfg:
                    res["app_mode"] = True
                if "always_on_top" not in cfg:
                    res["always_on_top"] = True
                return res
        except Exception:
            pass
    return DEFAULT_CONFIG.copy()

def save_config(cfg):
    try:
        cfg_to_save = cfg.copy()
        # ซ่อนและป้องกันไม่ให้บันทึกรหัสผ่านเป็น plain text
        cfg_to_save.pop("admin_password", None)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg_to_save, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print("Save config error:", e)

# ─── Win32 API Definitions ──────────────────────────────────────────
kernel32 = ctypes.windll.kernel32
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# Constants
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080

ULW_ALPHA = 0x00000002
AC_SRC_OVER = 0x00
AC_SRC_ALPHA = 0x01

WM_DESTROY = 0x0002
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B
WM_LBUTTONDBLCLK = 0x0203
WM_COMMAND = 0x0111
WM_SETCURSOR = 0x0020
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
CS_DBLCLKS = 0x0008
IDC_HAND = 32649
MF_STRING = 0x0000
MF_SEPARATOR = 0x0800
MF_CHECKED = 0x0008
MF_UNCHECKED = 0x0000
TPM_RIGHTBUTTON = 0x0002
TPM_RETURNCMD = 0x0100
SWP_NOSIZE = 0x0001
SWP_NOZORDER = 0x0004
SWP_SHOWWINDOW = 0x0040

# Structures
POINT = wintypes.POINT
SIZE = wintypes.SIZE

class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [
        ('BlendOp', ctypes.c_byte),
        ('BlendFlags', ctypes.c_byte),
        ('SourceConstantAlpha', ctypes.c_byte),
        ('AlphaFormat', ctypes.c_byte)
    ]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD),
        ('biWidth', wintypes.LONG),
        ('biHeight', wintypes.LONG),
        ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD),
        ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD),
        ('biXPelsPerMeter', wintypes.LONG),
        ('biYPelsPerMeter', wintypes.LONG),
        ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD)
    ]

WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ('cbSize', wintypes.UINT),
        ('style', wintypes.UINT),
        ('lpfnWndProc', WNDPROC),
        ('cbClsExtra', ctypes.c_int),
        ('cbWndExtra', ctypes.c_int),
        ('hInstance', wintypes.HINSTANCE),
        ('hIcon', wintypes.HICON),
        ('hCursor', wintypes.HICON),
        ('hbrBackground', wintypes.HBRUSH),
        ('lpszMenuName', wintypes.LPCWSTR),
        ('lpszClassName', wintypes.LPCWSTR),
        ('hIconSm', wintypes.HICON)
    ]

class MSG(ctypes.Structure):
    _fields_ = [
        ('hwnd', wintypes.HWND),
        ('message', wintypes.UINT),
        ('wParam', wintypes.WPARAM),
        ('lParam', wintypes.LPARAM),
        ('time', wintypes.DWORD),
        ('pt', POINT)
    ]

class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('lpReserved', wintypes.LPWSTR),
        ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR),
        ('dwX', wintypes.DWORD),
        ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD),
        ('dwYSize', wintypes.DWORD),
        ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD),
        ('dwFillAttribute', wintypes.DWORD),
        ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD),
        ('cbReserved2', wintypes.WORD),
        ('lpReserved2', ctypes.c_void_p),
        ('hStdInput', wintypes.HANDLE),
        ('hStdOutput', wintypes.HANDLE),
        ('hStdError', wintypes.HANDLE),
    ]

class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', wintypes.HANDLE),
        ('hThread', wintypes.HANDLE),
        ('dwProcessId', wintypes.DWORD),
        ('dwThreadId', wintypes.DWORD),
    ]

# Setup API signatures
user32.UpdateLayeredWindow.argtypes = [
    wintypes.HWND, wintypes.HDC, ctypes.POINTER(POINT), ctypes.POINTER(SIZE),
    wintypes.HDC, ctypes.POINTER(POINT), wintypes.COLORREF, ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD
]
user32.UpdateLayeredWindow.restype = wintypes.BOOL

user32.DefWindowProcW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
]
user32.DefWindowProcW.restype = wintypes.LPARAM

user32.SendMessageW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
]
user32.SendMessageW.restype = wintypes.LPARAM

user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.SetCursor.argtypes = [wintypes.HICON]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int

# ── 64-bit Menu APIs Signatures (Fix Context Menu on x64) ──
user32.CreatePopupMenu.restype = wintypes.HMENU
user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, wintypes.WPARAM, wintypes.LPCWSTR]
user32.AppendMenuW.restype = wintypes.BOOL
user32.DestroyMenu.argtypes = [wintypes.HMENU]
user32.DestroyMenu.restype = wintypes.BOOL
user32.TrackPopupMenuEx.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.HWND, ctypes.c_void_p]
user32.TrackPopupMenuEx.restype = wintypes.UINT
user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
# ── Additional Win32 APIs for Browser Window Management ──
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int

user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int

user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL

user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def find_browser_executable():
    """ ค้นหา path ของ Google Chrome หรือ Microsoft Edge เพื่อเปิดในโหมด App Window ไร้ URL Bar """
    import winreg
    # 1. ค้นหาผ่าน Windows Registry App Paths (HKLM และ HKCU)
    for root in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
        for name in ["chrome.exe", "msedge.exe", "brave.exe"]:
            try:
                key = winreg.OpenKey(root, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}")
                val, _ = winreg.QueryValueEx(key, "")
                winreg.CloseKey(key)
                if val and os.path.isfile(val):
                    return val
            except Exception:
                pass

    # 2. Fallback ค้นหาจากโฟลเดอร์ติดตั้งมาตรฐาน
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"), r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), r"Microsoft\Edge\Application\msedge.exe"),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None

def launch_browser_on_desktop(url, app_mode=True, monitor_bounds=None, maximize=True, profile_name="DoctorAssistantProfile"):
    """
    เปิดหน้าต่างเบราว์เซอร์บน Interactive Desktop (WinSta0\\Default) ของแพทย์ 100%
    ใช้ Win32 CreateProcessW พร้อมระบุ lpDesktop = 'WinSta0\\Default'
    และแยก Dedicated Profile เพื่อป้องกันปัญหา Chrome Background Process ขัดขวางหน้าต่างใหม่
    """
    try:
        ensure_default_desktop()
    except Exception:
        pass

    browser_exe = find_browser_executable()
    profile_dir = os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Temp'), profile_name)
    try:
        os.makedirs(profile_dir, exist_ok=True)
    except Exception:
        pass

    if monitor_bounds:
        pos_args = f" --window-position={monitor_bounds['left']},{monitor_bounds['top']} --window-size={monitor_bounds['width']},{monitor_bounds['height']}"
    elif maximize:
        pos_args = " --window-position=0,0"
    else:
        pos_args = ""

    max_arg = " --start-maximized" if maximize else ""
    # The Sidebar must be able to sound patient-change/alert tones without a prior page click.
    autoplay_arg = " --autoplay-policy=no-user-gesture-required"
    sw_mode = 3 if maximize else 1  # 3 = SW_SHOWMAXIMIZED, 1 = SW_SHOWNORMAL

    if browser_exe and os.path.isfile(browser_exe):
        if app_mode:
            cmd_line = f'"{browser_exe}" --user-data-dir="{profile_dir}"{autoplay_arg} --app="{url}"{max_arg}{pos_args}'
        else:
            cmd_line = f'"{browser_exe}" --user-data-dir="{profile_dir}"{autoplay_arg}{max_arg}{pos_args} "{url}"'

        si = STARTUPINFOW()
        si.cb = ctypes.sizeof(STARTUPINFOW)
        si.lpDesktop = "WinSta0\\Default"
        si.dwFlags = 0x00000001 # STARTF_USESHOWWINDOW
        si.wShowWindow = sw_mode
        pi = PROCESS_INFORMATION()

        created = kernel32.CreateProcessW(
            None,
            cmd_line,
            None,
            None,
            False,
            0,
            None,
            None,
            ctypes.byref(si),
            ctypes.byref(pi)
        )
        if created:
            kernel32.CloseHandle(pi.hProcess)
            kernel32.CloseHandle(pi.hThread)
            print(f"[Companion v{COMPANION_VERSION}] Launched browser on WinSta0\\Default (PID={pi.dwProcessId}): {url}")
            return True

    # Fallback 1: ShellExecuteW บน Windows Explorer
    try:
        shell32 = ctypes.windll.shell32
        res = shell32.ShellExecuteW(None, "open", str(url), None, None, sw_mode)
        if res > 32:
            print(f"[Companion v{COMPANION_VERSION}] Launched browser via ShellExecuteW: {url}")
            return True
    except Exception:
        pass

    # Fallback 2: os.startfile / webbrowser
    try:
        os.startfile(url)
        return True
    except Exception:
        pass

    try:
        import webbrowser
        webbrowser.open(url)
        return True
    except Exception:
        pass

    return False

def bring_window_to_foreground(hwnd, maximize=True):
    """ บังคับนำหน้าต่างขึ้นมาข้างหน้าและขยายขนาดเต็มหน้าจอ (Maximize) ผ่าน Win32 ShowWindow """
    try:
        ensure_default_desktop()
        SW_MAXIMIZE = 3
        SW_RESTORE = 9
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        if maximize:
            screen_w = user32.GetSystemMetrics(0)
            screen_h = user32.GetSystemMetrics(1)
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetWindowPos(hwnd, 0, 0, 0, screen_w, screen_h - 40, 0x0040)
            user32.ShowWindow(hwnd, SW_MAXIMIZE)
        else:
            user32.ShowWindow(hwnd, SW_RESTORE)
        # จำลองการกดปุ่ม Alt เพื่อข้ามข้อจำกัดของ Windows ที่ป้องกัน background app ขโมย focus
        user32.keybd_event(0x12, 0, 0, 0) # VK_MENU (Alt) DOWN
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.keybd_event(0x12, 0, 2, 0) # VK_MENU (Alt) UP
        return True
    except Exception:
        return False

def focus_existing_assistant(bounds=None):
    """ ค้นหาหน้าต่าง Sidebar Doctor Assistant และดึงขึ้นมาข้างหน้า พร้อมปรับขนาดตำแหน่งตาม bounds """
    assistant_hwnd = [None]
    def enum_cb(hwnd, lparam):
        if user32.IsWindowVisible(hwnd):
            cls_buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls_buf, 256)
            cls_name = cls_buf.value
            if cls_name in ["Chrome_WidgetWin_1", "MozillaWindowClass", "ApplicationFrameWindow"]:
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buff = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buff, length + 1)
                    title = buff.value
                    if "Doctor Assistant" in title or "ผู้ช่วยแพทย์" in title:
                        assistant_hwnd[0] = hwnd
        return True
    cb = WNDENUMPROC(enum_cb)
    user32.EnumWindows(cb, 0)
    if assistant_hwnd[0]:
        h = assistant_hwnd[0]
        try:
            # คืนสถานะถ้าถูกย่อ (Un-minimize)
            if user32.IsIconic(h):
                user32.ShowWindow(h, 9) # SW_RESTORE
            else:
                user32.ShowWindow(h, 5) # SW_SHOW
            if bounds:
                user32.SetWindowPos(h, 0, bounds['left'], bounds['top'], bounds['width'], bounds['height'], 0x0040)
            # เด้งมาอยู่บนสุดเหนือหน้าต่างโปรแกรมอื่นทันที แล้วปลดกลับให้อยู่ระดับปกติ
            user32.SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040) # HWND_TOPMOST
            user32.SetWindowPos(h, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040) # HWND_NOTOPMOST
        except Exception:
            pass
        return bring_window_to_foreground(h, maximize=False)
    return False

user32.DestroyMenu.argtypes = [wintypes.HMENU]
user32.DestroyWindow.argtypes = [wintypes.HWND]

user32.CreatePopupMenu.restype = wintypes.HMENU
user32.AppendMenuW.argtypes = [
    wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR
]
user32.AppendMenuW.restype = wintypes.BOOL

user32.TrackPopupMenuEx.argtypes = [
    wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.HWND, ctypes.c_void_p
]
user32.TrackPopupMenuEx.restype = ctypes.c_int

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
TOPMOST_FLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW

user32.SetWindowPos.argtypes = [
    wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT
]
user32.SetWindowPos.restype = wintypes.BOOL


def get_local_lan_ip(target_host=None):
    """ ดึงหมายเลข IP การ์ดเครือข่าย LAN/Wi-Fi จริงของเครื่องลูก """
    candidates = []
    if target_host:
        candidates.append(target_host)
    # Use the configured server route when available, otherwise the public
    # route probe. Avoid embedding any hospital-specific private subnet here.
    candidates.append("8.8.8.8")
    for h in candidates:
        try:
            import socket
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.3)
            s.connect((h, 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127."):
                return ip
        except Exception:
            pass
    try:
        import socket
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"


def ensure_single_instance_restart():
    """ เมื่อเปิดโปรแกรมซ้ำ ให้ปิดตัวเดิมที่กำลังทำงานอยู่ แล้วรันตัวใหม่แทน (Auto-Restart) ป้องกันไอคอนซ้ำซ้อน """
    try:
        current_pid = os.getpid()
        parent_pid = os.getppid()
        my_pids = {current_pid, parent_pid}

        # 1. ค้นหาหน้าต่าง Widget เดิมด้วย Window Class "DoctorAssistantChibiWidget"
        prev_hwnd = user32.FindWindowW("DoctorAssistantChibiWidget", None)
        while prev_hwnd:
            lpdwProcessId = wintypes.DWORD()
            user32.GetWindowThreadProcessId(prev_hwnd, ctypes.byref(lpdwProcessId))
            old_pid = lpdwProcessId.value
            if old_pid and old_pid not in my_pids:
                user32.PostMessageW(prev_hwnd, WM_DESTROY, 0, 0)
                hProc = kernel32.OpenProcess(0x0001, False, old_pid)  # PROCESS_TERMINATE = 0x0001
                if hProc:
                    kernel32.TerminateProcess(hProc, 0)
                    kernel32.CloseHandle(hProc)
            time.sleep(0.05)
            next_hwnd = user32.FindWindowW("DoctorAssistantChibiWidget", None)
            if next_hwnd == prev_hwnd or not next_hwnd:
                break
            prev_hwnd = next_hwnd

        # 2. ตรวจสอบค้นหา Process ชื่อเดียวกัน (DoctorAssistantCompanion.exe)
        exe_name = os.path.basename(sys.executable).lower()
        if getattr(sys, 'frozen', False) or 'opdpaperless' in exe_name:
            TH32CS_SNAPPROCESS = 0x00000002
            class PROCESSENTRY32W(ctypes.Structure):
                _fields_ = [
                    ('dwSize', wintypes.DWORD),
                    ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD),
                    ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', wintypes.DWORD),
                    ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD),
                    ('pcPriClassBase', ctypes.c_long),
                    ('dwFlags', wintypes.DWORD),
                    ('szExeFile', ctypes.c_wchar * 260)
                ]
            hSnapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            if hSnapshot and hSnapshot != ctypes.c_void_p(-1).value:
                pe = PROCESSENTRY32W()
                pe.dwSize = ctypes.sizeof(PROCESSENTRY32W)
                if kernel32.Process32FirstW(hSnapshot, ctypes.byref(pe)):
                    while True:
                        if (pe.szExeFile.lower() == exe_name or 'doctorassistantcompanion' in pe.szExeFile.lower()) and pe.th32ProcessID not in my_pids:
                            hProc = kernel32.OpenProcess(0x0001, False, pe.th32ProcessID)
                            if hProc:
                                kernel32.TerminateProcess(hProc, 0)
                                kernel32.CloseHandle(hProc)
                        if not kernel32.Process32NextW(hSnapshot, ctypes.byref(pe)):
                            break
                kernel32.CloseHandle(hSnapshot)
        time.sleep(0.1)
    except Exception as e:
        print("ensure_single_instance_restart error:", e)


# ─── Floating Doctor Companion App ──────────────────────────────────
class FloatingDoctorApp:
    def __init__(self):
        ensure_default_desktop()
        self.config = load_config()
        self.last_vn = None
        self.last_user = None
        self.running = True
        self.size = 72  # ขนาดไอคอนคมชัด 72x72 พิกเซล
        self.hwnd = None

        # โหลดภาพไอคอน Chibi Doctor คมชัด พร้อมขอบโปร่งใส 100%
        self.base_image = self.load_chibi_image()

        # สร้างหน้าต่าง Layered Window
        self.create_layered_window()

        # ลงทะเบียน token ประจำเครื่องโดยอัตโนมัติเมื่อเป็นการติดตั้งครั้งแรก
        self.enrollment_thread = threading.Thread(target=self.register_with_server, daemon=True)
        self.enrollment_thread.start()

        # เริ่มต้น Thread ตรึง Always-on-Top ลอยอยู่เหนือทุกโปรแกรมตลอดเวลา
        self.topmost_thread = threading.Thread(target=self.always_on_top_worker, daemon=True)
        self.topmost_thread.start()

        # เริ่มต้น Thread ตรวจจับ Auto View ในพื้นหลัง
        self.auto_thread = threading.Thread(target=self.auto_view_worker, daemon=True)
        self.auto_thread.start()
    def enforce_always_on_top(self):
        """ บังคับให้ไอคอนอยู่บนสุดของทุกหน้าต่าง (Always-on-Top) ตามการตั้งค่า """
        try:
            if self.hwnd:
                is_topmost = self.config.get("always_on_top", True)
                target_hwnd = HWND_TOPMOST if is_topmost else HWND_NOTOPMOST
                user32.SetWindowPos(self.hwnd, target_hwnd, 0, 0, 0, 0, TOPMOST_FLAGS)
        except Exception:
            pass

    def always_on_top_worker(self):
        """ คอยตรวจและตรึงไอคอนให้อยู่บนสุดทุก 1.0 วินาที หากเปิดใช้งาน Always on Top """
        while self.running:
            time.sleep(1.0)
            if self.config.get("always_on_top", True):
                self.enforce_always_on_top()

    def load_chibi_image(self):
        """ โหลดและปรับภาพให้คมชัด ขอบโปร่งใสแบบสมบูรณ์ """
        # ค้นหาภาพไอคอน Chibi Doctor จากทุกตำแหน่งที่อาจอยู่
        candidates = [
            ICON_PATH,
            os.path.join(EXE_DIR, "doctor_icon.png"),
            os.path.join(EXE_DIR, "Chibi Doctor Eco Health Emblem.png"),
            os.path.join(os.path.dirname(EXE_DIR), "Chibi Doctor Eco Health Emblem.png")
        ]
        img_file = None
        for p in candidates:
            if os.path.exists(p):
                img_file = p
                break

        if os.path.exists(img_file):
            try:
                im = Image.open(img_file).convert("RGBA")
                bbox = im.getbbox()
                if bbox:
                    im = im.crop(bbox)
                
                # ทำเป็นรูปจัตุรัสแบบมีขอบหายใจนิดหน่อย
                w, h = im.size
                max_dim = int(max(w, h) * 1.04)
                square = Image.new("RGBA", (max_dim, max_dim), (0, 0, 0, 0))
                square.paste(im, ((max_dim - w) // 2, (max_dim - h) // 2))

                # ย่อขนาดแบบ LANCZOS + เร่งความคมชัด (Sharpness) เล็กน้อย
                thumb = square.resize((self.size, self.size), Image.Resampling.LANCZOS)
                thumb = ImageEnhance.Sharpness(thumb).enhance(1.25)
                return thumb
            except Exception as e:
                print("Error loading chibi doctor image:", e)

        # Fallback สร้างภาพวงกลมสีเขียวถ้าไม่พบรูป
        im = Image.new("RGBA", (self.size, self.size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(im)
        draw.ellipse([4, 4, self.size - 4, self.size - 4], fill=(16, 185, 129, 255), outline=(255, 255, 255, 255), width=2)
        return im

    def render_bgra_buffer(self):
        """ แปลงภาพ RGBA เป็น 32-bit Pre-multiplied BGRA สำหรับ Windows Layered Window """
        img = self.base_image.copy()

        # ถ้าเปิด Auto View ให้แสดงจุดเขียวมรกตเรืองแสงตรงมุมขวาบน
        if self.config.get("auto_view"):
            draw = ImageDraw.Draw(img)
            badge_r = 5
            bx, by = self.size - 10, 10
            # วงขอบขาว
            draw.ellipse([bx - badge_r - 1, by - badge_r - 1, bx + badge_r + 1, by + badge_r + 1], fill=(255, 255, 255, 255))
            # วงสีเขียว
            draw.ellipse([bx - badge_r, by - badge_r, bx + badge_r, by + badge_r], fill=(16, 185, 129, 255))

        arr = np.array(img)
        alpha = arr[:, :, 3:4].astype(np.float32) / 255.0
        # Pre-multiply RGB with Alpha
        rgb = (arr[:, :, 0:3].astype(np.float32) * alpha).astype(np.uint8)
        # Windows DIB format: Blue, Green, Red, Alpha
        bgra = np.dstack([rgb[:, :, 2], rgb[:, :, 1], rgb[:, :, 0], arr[:, :, 3]]).copy(order='C')
        return bgra

    def update_window_surface(self):
        """ อัปเดตพื้นผิวภาพหน้าต่างแบบโปร่งใส 100% (Subpixel Alpha Blending) """
        if not self.hwnd:
            return

        bgra = self.render_bgra_buffer()
        bmi = BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth = self.size
        bmi.biHeight = -self.size  # Top-down DIB
        bmi.biPlanes = 1
        bmi.biBitCount = 32
        bmi.biCompression = 0

        pBits = ctypes.c_void_p()
        hdcScreen = user32.GetDC(0)
        hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
        hBitmap = gdi32.CreateDIBSection(hdcMem, ctypes.byref(bmi), 0, ctypes.byref(pBits), None, 0)
        ctypes.memmove(pBits, bgra.ctypes.data, bgra.nbytes)
        oldBmp = gdi32.SelectObject(hdcMem, hBitmap)

        blend = BLENDFUNCTION(BlendOp=AC_SRC_OVER, BlendFlags=0, SourceConstantAlpha=255, AlphaFormat=AC_SRC_ALPHA)
        ptSrc = POINT(0, 0)
        wSize = SIZE(self.size, self.size)

        user32.UpdateLayeredWindow(
            self.hwnd, hdcScreen, None, ctypes.byref(wSize),
            hdcMem, ctypes.byref(ptSrc), 0, ctypes.byref(blend), ULW_ALPHA
        )

        # คืน Memory DC
        gdi32.SelectObject(hdcMem, oldBmp)
        gdi32.DeleteObject(hBitmap)
        gdi32.DeleteDC(hdcMem)
        user32.ReleaseDC(0, hdcScreen)

    def wnd_proc(self, hwnd, msg, wparam, lparam):
        if msg == WM_LBUTTONDOWN:
            # บันทึกพิกัดก่อนเริ่มลาก
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            self.drag_start_x = rect.left
            self.drag_start_y = rect.top
            self.drag_start_time = time.time()

            # เริ่มต้นการลากหน้าต่างแบบ Native Windows
            user32.ReleaseCapture()
            user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)

            # เมื่อลากเสร็จสิ้น ตรวจสอบว่าพิกัดเปลี่ยนหรือไม่
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            dx = abs(rect.left - self.drag_start_x)
            dy = abs(rect.top - self.drag_start_y)
            elapsed = time.time() - self.drag_start_time

            if (dx > 10 or dy > 10) and elapsed > 0.25:
                # มีการเคลื่อนย้ายตำแหน่งอย่างตั้งใจ -> บันทึกตำแหน่งใหม่
                self.config["widget_x"] = rect.left
                self.config["widget_y"] = rect.top
                save_config(self.config)
            else:
                # เป็นการคลิก (หรือคลิกพร้อมขยับเมาส์เล็กน้อย) -> เปิดหน้าเว็บคนไข้ทันที (ค่าเริ่มต้น: Sidebar Doctor Assistant)
                threading.Thread(target=self.open_sidebar_assistant, daemon=True).start()
            self.enforce_always_on_top()
            return 0

        elif msg == WM_LBUTTONDBLCLK:
            threading.Thread(target=self.open_sidebar_assistant, daemon=True).start()
            self.enforce_always_on_top()
            return 0

        elif msg == WM_RBUTTONDOWN:
            return 0

        elif msg == WM_RBUTTONUP:
            self.show_context_menu()
            return 0

        elif msg == WM_CONTEXTMENU:
            return 0

        elif msg == WM_SETCURSOR:
            self.enforce_always_on_top()
            hCursor = user32.LoadCursorW(None, IDC_HAND)
            user32.SetCursor(hCursor)
            return 1

        elif msg == WM_COMMAND:
            cmd_id = wparam & 0xFFFF
            self.handle_menu_command(cmd_id)
            return 0

        elif msg == WM_DESTROY:
            self.running = False
            user32.PostQuitMessage(0)
            return 0

        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def create_layered_window(self):
        """ ลงทะเบียนและสร้าง Native Windows Layered Window """
        hInst = kernel32.GetModuleHandleW(None)
        self.wndproc_cb = WNDPROC(self.wnd_proc)

        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.style = CS_DBLCLKS
        wc.lpfnWndProc = self.wndproc_cb
        wc.hInstance = hInst
        wc.lpszClassName = "DoctorAssistantChibiWidget"
        wc.hCursor = user32.LoadCursorW(None, IDC_HAND)
        user32.RegisterClassExW(ctypes.byref(wc))

        # คำนวณพิกัดเริ่มต้น
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)

        init_x = self.config.get("widget_x", -1)
        init_y = self.config.get("widget_y", -1)

        if init_x <= 0 or init_x > screen_w - 70:
            init_x = screen_w - 110
        if init_y <= 0 or init_y > screen_h - 70:
            init_y = screen_h - 190

        # สร้างหน้าต่างแบบโปร่งใส ไม่มีขอบ
        is_top = self.config.get("always_on_top", True)
        ex_style = WS_EX_LAYERED | WS_EX_TOOLWINDOW
        if is_top:
            ex_style |= WS_EX_TOPMOST
        style = WS_POPUP | WS_VISIBLE

        self.hwnd = user32.CreateWindowExW(
            ex_style,
            "DoctorAssistantChibiWidget",
            "Doctor Assistant Companion",
            style,
            init_x, init_y, self.size, self.size,
            None, None, hInst, None
        )

        self.enforce_always_on_top()
        # แสดงภาพโปร่งใสทันที
        self.update_window_surface()

    def show_context_menu(self):
        """ เมนูคลิกขวาแบบ Native Windows (รองรับภาษาไทยคมชัด 100%) """
        try:
            pt = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(pt))

            hMenu = user32.CreatePopupMenu()
            if not hMenu:
                return

            user32.AppendMenuW(hMenu, MF_STRING | 0x00000001, 999, f"📌 OPD Companion v{COMPANION_VERSION} · {COMPANION_BUILD}") # MF_GRAYED
            user32.AppendMenuW(hMenu, MF_SEPARATOR, 0, "")

            user32.AppendMenuW(hMenu, MF_STRING, 111, "🩺 เปิดผู้ช่วยแพทย์ (Sidebar Doctor Assistant) [ค่าเริ่มต้น]")

            user32.AppendMenuW(hMenu, MF_SEPARATOR, 0, "")

            auto_state = MF_CHECKED if self.config.get("auto_view", True) else MF_UNCHECKED
            user32.AppendMenuW(hMenu, MF_STRING | auto_state, 102, "ตรวจจับคนไข้อัตโนมัติ (Auto View)")

            app_state = MF_CHECKED if self.config.get("app_mode", True) else MF_UNCHECKED
            user32.AppendMenuW(hMenu, MF_STRING | app_state, 108, "เปิดแบบไม่แสดงแถบ URL (App Mode)")

            tab_state = MF_CHECKED if self.config.get("open_new_tab", False) else MF_UNCHECKED
            user32.AppendMenuW(hMenu, MF_STRING | tab_state, 106, "เปิดแท็บใหม่เสมอสำหรับคนไข้ใหม่")

            topmost_state = MF_CHECKED if self.config.get("always_on_top", True) else MF_UNCHECKED
            user32.AppendMenuW(hMenu, MF_STRING | topmost_state, 107, "แสดงอยู่ด้านบนเสมอ (Always on Top)")

            user32.AppendMenuW(hMenu, MF_SEPARATOR, 0, "")
            user32.AppendMenuW(hMenu, MF_STRING, 104, "ตั้งค่า Server URL (Admin)...")
            user32.AppendMenuW(hMenu, MF_SEPARATOR, 0, "")
            user32.AppendMenuW(hMenu, MF_STRING, 105, "ปิดโปรแกรมไอคอนพี่หมอ")

            user32.SetForegroundWindow(self.hwnd)
            cmd = user32.TrackPopupMenuEx(hMenu, 0x0100, pt.x, pt.y, self.hwnd, None) # TPM_RETURNCMD = 0x0100
            user32.DestroyMenu(hMenu)
            user32.PostMessageW(self.hwnd, 0, 0, 0)

            if cmd:
                print(f"[Companion v{COMPANION_VERSION}] Context menu triggered command: {cmd}")
                self.handle_menu_command(cmd)
        except Exception as e:
            print("show_context_menu error:", e)

    def handle_menu_command(self, cmd_id):
        print(f"[Companion v{COMPANION_VERSION}] Executing menu command {cmd_id}")
        if cmd_id == 111:
            threading.Thread(target=self.open_sidebar_assistant, daemon=True).start()
        elif cmd_id == 102:
            self.toggle_auto_view()
        elif cmd_id == 104:
            threading.Thread(target=self.prompt_server_url, daemon=True).start()
        elif cmd_id == 106:
            self.config["open_new_tab"] = not self.config.get("open_new_tab", False)
            save_config(self.config)
        elif cmd_id == 107:
            # สลับสถานะแสดงอยู่ด้านบนเสมอ (Always on Top)
            is_top = not self.config.get("always_on_top", True)
            self.config["always_on_top"] = is_top
            save_config(self.config)
            self.enforce_always_on_top()
        elif cmd_id == 108:
            # สลับสถานะ App Mode (เปิดแบบไม่แสดง URL)
            self.config["app_mode"] = not self.config.get("app_mode", True)
            save_config(self.config)
        elif cmd_id == 105:
            # ปิดโปรแกรมไอคอนพี่หมอทันทีแบบสะอาด ไม่ค้าง
            print(f"[Companion v{COMPANION_VERSION}] Shutting down companion app immediately...")
            self.running = False
            user32.PostQuitMessage(0)
            os._exit(0)

    def toggle_auto_view(self):
        self.config["auto_view"] = not self.config.get("auto_view")
        save_config(self.config)
        self.update_window_surface()

    def notify_server_patient(self, vn, hn="", user="", trigger="poll", click_id=None, live_diag=""):
        """ ส่งข้อมูลคนไข้และชื่อแพทย์ HOSxP ไปยัง Server เพื่อ Live Sync รีเฟรชหน้าเว็บเดิมทันที """
        try:
            import urllib.request
            import urllib.parse
            import socket
            server_url = self.config.get("server_url", "http://localhost:3030")
            comp = socket.gethostname() or os.environ.get("COMPUTERNAME", "Client-PC")
            server_host = urllib.parse.urlparse(server_url).hostname
            lan_ip = get_local_lan_ip(server_host)
            payload = {
                "computer": comp,
                "ip": lan_ip,
                "vn": vn,
                "hn": hn,
                "user": user,
                "session_active": bool(user and user.strip()),
                "companion_version": COMPANION_VERSION,
                "companion_build": COMPANION_BUILD,
                "trigger": trigger,
                "live_diag": live_diag
            }
            if click_id:
                payload["click_id"] = click_id
            data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(
                f"{server_url}/api/notify-patient",
                data=data,
                headers={"Content-Type": "application/json", "X-Companion-Token": self.config.get("companion_token", "")}
            )
            with urllib.request.urlopen(req, timeout=1.0) as response:
                if response.status != 200:
                    print(f"[Companion] Heartbeat was not accepted: HTTP {response.status}")
        except urllib.error.HTTPError as error:
            print(f"[Companion] Heartbeat was rejected: HTTP {error.code}")
        except Exception as error:
            print(f"[Companion] Heartbeat could not reach server: {type(error).__name__}")

    def needs_device_enrollment(self):
        tok = str(self.config.get("companion_token", "")).strip()
        # หากไม่มี token หรือเป็น token เก่าระดับ shared ให้ลงทะเบียนเพื่อรับ token เฉพาะเครื่อง
        return not tok or tok == "60d1dfc3f900dfe319dd04363883f91f5c3d1fb7a1b080047e5437c061b2fdf0"

    def register_with_server(self):
        """Enroll this workstation without asking the user to copy an activation code."""
        while self.running and self.needs_device_enrollment():
            try:
                server_url = str(self.config.get("server_url", "")).rstrip("/")
                if not server_url:
                    time.sleep(5)
                    continue

                ticket = str(self.config.get("install_ticket", "")).strip()
                # กรณี localhost หากไม่มี ticket ให้ขอ ticket อัตโนมัติเพื่อความสะดวกในการทดสอบ
                if not ticket and ("localhost" in server_url or "127.0.0.1" in server_url):
                    try:
                        req_t = urllib.request.Request(
                            f"{server_url}/api/install/ticket",
                            data=b"{}",
                            headers={"Content-Type": "application/json", "User-Agent": "SidebarDoctorAssistantCompanion/1"},
                            method="POST",
                        )
                        with urllib.request.urlopen(req_t, timeout=5) as r_t:
                            t_data = json.loads(r_t.read().decode("utf-8"))
                            if t_data.get("success") and t_data.get("ticket"):
                                ticket = t_data["ticket"]
                                self.config["install_ticket"] = ticket
                                save_config(self.config)
                    except Exception as ex:
                        print(f"[Companion] Auto-ticket request error: {ex}")

                if not ticket:
                    time.sleep(10)
                    continue

                payload = json.dumps({
                    "ticket": ticket,
                    "deviceName": socket.gethostname() or os.environ.get("COMPUTERNAME", "HOSxP workstation")
                }).encode("utf-8")
                request = urllib.request.Request(
                    f"{server_url}/api/install/enroll",
                    data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": "SidebarDoctorAssistantCompanion/1"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=8) as response:
                    result = json.loads(response.read().decode("utf-8"))
                token = str(result.get("token") or "")
                if result.get("success") and len(token) == 64:
                    self.config["companion_token"] = token
                    self.config.pop("install_ticket", None)
                    save_config(self.config)
                    print(f"[Companion v{COMPANION_VERSION}] Workstation registered with Sidebar server")
                    return
                raise ValueError("Server did not return a device credential")
            except urllib.error.HTTPError as error:
                print(f"[Companion] Workstation enrollment rejected: HTTP {error.code}")
                time.sleep(15)
            except Exception as error:
                print(f"[Companion] Workstation enrollment unavailable: {type(error).__name__}")
                time.sleep(15)

    def ensure_server_running(self):
        """ ตรวจสอบและเปิด Server อัตโนมัติหากยังไม่ได้เปิด (กรณี localhost) """
        server_url = self.config.get("server_url", "http://localhost:3030")
        if "localhost" in server_url or "127.0.0.1" in server_url:
            try:
                import urllib.request
                req = urllib.request.Request(f"{server_url}/health", headers={"User-Agent": "OPDCompanion/1.0"})
                with urllib.request.urlopen(req, timeout=0.8) as resp:
                    if resp.status == 200:
                        return
            except Exception:
                pass
            
            # Server ไม่ทำงาน -> เปิด node server.js ในพื้นหลังอัตโนมัติ
            try:
                import subprocess
                candidates = [
                    os.path.join(os.path.dirname(EXE_DIR), "server"),
                    os.path.join(EXE_DIR, "server"),
                    os.path.join(EXE_DIR, "..", "server")
                ]
                for s_dir in candidates:
                    s_js = os.path.join(s_dir, "server.js")
                    if os.path.exists(s_js):
                        subprocess.Popen(
                            ["node", "server.js"],
                            cwd=s_dir,
                            creationflags=0x08000000  # CREATE_NO_WINDOW
                        )
                        time.sleep(1.2)
                        break
            except Exception as e:
                print("Auto-start server error:", e)

    def open_sidebar_assistant(self):
        """ สแกน HOSxP และเปิด Sidebar Doctor Assistant (เกาะขอบขวา 380px) ผ่านไอคอนพี่หมอทันที (ไม่ต้องมี Script บน HOSxP) """
        try:
            self.ensure_server_running()
            server_url = self.config.get("server_url", "http://localhost:3030")
            patient = scan_hosxp_patient(server_url)
            hosxp_user = ""
            if patient and patient.get("user"):
                hosxp_user = patient.get("user")
            else:
                hosxp_user = get_hosxp_active_user() or ""

            vn = patient.get("vn") if patient else None
            hn = patient.get("hn", "") if patient else ""

            screen_w = user32.GetSystemMetrics(0)
            screen_h = user32.GetSystemMetrics(1)
            sidebar_w = 550
            pos_x = max(0, screen_w - sidebar_w)
            bounds = {
                "left": pos_x,
                "top": 0,
                "width": sidebar_w,
                "height": screen_h - 40
            }

            # Keep workstation identity and patient identifiers out of the browser URL/history.
            assistant_url = f"{server_url}/assistant/"
            if vn:
                self.notify_server_patient(vn, hn, user=hosxp_user, trigger="click")

            if focus_existing_assistant(bounds):
                return

            launch_browser_on_desktop(assistant_url, app_mode=True, monitor_bounds=bounds, maximize=False, profile_name="DoctorSidebarProfile")
        except Exception as e:
            print("open_sidebar_assistant error:", e)

    def prompt_server_url(self):
        """ตั้งค่า URL ของ Server สำหรับ Sidebar Doctor Assistant"""
        try:
            curr = self.config.get("server_url", "http://localhost:3030")
            new_url = self.native_input_box(
                "ระบุ Server URL ของ Sidebar Doctor Assistant:\n(เช่น http://192.168.1.10:3030)",
                "ตั้งค่า Server URL",
                curr
            )
            if new_url and new_url.strip():
                new_clean = new_url.strip().rstrip('/')
                self.config["server_url"] = new_clean
                save_config(self.config)
                self.native_message_box(
                    f"บันทึกการตั้งค่าเรียบร้อยแล้ว!\nServer URL ปัจจุบัน: {new_clean}",
                    "บันทึกสำเร็จ",
                    "Information"
                )
        except Exception as e:
            print("Config dialog error:", e)
    def native_input_box(self, prompt, title, default=""):
        """ หน้าต่างกรอก Server URL แบบ Modern Windows 11 Fluent UI Always-on-Top """
        try:
            p_esc = prompt.replace("'", "''")
            t_esc = title.replace("'", "''")
            d_esc = default.replace("'", "''")
            script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = '{t_esc}'
$form.Size = New-Object System.Drawing.Size(480, 310)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)

# Modern Green Header Bar
$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point(0, 0)
$header.Size = New-Object System.Drawing.Size(480, 56)
$header.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#F0FDF4')
$form.Controls.Add($header)

$divider = New-Object System.Windows.Forms.Panel
$divider.Location = New-Object System.Drawing.Point(0, 55)
$divider.Size = New-Object System.Drawing.Size(480, 1)
$divider.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#BBF7D0')
$form.Controls.Add($divider)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = 'ตั้งค่าที่อยู่เซิร์ฟเวอร์ (Server URL Configuration)'
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#166534')
$titleLabel.Location = New-Object System.Drawing.Point(22, 16)
$titleLabel.AutoSize = $true
$header.Controls.Add($titleLabel)

$subLabel = New-Object System.Windows.Forms.Label
$subLabel.Text = '{p_esc}'
$subLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$subLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#334155')
$subLabel.Location = New-Object System.Drawing.Point(22, 68)
$subLabel.Size = New-Object System.Drawing.Size(430, 48)
$form.Controls.Add($subLabel)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Text = '{d_esc}'
$txt.Font = New-Object System.Drawing.Font('Segoe UI', 10.5)
$txt.Location = New-Object System.Drawing.Point(22, 122)
$txt.Size = New-Object System.Drawing.Size(420, 28)
$form.Controls.Add($txt)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Text = 'ตัวอย่าง: http://192.168.1.10:3030 หรือ http://localhost:3030'
$hintLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$hintLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#64748B')
$hintLabel.Location = New-Object System.Drawing.Point(22, 158)
$hintLabel.Size = New-Object System.Drawing.Size(420, 22)
$form.Controls.Add($hintLabel)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = 'บันทึกการตั้งค่า'
$btnOk.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
$btnOk.ForeColor = [System.Drawing.Color]::White
$btnOk.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#059669')
$btnOk.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnOk.FlatAppearance.BorderSize = 0
$btnOk.Location = New-Object System.Drawing.Point(205, 198)
$btnOk.Size = New-Object System.Drawing.Size(125, 36)
$btnOk.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnOk)
$form.AcceptButton = $btnOk

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = 'ยกเลิก'
$btnCancel.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$btnCancel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#475569')
$btnCancel.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#F1F5F9')
$btnCancel.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnCancel.FlatAppearance.BorderSize = 0
$btnCancel.Location = New-Object System.Drawing.Point(340, 198)
$btnCancel.Size = New-Object System.Drawing.Size(102, 36)
$btnCancel.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel

$form.Add_Shown({{$form.Activate(); $form.BringToFront(); $txt.Focus(); $txt.SelectAll()}})

if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $txt.Text
}}
"""
            cmd = ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60, creationflags=0x08000000)
            return res.stdout.strip()
        except Exception as e:
            print("native_input_box error:", e)
            return ""

    def native_message_box(self, message, title, icon="Information"):
        """ แสดง Message Box แจ้งเตือนแบบ Modern Card Always-on-Top """
        try:
            m_esc = message.replace("'", "''")
            t_esc = title.replace("'", "''")
            btn_color = "#DC2626" if icon == "Warning" else "#2563EB"
            script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = '{t_esc}'
$form.Size = New-Object System.Drawing.Size(430, 215)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)

$msgLabel = New-Object System.Windows.Forms.Label
$msgLabel.Text = '{m_esc}'
$msgLabel.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$msgLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#0F172A')
$msgLabel.Location = New-Object System.Drawing.Point(26, 26)
$msgLabel.Size = New-Object System.Drawing.Size(370, 75)
$form.Controls.Add($msgLabel)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = 'ตกลง'
$btnOk.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
$btnOk.ForeColor = [System.Drawing.Color]::White
$btnOk.BackColor = [System.Drawing.ColorTranslator]::FromHtml('{btn_color}')
$btnOk.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnOk.FlatAppearance.BorderSize = 0
$btnOk.Location = New-Object System.Drawing.Point(290, 118)
$btnOk.Size = New-Object System.Drawing.Size(106, 36)
$btnOk.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnOk)
$form.AcceptButton = $btnOk

$form.Add_Shown({{$form.Activate(); $form.BringToFront(); $btnOk.Focus()}})

$form.ShowDialog()
"""
            cmd = ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script]
            subprocess.run(cmd, capture_output=True, text=True, timeout=30, creationflags=0x08000000)
        except Exception:
            pass

    def auto_view_worker(self):
        """ ตรวจจับสถานะล็อกอิน, การเปลี่ยนผู้ใช้ และคนไข้ใหม่ใน HOSxP ในพื้นหลังแบบ Real-time """
        last_heartbeat = 0
        detection_state = None
        while self.running:
            time.sleep(1.5)

            try:
                server_url = self.config.get("server_url", "http://localhost:3030")
                curr_user = get_hosxp_active_user() or ""
                now = time.time()
                current_detection_state = bool(curr_user)
                if current_detection_state != detection_state:
                    print("[Companion] HOSxP session detected." if current_detection_state else "[Companion] No verified HOSxP session; waiting.")
                    detection_state = current_detection_state

                # ตรวจจับการเปลี่ยนแปลงผู้ใช้งาน HOSxP (เช่น ปิดโปรแกรม HOSxP จน curr_user กลายเป็นว่าง หรือสลับชื่อหมอคนใหม่)
                prev_user = getattr(self, "last_user", None)
                user_changed = (curr_user != prev_user)

                patient = None
                new_vn = ""
                hn = ""
                if curr_user and self.config.get("auto_view"):
                    patient = scan_hosxp_patient(server_url)
                    new_vn = (patient and patient.get("vn")) or ""
                    hn = (patient and patient.get("hn")) or ""

                vn_changed = (new_vn != self.last_vn)

                # ดักจับข้อความที่แพทย์กำลังพิมพ์สดใน HOSxP (เช่น ช่องการวินิจฉัย, ค้นหาโรค, CC, PE)
                live_text = ""
                if curr_user:
                    try:
                        live_text = get_hosxp_live_typing_text() or ""
                    except Exception:
                        pass
                last_live = getattr(self, "last_live_text", "")
                if vn_changed:
                    # เปลี่ยนคนไข้ใหม่ ให้รีเซ็ตข้อความพิมพ์ของคนเดิม
                    self.last_live_text = ""
                    last_live = ""

                live_changed = bool(live_text != last_live)

                # ส่งข้อมูล Sync ไปยัง Server ทันทีเมื่อ:
                # 1. ผู้ใช้งาน HOSxP เปลี่ยนแปลง (เปลี่ยนหมอ หรือ ปิด HOSxP)
                # 2. คนไข้ใน HOSxP เปลี่ยนแปลง
                # 3. ข้อความที่กำลังพิมพ์เปลี่ยนแปลง (Live Typing / Live Diagnosis)
                # 4. Heartbeat ปกติทุก 5.0 วินาที เพื่อยืนยันว่า HOSxP ยังเปิดใช้งานอยู่
                if user_changed or vn_changed or live_changed or (now - last_heartbeat > 5.0):
                    self.last_vn = new_vn if curr_user else None
                    self.last_user = curr_user
                    self.last_live_text = live_text
                    last_heartbeat = now
                    trigger = "typing_change" if live_changed else ("user_change" if user_changed else ("patient_change" if vn_changed else "poll"))
                    self.notify_server_patient(self.last_vn or "", hn if curr_user else "", user=curr_user, trigger=trigger, live_diag=live_text)

                    # หากเลือกคนไข้ใหม่บน HOSxP ให้ sidebar หน้าต่างเดิมเด้งมาแสดง top บนโปรแกรมที่เปิดอยู่ทันที
                    if vn_changed and self.last_vn:
                        try:
                            focus_existing_assistant()
                        except Exception:
                            pass
            except Exception as error:
                print(f"[Companion] HOSxP monitor error: {type(error).__name__}")

    def run(self):
        msg = MSG()
        while self.running:
            bRet = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if bRet == 0 or bRet == -1:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

if __name__ == '__main__':
    if not install_companion_copy():
        sys.exit(0)
    ensure_default_desktop()
    # ป้องกันการเปิดโปรแกรมซ้ำซ้อน หากเปิดซ้ำให้รีสตาร์ตปิดตัวเก่าแล้วรันตัวใหม่ทันที
    ensure_single_instance_restart()

    # ปรับ DPI Awareness เพื่อให้คมชัดสูงสุดบนทุกจอภาพ (High-DPI)
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

    app = FloatingDoctorApp()
    app.run()
