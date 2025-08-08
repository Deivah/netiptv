# NetIPTV – Windows 11 (.exe)

Detta är ett komplett projekt för att bygga din Netflix‑liknande IPTV‑spelare till en Windows‑installer.

## Snabbstart (Windows 11)

1. Installera **Node.js LTS** (https://nodejs.org/)
2. Öppna PowerShell i projektmappen och kör:
   ```powershell
   npm install
   npm run dev
   ```
   -> Vite dev + Electron startar (testa att klistra in din M3U/EPG).

3. Bygg `.exe` installer:
   ```powershell
   npm run dist
   ```
   -> Installer skapas i `dist/` (NSIS Setup).

## Notiser

- Vissa strömmar kräver specifika headers (referer/cookie). Du kan injicera dem i `electron/main.js` via `webRequest`.
- DRM‑flöden stöds inte av hls.js.
- EPG-formatet ska vara **XMLTV** (`.xml`/`.xmltv`).

Lycka till!
