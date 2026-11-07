"""Per-workstation installer for Sidebar Doctor Assistant Companion."""
import json
import os
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk


APP_NAME = "SidebarDoctorAssistant"
APP_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / APP_NAME
COMPANION_NAME = "DoctorAssistantCompanion.exe"
COMPANION_BUILD = "20261107.03"
INSTALLER_BUILD = "20261107.02"


def normalized_server_url(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("กรุณากรอก Server URL เช่น https://assistant.hospital.local หรือ http://localhost:3030")
    hostname = parsed.hostname.lower().strip("[]")
    if parsed.scheme != "https" and hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("การติดตั้งจากเครื่อง workstation ต้องใช้ HTTPS เพื่อปกป้อง activation code และ token")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Server URL ต้องไม่มี username, password, query string หรือ fragment")
    return value


def request_bytes(url: str, timeout: int = 45) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "SidebarDoctorAssistantSetup/1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def error_message(error: Exception) -> str:
    if isinstance(error, urllib.error.HTTPError):
        try:
            payload = json.loads(error.read().decode("utf-8", errors="replace"))
            return str(payload.get("error") or f"Server ตอบกลับ HTTP {error.code}")
        except Exception:
            return f"Server ตอบกลับ HTTP {error.code}"
    if isinstance(error, urllib.error.URLError):
        return f"เชื่อมต่อ Server ไม่สำเร็จ: {error.reason}"
    return str(error)


class SetupWindow:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title(f"ติดตั้ง Sidebar Doctor Assistant Companion · {INSTALLER_BUILD}")
        self.root.geometry("570x480")
        self.root.minsize(500, 440)
        self.root.configure(bg="#f3f7fa")
        self.root.resizable(True, True)

        style = ttk.Style()
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("TFrame", background="#f3f7fa")
        style.configure("Card.TFrame", background="#ffffff")
        style.configure("Title.TLabel", background="#ffffff", foreground="#173247", font=("Segoe UI", 19, "bold"))
        style.configure("Body.TLabel", background="#ffffff", foreground="#607589", font=("Segoe UI", 10))
        style.configure("Field.TLabel", background="#ffffff", foreground="#173247", font=("Segoe UI", 10, "bold"))
        style.configure("TEntry", padding=8)
        style.configure("Install.TButton", padding=(12, 9), font=("Segoe UI", 10, "bold"))

        outer = ttk.Frame(root, padding=22)
        outer.pack(fill="both", expand=True)
        card = ttk.Frame(outer, style="Card.TFrame", padding=25)
        card.pack(fill="both", expand=True)
        ttk.Label(card, text="ติดตั้ง Companion", style="Title.TLabel").pack(anchor="w")
        ttk.Label(card, text="ลงทะเบียนเครื่องนี้กับ Sidebar Doctor Assistant ของโรงพยาบาล", style="Body.TLabel").pack(anchor="w", pady=(5, 20))

        self.server_var = tk.StringVar()
        self.code_var = tk.StringVar()
        self.device_var = tk.StringVar(value=socket.gethostname()[:100])
        self._field(card, "Server URL", self.server_var, "https://assistant.hospital.local หรือ http://localhost:3030")
        self._field(card, "Activation code (ใช้ครั้งเดียว)", self.code_var)
        self._field(card, "ชื่อเครื่อง", self.device_var)

        self.status = tk.StringVar(value="ขอ activation code จากผู้ดูแลระบบ แล้วกรอกภายใน 10 นาที")
        ttk.Label(card, textvariable=self.status, style="Body.TLabel", wraplength=470).pack(anchor="w", pady=(8, 14))
        self.button = ttk.Button(card, text="ลงทะเบียนและติดตั้ง", style="Install.TButton", command=self.start_install)
        self.button.pack(fill="x")
        ttk.Label(card, text=f"Companion build {COMPANION_BUILD} · Installer build {INSTALLER_BUILD} · เก็บ token ในโฟลเดอร์ผู้ใช้เครื่องนี้", style="Body.TLabel").pack(anchor="center", pady=(16, 0))

    def _field(self, parent, label, variable, placeholder=None):
        ttk.Label(parent, text=label, style="Field.TLabel").pack(anchor="w", pady=(0, 5))
        entry = ttk.Entry(parent, textvariable=variable, show="•" if "Activation" in label else "")
        entry.pack(fill="x", pady=(0, 13))
        if placeholder:
            ttk.Label(parent, text=placeholder, style="Body.TLabel").pack(anchor="w", pady=(0, 9))

    def start_install(self):
        try:
            server = normalized_server_url(self.server_var.get())
            code = self.code_var.get().strip()
            device_name = self.device_var.get().strip() or socket.gethostname()
            if len(code) != 16 or any(ch not in "0123456789abcdefABCDEF" for ch in code):
                raise ValueError("Activation code ต้องเป็นตัวอักษร/ตัวเลข 16 ตัว")
            self.button.configure(state="disabled")
            self.status.set("กำลังดาวน์โหลดไฟล์ Companion และลงทะเบียนเครื่อง...")
            threading.Thread(target=self._install, args=(server, code, device_name), daemon=True).start()
        except Exception as exc:
            messagebox.showerror("ข้อมูลไม่ถูกต้อง", str(exc), parent=self.root)

    def _install(self, server, code, device_name):
        try:
            # Download first so a transient download error does not consume the one-time code.
            companion = request_bytes(f"{server}/install/companion.exe")
            if len(companion) < 1024 or not companion.startswith(b"MZ"):
                raise ValueError("ไฟล์ Companion ที่ Server ส่งมาไม่สมบูรณ์ กรุณาติดต่อผู้ดูแลระบบ")
            payload = json.dumps({"code": code, "deviceName": device_name}).encode("utf-8")
            req = urllib.request.Request(
                f"{server}/api/install/enroll", data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "SidebarDoctorAssistantSetup/1"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not result.get("success") or not result.get("token"):
                raise ValueError("Server ไม่ได้ส่งข้อมูลลงทะเบียนกลับมา")

            APP_DIR.mkdir(parents=True, exist_ok=True)
            exe_path = APP_DIR / COMPANION_NAME
            config_path = APP_DIR / "config.json"
            config = {
                "server_url": server,
                "companion_token": result["token"],
                "companion_version": "1",
                "companion_build": COMPANION_BUILD,
                "auto_view": True,
                "open_new_tab": False,
                "always_on_top": True,
                "app_mode": True,
                "widget_x": -1,
                "widget_y": -1,
            }
            with tempfile.NamedTemporaryFile("wb", delete=False, dir=APP_DIR, prefix=".companion-", suffix=".tmp") as temp:
                temp.write(companion)
                temp.flush()
                os.fsync(temp.fileno())
                temp_exe = Path(temp.name)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=APP_DIR, prefix=".config-", suffix=".tmp") as temp:
                json.dump(config, temp, ensure_ascii=False, indent=2)
                temp.write("\n")
                temp.flush()
                os.fsync(temp.fileno())
                temp_config = Path(temp.name)
            os.replace(temp_exe, exe_path)
            os.replace(temp_config, config_path)
            self.root.after(0, self._success, exe_path)
        except Exception as exc:
            self.root.after(0, self._failure, error_message(exc))

    def _success(self, exe_path):
        self.status.set("ลงทะเบียนเครื่องและติดตั้งเรียบร้อยแล้ว")
        self.button.configure(state="normal")
        if messagebox.askyesno("ติดตั้งสำเร็จ", "ลงทะเบียนเครื่องนี้แล้ว ต้องการเปิด Companion ตอนนี้หรือไม่?", parent=self.root):
            try:
                os.startfile(str(exe_path))
                self.root.destroy()
            except Exception as exc:
                messagebox.showerror("เปิด Companion ไม่สำเร็จ", str(exc), parent=self.root)

    def _failure(self, message):
        self.status.set("ติดตั้งไม่สำเร็จ กรุณาตรวจสอบ URL, code และการเชื่อมต่อ")
        self.button.configure(state="normal")
        messagebox.showerror("ติดตั้งไม่สำเร็จ", message, parent=self.root)


if __name__ == "__main__":
    app = tk.Tk()
    SetupWindow(app)
    app.mainloop()
