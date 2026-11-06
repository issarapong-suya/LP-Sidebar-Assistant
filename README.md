# Sidebar Doctor Assistant

Standalone product for the Sidebar Doctor Assistant and the HOSxP doctor icon. It is designed to run on each hospital's own server. The original Rea HOSxi system remains separate and unchanged.

## Product contents

- `server/`: Express server, HOSxP read-only connection, Assistant API and setup wizard.
- `server/public/assistant/`: Sidebar UI.
- `server/public/setup/`: first-run and configuration wizard.
- `companion/`: Windows doctor icon and HOSxP screen scanner.

This product does not include OPD Card viewing, PDF storage, or OPD Card writing.

## Install the hospital server

1. Install a supported Node.js LTS release and copy this `doctor-assistant` folder to the hospital server.
2. Open PowerShell in `server/` and run `npm install`.
3. Run `npm start` and open `http://localhost:3030/setup` on the server itself.
4. Enter the hospital identity, HOSxP database connection and allowed client network prefixes. Use a database account with read-only access to the required HOSxP tables.
5. Use **ทดสอบฐานข้อมูล** before saving. Saving writes `server/config.json`; the database password stays on the server. Restrict filesystem permissions on this file to the service account and administrators.
6. Open `http://<server-ip>:3030/assistant/` from a workstation on an allowed network.

The setup page is available only from the server's loopback interface. If the configured port changes, the service moves to the new port after saving. Keep the server process running under the hospital's normal service supervisor.

## Install the doctor icon

On a Windows HOSxP workstation, install Python and the packages in `companion/requirements.txt`, then copy `config.example.json` to `config.json` and set `server_url` to the hospital server URL. Start the icon with `run-companion.bat`.

For a packaged Windows build, use PyInstaller from this folder and include `doctor_icon.png` as a data file. The scanner reads the active patient from the HOSxP window and sends visit updates to this server; it does not write to HOSxP.

## HOSxP compatibility

The first standalone release uses the common HOSxP V3 table names (`ovst`, `patient`, `opdscreen`, `vn_stat`, `lab_head`, `lab_order`, `lab_items`, `opitemrece`, `drugitems`, `drugusage`, `ovstdiag`, and `oapp`). The Setup page exposes the Creatinine lab code. Other local schema differences can be added as Setup mappings as deployments are evaluated.

The database account needs SELECT permission for the tables and columns used by the enabled Assistant features. If a local HOSxP schema differs, the API returns a generic configuration error and logs the technical detail on the server.

## Security and data

- API requests are restricted by the configured LAN prefixes or an API key.
- Setup is loopback-only.
- Patient query and visit access events are appended to `server/data/access.jsonl`.
- This product reads HOSxP data and does not store OPD documents or patient data in its own database.

## Configuration files

- `server/config.example.json`: example server configuration. The Setup page creates the actual `server/config.json`.
- `companion/config.example.json`: example workstation icon configuration.

