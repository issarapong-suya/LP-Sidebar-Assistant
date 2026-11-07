# Sidebar Doctor Assistant

Standalone product for the Sidebar Doctor Assistant and the HOSxP doctor icon. It is designed to run on each hospital's own server. The original Rea HOSxi system remains separate and unchanged.

## Product contents

Product version: **1** · Sidebar/server build: **20261107.14** · Companion build: **20261107.06**.

- `server/`: Express server, HOSxP read-only connection, Assistant API and setup wizard.
- `server/public/assistant/`: Sidebar UI.
- `server/public/setup/`: first-run and configuration wizard.
- `companion/`: Windows doctor icon and HOSxP screen scanner.

This product does not include OPD Card viewing, PDF storage, or OPD Card writing.

## Install the hospital server

1. Install Node.js **22.5 or newer** and copy this `doctor-assistant` folder to the hospital server (`node:sqlite` is used for the local audit database).
2. Open PowerShell in `server/` and run `npm install`.
3. Run `npm start` and open `http://localhost:3030/setup` on the server itself.
4. Enter the hospital identity, HOSxP database connection and allowed client network prefixes. Use a database account granted only `SELECT` on the required HOSxP tables.
5. Setup is a full-width, responsive wizard. Begin with **ทดสอบฐานข้อมูล**; later steps unlock only after it passes. The grant check allows `SELECT` on other schemas too, but rejects write privileges, `GRANT OPTION`, and unverified role grants. Setup checks SELECT access to core tables and never attempts a write. Saving writes `server/config.json`; keep this file readable only by the service/IT account.
6. Open `http://<server-ip>:3030/assistant/` from a workstation on an allowed network. For Companion enrollment, open `http://<server-ip>:3030/install/`.

The Setup page can also store hospital-specific Lab item codes for LDL, Hct, Platelet and UACR. Enter one or more codes separated by commas. Leave a field blank to use the built-in name matching for that Lab.

The setup page is available only from the server's loopback interface. If the configured port changes, the service moves to the new port after saving. Keep the server process running under the hospital's normal service supervisor.

## Install the doctor icon

