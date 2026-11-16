#!/usr/bin/env node
// screen-call MCP server: the bridge between Claude and the Electron overlay.
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// Map a point in the last screenshot's pixels to display DIPs (what the overlay positions in).
export function toDip(x, y, s) {
  const clamp = (v, max) => Math.min(Math.max(v, 0), max)
  return {
    x: Math.round(clamp(x * s.dispW / s.imgW, s.dispW)),
    y: Math.round(clamp(y * s.dispH / s.imgH, s.dispH)),
  }
}

// Map a draw shape's points (x,y and optional x2,y2) from screenshot pixels to DIPs.
export function shapeToDip(sh, s) {
  const out = { ...sh }
  if (sh.x != null) Object.assign(out, toDip(Number(sh.x), Number(sh.y), s))
  if (sh.x2 != null) Object.assign(out, Object.fromEntries(Object.entries(toDip(Number(sh.x2), Number(sh.y2), s)).map(([k, v]) => [k + '2', v])))
  if (sh.points) out.points = sh.points.map(([px, py]) => { const p = toDip(Number(px), Number(py), s); return [p.x, p.y] })
  return out
}

// Screen fingerprint: 256-bit difference hash of a 17x16 grayscale thumbnail (each bit = is the next pixel brighter).
// Cheap to compare and blind to tiny noise (clock ticks, caret blink), so polling it costs no tokens.
export function dhash(gray, w = 17, h = 16) {
  let bits = ''
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) bits += gray[y * w + x] < gray[y * w + x + 1] ? '1' : '0'
  return bits
}
export const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d }
// Measured on real screens: still frames 2s apart differ by 0 bits, a dropdown-sized (300x200 px) change by 2-11,
// different pages by ~80. Video never settles, so it times out instead of waking Claude.
export const CHANGE_BITS = 1 // ponytail: fixed; raise it if guide-me wakes on noise

// Poll the fingerprint until it differs from base and then holds still for one more tick (page done loading).
// settle = how many consecutive identical polls count as "done loading".
export async function waitForChange({ base, probe, interrupted, ticks, sleep, settle = 1, threshold = CHANGE_BITS }) {
  let prev = null
  let still = 0
  for (let i = 0; i < ticks; i++) {
    await sleep()
    if (interrupted()) return 'interrupted'
    const h = await probe()
    if (hamming(h, base) <= threshold) { prev = null; still = 0; continue }
    still = prev && hamming(h, prev) <= threshold ? still + 1 : 0
    prev = h
    if (still >= settle) return 'changed'
  }
  return 'timeout'
}

