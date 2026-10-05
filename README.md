# scsh

Share your screen with anyone, or control another computer, using a one-time access code.
It works like Chrome Remote Desktop: the person sharing reads out a 9-digit code, the
other person types it in, and once the sharer clicks **Allow** they can see and control the screen.

## Download

Get the latest version from the **[Releases page](https://github.com/nithishreddy27/remote-desktop/releases/latest)**:

| Platform | File |
| --- | --- |
| Windows 10/11 | `scsh-Setup-x.y.z.exe` |
| macOS (Apple Silicon) | `scsh-x.y.z-arm64.dmg` |
| Linux | `scsh-x.y.z-x86_64.AppImage` |

The app isn't code-signed yet, so your system will warn you the first time:
- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
- **macOS:** right-click the app → **Open** → **Open**. To share your screen, also allow
  *Screen Recording* and *Accessibility* in System Settings → Privacy & Security.
- **Linux:** `chmod +x scsh-*.AppImage` and run it.

Windows and Linux builds update themselves automatically.

## How to use it

**Let someone into your computer:** click **Generate code** and tell them the code.
When they connect you'll be asked to **Allow** or **Deny**. While they're connected you
can turn off *Allow mouse and keyboard control*, or disconnect them, at any time.

**Connect to someone else's computer:** enter your name and their code, then click **Connect**.
In a session:
- *Control* switches your mouse and keyboard on or off (view only).
- *Send keys* sends shortcuts your own computer would otherwise catch (Win, Alt+Tab, …).
- *Full screen*, or **Ctrl+Alt+Enter**, toggles full screen. Move the mouse to the top edge to bring the toolbar back.

The toolbar shows resolution, fps, bitrate, latency, and whether the connection is
`Direct` (peer-to-peer) or `Relayed` (through the TURN relay).

**Good to know:**
- On Windows, the viewer can't control windows that run as administrator (Task Manager,
  installers, admin terminals). If control seems to freeze, click a normal window on the
  shared computer, or run scsh as administrator there.
- Ctrl+Alt+Del and UAC prompts appear on Windows' secure desktop, which ordinary apps can't see or control.
- One viewer at a time. No audio, clipboard sync or file transfer yet.

## Privacy and security

- Your screen and your input travel directly between the two computers, encrypted
  end to end by WebRTC (DTLS-SRTP). When a direct connection isn't possible, they pass
  through Cloudflare's TURN relay, still encrypted.
- The signaling server only sees the access code, the viewer's display name and the connection handshake.
- Codes are random, single use, and expire after 10 minutes. Every connection needs the
  host's explicit approval, and repeated wrong guesses are blocked per IP address.

---

## How it works

```
┌──────────── Host ────────────┐                         ┌─────────── Viewer ───────────┐
│ desktopCapturer → video track│ ══ WebRTC (P2P, DTLS) ══▶ <video> (fit to window)       │
│ input.js ← data channel      │ ◀═ mouse / keyboard ═══ │ captures mouse, wheel, keys  │
└──────────────┬───────────────┘                         └──────────────┬───────────────┘
               │      WebSocket: code, accept/deny, SDP/ICE, TURN creds │
               └──────────────────▶  server/ (signaling)  ◀─────────────┘
```

- **`server/`** is a small Node WebSocket server. It issues codes, asks the host to approve
  each viewer, relays the WebRTC handshake, and hands each session short-lived Cloudflare
  TURN credentials. It also limits failed joins and connections per IP.
- **`app/`** is one Electron app that acts as both host and viewer.
  - The screen is captured at native resolution and tuned for sharp text
    (`contentHint: detail`, maintain-resolution, configurable bitrate and fps).
  - Input goes over an ordered WebRTC data channel, with mouse positions normalized to 0..1.
  - **Windows hosts** inject input with `SendInput`/`SetCursorPos` (via `koffi`), using
    hardware scancodes. This gives correct keys on any layout and correct positioning on any monitor or DPI.
  - **macOS/Linux hosts** use `libnut`. Cmd and Ctrl are swapped when a Mac controls a PC, or the reverse.

## Development

```bash
cd server && npm install && npm start      # ws://localhost:8080
cd app && npm install && npm start         # npm run dev also opens DevTools
```

Run two copies of the app to test on one machine. To test across a LAN, start the server
on one computer, allow TCP 8080 through its firewall, and set **⚙ Settings → Signaling
server URL** to `ws://<that-computer's-IP>:8080` on both computers.

> If Electron starts as plain Node from a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first
> (`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell).

## Deploying your own server

### 1. Cloudflare TURN (relay for strict networks)

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a TURN key.
2. Note the **Turn Token ID** and **API Token**. The free tier includes 1 TB of relay traffic per month.

### 2. Signaling server on Railway (or Fly.io)

**Railway:** New Project → Deploy from GitHub repo → pick this repo. Then, in the service:
- **Settings → Root Directory:** `server`. Railway picks up the `Dockerfile` automatically.
- **Variables:** `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` (`TRUST_PROXY=1` is already set in the Dockerfile).
- **Settings → Networking → Generate Domain**. Your server URL is `wss://<that-domain>`.

**Fly.io:** from `server/`, run `fly launch --copy-config --no-deploy`, then
`fly secrets set CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=…` and `fly deploy`.
Your server URL is `wss://<app-name>.fly.dev`.

Check it by opening `https://<domain>/` in a browser. It should say *remote-desktop signaling server ok*,
and the deploy logs should say `(Cloudflare TURN)`.

To use another TURN provider, set `ICE_SERVERS` to a JSON array of ICE servers instead.

### 3. Releases

1. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add `SERVER_URL` =
   `wss://<your-domain>`. Releases are built with this as the default server.
2. Bump `version` in `app/package.json`, commit, then tag and push:
   ```bash
   git tag v1.0.0
   git push origin main --tags
   ```
3. The **Release** workflow builds the Windows, macOS and Linux installers and publishes them on the Releases page.
   Installed copies pick up new versions automatically.

To build locally instead, set `serverUrl` in `app/renderer/config.js`, then run `npm run dist:win` (or `npm run dist`) in `app/`.