1. From an allowed hospital workstation, open `https://<server>/install/` (remote enrollment requires HTTPS).
2. Download Companion, then open it from the browser's downloads list or Downloads folder. Browsers require the user to open downloaded programs; a webpage cannot launch an EXE directly.
3. Companion reads the Server URL and a hidden, one-time install ticket from Windows download metadata, copies itself to `%LOCALAPPDATA%\SidebarDoctorAssistant\`, and registers the workstation automatically. No URL or code is shown or typed by the user. The internal per-device token is generated and stored without being shown.
4. IT can view enrolled workstations and revoke one from **จัดการ Companion**. Legacy installs using the shared Companion token continue to work until migrated.

Build the versioned Companion release on Windows with Python and PyInstaller installed by running `companion/build-companion-release.bat`. Include `companion/dist/DoctorAssistantCompanion_v1_build20261107.04.exe` in the server deployment package or `/install/` will return 404. The build uses a separate output path so it does not overwrite an older Companion that may still be running. Generated EXEs are excluded from Git.

The one-time install ticket is valid for 30 minutes, bound to the downloading workstation's IP, and consumed on first enrollment. The per-device token is a bearer credential stored in the Windows user's LocalAppData and authorizes that workstation to report HOSxP session state. It is managed in the background; limit access to the Windows account and do not copy its `config.json`. The scanner reads the active patient and logged-in user from the HOSxP window/process and sends session and visit updates to this server; it does not write to HOSxP. HOSxP V3 status bars ending with `, ใบลา` are supported by Companion build `20261107.04`.

The companion image and its Windows application icon are sourced from `AI Doctor Assistant Icon Badge.png`. Restart the companion after replacing the image; rebuild a packaged EXE to update the icon embedded in that EXE. The Sidebar browser favicon is served from `server/public/favicon.ico`.

### Sound alerts

When launched by the Companion, the Sidebar opens in its own Chromium profile with autoplay enabled, so alert sounds work automatically. Sound is on by default; click the speaker button to mute or unmute it. If the Sidebar is opened directly in a regular browser, that browser may still require a user interaction or autoplay permission.

## HOSxP compatibility

The first standalone release uses the common HOSxP V3 table names (`ovst`, `patient`, `opdscreen`, `vn_stat`, `lab_head`, `lab_order`, `lab_items`, `opitemrece`, `drugitems`, `drugusage`, `ovstdiag`, and `oapp`). The Setup page exposes the Creatinine lab code. Other local schema differences can be added as Setup mappings as deployments are evaluated.

The database account needs SELECT permission for the tables and columns used by the enabled Assistant features, including `opduser` for manual login. If a local HOSxP schema differs, the API returns a generic configuration error and logs the technical detail on the server.

If the Setup grant check fails, expand **รายละเอียดบัญชีและสิทธิ์ที่ฐานข้อมูลตอบกลับ**. It shows the MariaDB account actually matched for this connection (`CURRENT_USER()`), the client identity (`USER()`), active role when supported, and `SHOW GRANTS`. A username can have different grants for different host matches or through global grants/roles; the DBA should correct the account shown there.

## Security and data

- Patient APIs require an allowed network address and either a recent Companion heartbeat or an active HOSxP manual-login session. Manual login is available when HOSxP is closed; as soon as a fresh Companion heartbeat is detected, the manual session is revoked and the Sidebar switches to the HOSxP user and selected patient.
- The scanner detects a username from the HOSxP client process/window. It does not validate the HOSxP password against a hospital identity provider, and a site-specific source is still required to prove Admin/IT roles for Setup. Until that integration is done, Setup is loopback-only and should be used by authorized IT staff on the server.
- Manual login checks `opduser.loginname` and compares `LOWER(passweb)` with `LOWER(MD5(submitted password))` inside MariaDB using a parameterized query. The stored hash is never selected or returned. This was chosen after the site reported a 32-hex `passweb` value and still needs validation against the hospital’s actual HOSxP login behavior. Sessions use an HttpOnly, SameSite cookie, expire after 30 minutes idle or 8 hours absolute, and are held in memory. Five failed attempts from one IP trigger a 15-minute lockout. Remote login requires HTTPS; localhost testing can use HTTP.
- Current Companion token transport follows `server_url`; deploy it only on a protected hospital LAN during this development stage. Before production on shared/untrusted networks, terminate HTTPS at a hospital-managed reverse proxy and configure the Companion to use that HTTPS URL. A same-host proxy should bind its upstream to loopback, set `X-Forwarded-Proto`/`X-Forwarded-For` from the actual connection, and must not publish `/setup/` or `/setup/audit/` to workstations.
- Audit events are stored in `server/data/audit.sqlite` (SQLite WAL), with an append-only `server/data/audit-fallback.jsonl` used if SQLite is unavailable. Patient references are HMAC pseudonyms, rather than raw HN/VN. Normal HTTP access logs omit URL paths and query strings to avoid logging patient identifiers. The hospital must restrict file access, define retention/backup and approve the policy text before clinical deployment.
- Local IT staff can review these events at `http://localhost:3030/setup/audit/`. The page reads both SQLite and JSONL, supports date/action/user filters and pagination, and does not display raw HN/VN. Access uses the same loopback-only restriction as Setup; it is not yet tied to an HOSxP Admin/IT role provider.
- The privacy modal is a draft template requiring hospital-specific DPO/legal review and completion of the contact, retention and effective-date fields.
- This product reads HOSxP data and does not store OPD documents. No external AI service is called in this release.

## Configuration files

- `server/config.example.json`: example server configuration. The Setup page creates the actual `server/config.json`.
- `companion/config.example.json`: example workstation icon configuration.

