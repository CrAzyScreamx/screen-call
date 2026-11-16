// Electron main: source picker, then a transparent click-through overlay bridged to server.mjs over localhost HTTP.
import { app, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const preload = join(here, 'preload.cjs')
const base = `http://127.0.0.1:${process.env.SC_PORT}`
const headers = { 'x-sc-token': process.env.SC_TOKEN }
// Recording mode (plugin option): let screen recorders capture the overlay. Claude's look sees it too.
const protect = process.env.SC_RECORD !== 'true'
let win // full-screen overlay: cursor + drawings, never focused, always click-through
let chat // small chat window; the only thing the user interacts with
let placeChat = true // put the chat in the target's bottom-right corner on the next share/tracker tick
let target // desktopCapturer source id being shared: 'screen:…' or 'window:<hwnd>:…'
let tracker = null // PowerShell process following the shared window
let picking = false

const toClaude = (text, snaps = []) =>
  fetch(`${base}/chat${snaps.length ? `?snaps=${snaps.join(',')}` : ''}`, { method: 'POST', headers, body: text }).catch(() => {})

const CHAT_EVENTS = ['say', 'target', 'status']
const send = (ev) => (CHAT_EVENTS.includes(ev.type) ? chat : win).webContents.send('sc:event', ev)

// Bottom-right of the shared area, once per share; after that the user can drag the chat anywhere.
function dockChat(area) {
  if (!placeChat) return
  placeChat = false
  const { width, height } = chat.getBounds()
  chat.setPosition(Math.round(area.x + area.width - width - 20), Math.round(area.y + area.height - height - 20))
  chat.show()
}

// probe: only the 17x16 grayscale grid the server fingerprints (polled every 0.75s by wait_for_change).
// It reads the overlay's live low-res stream (a few ms); a getSources screenshot takes 550-900ms, too slow to poll.
async function shoot() {
  const { width: w, height: h } = win.getBounds() // DIPs; the overlay covers the target exactly
  const sources = await desktopCapturer.getSources({
    types: [target.startsWith('screen') ? 'screen' : 'window'],
    thumbnailSize: { width: 1280, height: Math.round(1280 * h / w) },
  })
  const src = sources.find((s) => s.id === target)
  if (!src) throw new Error('the shared screen or window is gone')
  const size = src.thumbnail.getSize()
  return { jpeg: src.thumbnail.toJPEG(80).toString('base64'), imgW: size.width, imgH: size.height, dispW: w, dispH: h }
}

async function capture(id, probe) {
  let body
  try {
    body = probe ? { gray: await win.webContents.executeJavaScript('probeGray()') } : await shoot()
  } catch (e) {
    body = { error: `capture failed: ${e.message}` }
  }
  await fetch(`${base}/capture/${id}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function listen() {
  const res = await fetch(`${base}/events`, { headers })
  if (!res.ok) throw new Error(`events: ${res.status}`)
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (!frame.startsWith('data: ')) continue
      const ev = JSON.parse(frame.slice(6))
      if (ev.type === 'capture') capture(ev.id, ev.probe)
      else send(ev)
    }
  }
}

// Ask the user which screen or window to share. Resolves to { id, name, display_id }, or null if they close the picker.
let items = []
ipcMain.handle('sc:sources', () => items)
async function pick() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
  items = sources
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({ id: s.id, name: s.name, display_id: s.display_id, thumb: s.thumbnail.toDataURL() }))
  const picker = new BrowserWindow({
    width: 820, height: 600, title: 'Share with Claude', autoHideMenuBar: true, backgroundColor: '#18181b',
    webPreferences: { preload },
  })
  picker.loadFile(join(here, 'picker.html'))
  return new Promise((resolve) => {
    const onPick = (_e, id) => { resolve(items.find((s) => s.id === id) ?? null); picker.close() }
    ipcMain.once('sc:pick', onPick)
    picker.on('closed', () => { ipcMain.removeListener('sc:pick', onPick); resolve(null) })
  })
}

// ponytail: Windows-only. Electron can't read another app's window rect, so a PowerShell loop polls it
// (DWM visible frame, physical px) every 200ms. Exits when the window closes. Port to koffi if this needs macOS/Linux.
const TRACKER = (hwnd) => `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
public struct RECT { public int L, T, R, B; }
'@
$h = [IntPtr][long]${hwnd}
while ([W.U]::IsWindow($h)) {
  $r = New-Object W.U+RECT
  [void][W.U]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
  $fg = [W.U]::GetAncestor([W.U]::GetForegroundWindow(), 3).ToInt64() # 3 = GA_ROOTOWNER: a dialog/popup maps to its main window
  [Console]::Out.WriteLine("$([int][W.U]::IsIconic($h)) $fg $($r.L) $($r.T) $($r.R) $($r.B)")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 200
}`

function stopTracking() { const t = tracker; tracker = null; t?.kill() }

// Keep the overlay glued to the shared window: follow moves/resizes, quit when it closes. Drawings show only
// while that window (or one of its dialogs, or our chat) is in front; minimized or behind another app = hidden.
function followWindow(hwnd) {
  const chatHwnd = String(chat.getNativeWindowHandle().readBigUInt64LE()) // ponytail: 64-bit Windows only
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(TRACKER(hwnd), 'utf16le').toString('base64')], { windowsHide: true })
  tracker = ps
  createInterface({ input: ps.stdout }).on('line', (line) => {
    if (tracker !== ps) return
    const [iconic, fg, ...rect] = line.trim().split(' ')
    const [l, t, r, b] = rect.map(Number)
    const want = screen.screenToDipRect(null, { x: l, y: t, width: r - l, height: b - t })
    if (!picking && iconic === '0') dockChat(want) // first tick after a share; shows the chat, which takes focus
    if (iconic === '1' || picking || (fg !== hwnd && fg !== chatHwnd)) return win.hide()
    const cur = win.getBounds()
    if (want.x !== cur.x || want.y !== cur.y || want.width !== cur.width || want.height !== cur.height) win.setBounds(want)
    if (!win.isVisible()) win.showInactive()
  })
  ps.on('exit', () => { if (tracker === ps) app.quit() }) // the shared window closed
}

// Point the overlay (and look) at a picked source.
function share(src) {
  target = src.id
  stopTracking()
  placeChat = true
  send({ type: 'clear' }) // old drawings belong to the old view
  send({ type: 'target', name: src.name })
  send({ type: 'stream', id: src.id }) // overlay renderer opens the live stream that probes read
  if (target.startsWith('screen')) {
    const display = screen.getAllDisplays().find((d) => String(d.id) === src.display_id) ?? screen.getPrimaryDisplay()
    win.setBounds(display.bounds)
    win.showInactive()
    dockChat(display.workArea)
  } else {
    followWindow(target.split(':')[1])
  }
  toClaude(`(The user is now sharing "${src.name}". Call look before pointing or drawing.)`)
}

app.on('window-all-closed', () => {}) // closing the picker must not quit the app
app.on('will-quit', stopTracking)

app.whenReady().then(async () => {
  const first = await pick()
  if (!first) return app.quit()

  // Full-screen and topmost, but focusable:false + ignoring the mouse outright (no forward: it hooks
  // the global mouse on Windows): it can never take focus or input from the apps underneath.
  win = new BrowserWindow({
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // never focused, so keep timers/rAF at full speed for the drawing animations
    webPreferences: { preload, backgroundThrottling: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.setContentProtection(protect) // keep the overlay out of Claude's own screenshots
  win.loadFile(join(here, 'index.html'))

  chat = new BrowserWindow({
    width: 360, height: 480, title: 'Claude',
    transparent: true, frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false,
    webPreferences: { preload },
  })
  chat.setAlwaysOnTop(true, 'screen-saver', 1) // one notch above the overlay
  chat.setContentProtection(protect)
  chat.loadFile(join(here, 'chat.html'), { query: { chat: process.env.SC_CHAT === 'true' ? '1' : '0' } })
  chat.on('closed', () => app.quit())

  ipcMain.on('sc:chat', (_e, text, snaps) => toClaude(text, snaps))
  // Camera button: screenshot now and park it in the server; it goes to Claude with the next chat message.
  ipcMain.handle('sc:snap', async () => {
    const shot = await shoot()
    const res = await fetch(`${base}/snap`, { method: 'POST', headers, body: JSON.stringify(shot) })
    if (!res.ok) throw new Error(`snap: ${res.status}`)
    return { id: (await res.json()).id, src: `data:image/jpeg;base64,${shot.jpeg}` }
  })
  ipcMain.on('sc:quit', () => app.quit())
  ipcMain.on('sc:repick', async () => {
    if (picking) return
    picking = true
    win.hide()
    chat.hide()
    const src = await pick()
    picking = false
    if (src) return share(src)
    win.showInactive() // cancelled: keep sharing what we had (tracker re-hides if minimized)
    chat.show()
  })

  const loaded = (w) => new Promise((r) => w.webContents.once('did-finish-load', r))
  Promise.all([loaded(win), loaded(chat)]).then(() => {
    share(first)
    // When the server goes away (session ended), the overlay goes too.
    listen().catch(() => {}).finally(() => app.quit())
  })
})
