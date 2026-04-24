# Build & Release Notes

## Development

```bash
npm install
npm run dev       # electron-vite dev + hot reload
```

## Production build (unpacked)

Produces `release/win-unpacked/Noteqad.exe` — directly runnable, portable.

```bash
npm run build        # bundle main/preload/renderer only
npx electron-builder --win --dir   # produce win-unpacked directory
```

Size: ~290 MB unpacked. `better_sqlite3.node` and `mixed.db` are both
unpacked outside `app.asar` at `resources/app.asar.unpacked/`.

## Production build (NSIS installer)

Produces `release/Noteqad-<ver>-setup.exe`.

```bash
npm run build:win
```

### Known issue: winCodeSign symlink error

`electron-builder` pre-downloads a `winCodeSign` tooling bundle that
contains macOS symlinks inside a `.7z` archive. Extracting those
symlinks on Windows requires `SeCreateSymbolicLinkPrivilege`, which is
**not** granted by default.

Symptom:

```
ERROR: Cannot create symbolic link : 使用者沒有獲得此項權限
       darwin/10.12/lib/libcrypto.dylib
```

The Windows binaries we actually need (`signtool.exe`, `rcedit-x64.exe`)
**do** extract successfully, but 7za returns exit code 2 because of the
dylib failures and electron-builder aborts.

### Fix — pick one

1. **Enable Windows Developer Mode** (recommended, one-time):
   - Settings → 系統 → 開發人員 → 開啟「開發人員模式」
   - This grants the symlink privilege to all users.
2. **Run the build terminal as Administrator** (one-time, per session).
3. **Skip the installer** if you only need the portable app:
   `npx electron-builder --win --dir` (ships as a zipped folder instead).

## Native-module rebuild

`better-sqlite3` ships prebuilds for Node but not for Electron's ABI.
The `postinstall` hook handles this automatically; if it ever fails:

```bash
npm run rebuild       # electron-builder install-app-deps
```

## What's in the bundle

| Path | Purpose |
|---|---|
| `out/main/index.js` | Electron main process |
| `out/preload/index.js` | contextBridge API surface |
| `out/renderer/*` | React UI |
| `resources/app.asar.unpacked/resources/mixed.db` | 98,569-row exam answer bank |
| `resources/app.asar.unpacked/node_modules/better-sqlite3/` | Native bindings (must be on disk, not asar-packed) |

## User-data layout (set by first run)

Lives at `%APPDATA%/Noteqad/` on Windows.

| File | Contents |
|---|---|
| `credentials.bin` | DPAPI-encrypted eCPA account + password (if user opted in) |
| `config.json` | `{ geminiApiKey, stealthSecret }` (plaintext, user's explicit choice for stealth) |
| `run-state.json` | Last pipeline cids + status for resume-after-crash |