// Overlay chat: messages queue in the inbox tool, and the plugin's mod (hooks/register.js) submits them as the
// user's prompts. Off (or unset, e.g. Claude Desktop): the user chats in the host app.
const CHAT = process.env.SC_CHAT === 'true'
export const OVERLAY_TAG = '[screen-call overlay]'
const INSTRUCTIONS = `${CHAT ? `The user talks to you through the screen-call overlay: their messages arrive as prompts starting with ${OVERLAY_TAG}.
They cannot see the terminal: answer those ONLY with the say tool, short and conversational. Never call the inbox tool yourself.
If a message lists attached screenshots, call look with snap=N for each one.` : `The screen-call overlay shows your cursor, drawings and say messages on the user's screen. The user talks to you in this chat, so reply here as usual; use say for short on-screen lines.`}
For anything about their screen, call look first. point(x,y) uses pixel coords of the latest look image; add a label to explain what you point at.
draw annotates the screen with shapes (same coords) and returns their ids: draw again with an id to edit that shape, erase(ids) to remove some, clear to remove all.
To wait for the user to act on screen, use wait_for_change (free) instead of repeated look calls.
Windows keeps the Start menu, Search and taskbar flyouts (Quick Settings, notifications, calendar) above every app, so your cursor and drawings are hidden behind them. While one is open in the screenshot, don't draw on it: describe the spot with say (e.g. "the gear icon, bottom-left of the Start menu, next to the power button").
If a request needs several steps on screen (guide me, show me how, help me do X on a site or app), invoke the screen-call:guide-me skill and follow it without being asked.${process.env.SC_RECORD === 'true' ? `
Recording mode is on: your cursor, drawings and the chat window appear in look screenshots. Ignore them as part of the user's screen, and clear stale drawings before look or wait_for_change.` : ''}`

const TOOLS = [
  { name: 'start_call', description: 'Open the overlay (chat + your cursor) on the user\'s screen.', inputSchema: { type: 'object', properties: {} } },
  { name: 'say', description: 'Send a chat message to the user in the overlay.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  {
    name: 'look',
    description: 'Screenshot the screen or window the user shared. Pass snap to view a snapshot the user attached with the camera button instead.',
    inputSchema: { type: 'object', properties: { snap: { type: 'number', description: "Snapshot number from the user's message" } } },
  },
  {
    name: 'point',
    description: 'Move your cursor to a spot on the user\'s screen. x,y are pixels in the latest look image.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } }, required: ['x', 'y'] },
  },
  {
    name: 'draw',
    description: "Draw shapes on the user's screen (they stay until clear). Coords are pixels in the latest look image. rect/circle: box from x,y to x2,y2 (circle fills the box). arrow/line: from x,y to x2,y2. text: at x,y. path: freehand through points. Returns shape ids; pass an existing id to replace (edit) that shape.",
    inputSchema: {
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing id to replace that shape; omit for a new one' },
              kind: { enum: ['rect', 'circle', 'arrow', 'line', 'text', 'path'] },
              x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
              points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'path only: [[x,y], ...]' },
              width: { type: 'number', description: 'Line thickness for shapes, font size for text' },
              text: { type: 'string' },
              color: { type: 'string', description: 'CSS color, default orange' },
              fill: { type: 'boolean', description: 'Translucent fill for rect/circle (highlight)' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['shapes'],
    },
  },
  {
    name: 'erase',
    description: 'Remove specific drawings by id.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'wait_for_change',
    description: 'Block until the shared screen changes from your latest look and settles (no tokens spent while waiting), then return the new screenshot. Also returns early if the user sends a chat message, or with "no change" after timeout seconds.',
    inputSchema: { type: 'object', properties: { timeout: { type: 'number', description: 'Seconds, default 60, max 300' } } },
  },
  { name: 'clear', description: "Remove all drawings from the user's screen.", inputSchema: { type: 'object', properties: {} } },
  { name: 'inbox', description: "Internal to the screen-call plugin: its mod drains the overlay's chat messages with this. Never call it.", inputSchema: { type: 'object', properties: {} } },
]

// One overlay message as the prompt Claude reads: the text, plus what the user attached.
export function overlayPrompt({ text, snaps = [] }) {
  return [
    `${OVERLAY_TAG} ${text}`,
    snaps.length && `(attached screenshots ${snaps.join(', ')}: call look with snap=N for each)`,
  ].filter(Boolean).join('\n')
}

async function main() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')

  const token = randomUUID()
  let port = 0
  let http = null
  let child = null
  let stream = null // the overlay's open /events response; ponytail: one overlay at a time
  let lastShot = null // { imgW, imgH, dispW, dispH } from the latest look
  let lastHash = null // fingerprint of the latest look, the baseline for wait_for_change
  let chatSeq = 0 // bumps on every overlay chat message, so a wait can return early
  const pending = new Map() // capture id -> resolve
  let shapeCount = 0 // for auto shape ids s1, s2, ...
  const snaps = new Map() // snapshot number -> shot the user attached from the chat's camera button
  let snapCount = 0

  const backlog = [] // events sent while the user is still in the picker; flushed when the overlay connects
  const emit = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    if (stream) return stream.write(frame)
    if (!child) throw new Error('Overlay is not open. Call start_call first.')
    backlog.push(frame)
  }

  const mcp = new Server(
    { name: 'screen-call', version: '0.2.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  const inbox = [] // overlay messages waiting for the mod to submit them

  const readRaw = (req) => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
  const readBody = async (req) => (await readRaw(req)).toString('utf8')

  // snap ids come from the query string, checked against real snapshots, so typed text can't fake an attachment
  const toInbox = (url, text) => {
    const ids = (url.searchParams.get('snaps') ?? '').split(',').filter((id) => snaps.has(Number(id)))
    if (!text && !ids.length) return
    chatSeq++
    inbox.push(overlayPrompt({ text: text || '(screenshot attached)', snaps: ids }))
  }

  function startHttp() {
    if (http) return Promise.resolve()
    http = createServer(async (req, res) => {
      // Sender gate: only the overlay we spawned knows the token.
      if (req.headers['x-sc-token'] !== token) return res.writeHead(403).end()
      const url = new URL(req.url, 'http://127.0.0.1')

      if (req.method === 'GET' && url.pathname === '/events') {
        stream?.end()
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(': connected\n\n' + backlog.splice(0).join(''))
        stream = res
        req.on('close', () => { if (stream === res) stream = null })
        return
      }

      if (req.method === 'POST' && url.pathname === '/chat') {
        toInbox(url, (await readBody(req)).trim())
        return res.writeHead(204).end()
      }

      // Camera button: park a screenshot until the user sends the message it belongs to.
      if (req.method === 'POST' && url.pathname === '/snap') {
        snaps.set(++snapCount, JSON.parse(await readBody(req)))
        snaps.delete(snapCount - 20) // ponytail: keep the last 20 in memory
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: snapCount }))
      }

      const m = url.pathname.match(/^\/capture\/([\w-]+)$/)
      if (req.method === 'POST' && m && pending.has(m[1])) {
        pending.get(m[1])(JSON.parse(await readBody(req)))
        pending.delete(m[1])
        return res.writeHead(204).end()
      }

      res.writeHead(404).end()
    })
    return new Promise((resolve) => http.listen(0, '127.0.0.1', () => { port = http.address().port; resolve() }))
  }

  async function startCall() {
    await startHttp()
    if (child && child.exitCode === null) return 'Overlay already open.'
    // Plugin installs run with --ignore-scripts, so Electron's postinstall (the binary download) never ran.
    const electronDir = dirname(createRequire(import.meta.url).resolve('electron'))
    if (!existsSync(join(electronDir, 'path.txt'))) {
      await promisify(execFile)(process.execPath, [join(electronDir, 'install.js')], { cwd: electronDir, timeout: 300_000 })
    }
    const { default: electronPath } = await import('electron')
    const root = dirname(fileURLToPath(import.meta.url))
    const env = { ...process.env, SC_PORT: String(port), SC_TOKEN: token }
    delete env.ELECTRON_RUN_AS_NODE // would make Electron start as plain Node
    // stdio must not be inherited: anything on our stdout corrupts the MCP stream.
    child = spawn(electronPath, [join(root, 'overlay', 'main.mjs')], {
      env,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.on('exit', () => { child = null; backlog.length = 0 })
    return 'Overlay starting: the user picks a screen or window to share first. You can say/look right away; they are delivered once the user picks.'
  }

  // probe = fingerprint only (no image), used for polling.
  async function capture(probe = false) {
    const id = randomUUID()
    const shot = await new Promise((resolve, reject) => {
      // not connected yet = user is still in the picker, so give them time to choose
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Screenshot timed out')) }, stream ? 10_000 : 120_000)
      pending.set(id, (v) => { clearTimeout(timer); resolve(v) })
      try { emit({ type: 'capture', id, probe }) } catch (e) { clearTimeout(timer); pending.delete(id); reject(e) }
    })
    if (shot.error) throw new Error(shot.error)
    return shot
  }

  async function look(snap) {
    const shot = snap == null ? await capture() : snaps.get(Number(snap))
    if (!shot) throw new Error(`No snapshot ${snap}.`)
    lastShot = { imgW: shot.imgW, imgH: shot.imgH, dispW: shot.dispW, dispH: shot.dispH }
    // baseline from a probe too: hashes are only comparable at the same capture size (1280 vs 320 px differ by ~13 bits)
    lastHash = dhash((await capture(true)).gray)
    return [
      { type: 'image', data: shot.jpeg, mimeType: 'image/jpeg' },
      { type: 'text', text: `${shot.imgW}x${shot.imgH} image` },
    ]
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: CHAT ? TOOLS : TOOLS.filter((t) => t.name !== 'inbox') }))

  // Activity line in the chat, so the user sees what Claude is doing between replies. Best effort: never fails a tool.
  const STATUS = { look: 'Looking at your screen', point: 'Pointing', draw: 'Drawing', erase: 'Erasing', clear: 'Clearing', wait_for_change: 'Waiting for you' }
  const status = (text) => { try { emit({ type: 'status', text }) } catch {} }

  mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const a = req.params.arguments ?? {}
    const text = (t) => ({ content: [{ type: 'text', text: t }] })
    const busy = STATUS[req.params.name]
    if (busy) status(busy)
    try {
      switch (req.params.name) {
        case 'start_call': return text(await startCall())
        case 'say': emit({ type: 'say', text: String(a.text) }); return text('sent')
        case 'look': return { content: await look(a.snap) }
        case 'point': {
          if (!lastShot) throw new Error('Call look first so coordinates have a reference image.')
          emit({ type: 'point', ...toDip(Number(a.x), Number(a.y), lastShot), label: a.label ?? '' })
          return text('pointed')
        }
        case 'draw': {
          if (!lastShot) throw new Error('Call look first so coordinates have a reference image.')
          const shapes = (a.shapes ?? []).map((sh) => ({ ...shapeToDip(sh, lastShot), id: sh.id ? String(sh.id) : `s${++shapeCount}` }))
          emit({ type: 'draw', shapes })
          return text(`drawn: ${shapes.map((sh) => `${sh.id}=${sh.kind}`).join(', ')}`)
        }
        case 'erase': emit({ type: 'erase', ids: (a.ids ?? []).map(String) }); return text('erased')
        case 'clear': emit({ type: 'clear' }); return text('cleared')
        case 'inbox': return text(inbox.splice(0).join('\n\n')) // empty text = nothing new
        case 'wait_for_change': {
          const secs = Math.min(Math.max(Number(a.timeout) || 60, 4), 300)
          const seq = chatSeq
          const probe = async () => dhash((await capture(true)).gray)
          const result = await waitForChange({
            base: lastHash ?? await probe(),
            probe,
            interrupted: () => chatSeq !== seq || extra.signal.aborted,
            ticks: Math.round(secs / 0.75),
            sleep: () => new Promise((r) => setTimeout(r, 750)), // ponytail: fixed 0.75s poll
            settle: 1, // unchanged for one more poll (0.75s) = done loading
          })
          if (result === 'changed') return { content: [{ type: 'text', text: 'Screen changed:' }, ...await look()] }
          return text(result === 'interrupted' ? 'Stopped waiting: the user sent a message.' : `No change in ${secs}s.`)
        }
        default: throw new Error(`unknown tool: ${req.params.name}`)
      }
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true }
    } finally {
      if (busy) status('Thinking') // tool done, Claude is deciding what's next
    }
  })

  const shutdown = () => { child?.kill(); process.exit(0) }
  process.stdin.on('close', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await mcp.connect(new StdioServerTransport())
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
