# screen-call

A "video call" with Claude. An always-on-top overlay puts Claude's own cursor on your screen: Claude looks at what you share, points at things, draws arrows and boxes, and talks to you in a small chat window. Ask "show me how to do X" and it walks you through it step by step, marking the next thing to click and waiting for your screen to change.

Works with **Claude Code** (full experience, including chatting and voice messages in the overlay) and **Claude Desktop** (cursor and drawings in the overlay; you chat in Desktop).

[![npm](https://img.shields.io/npm/v/screen-call)](https://www.npmjs.com/package/screen-call)

## Requirements

- Node.js 18 or later
- Built and tested on Windows 10/11. Sharing a single window is Windows-only.

## Install

### Claude Code

```
/plugin marketplace add CrAzyScreamx/screen-call
/plugin install screen-call@screen-call
```

The install dialog asks two things (change them later in `/config`):

- **Chat in the overlay** (on by default): type and send voice messages in the overlay. Turn it off to chat in the terminal; the overlay still shows Claude's cursor, drawings and messages.
- **Recording mode** (off by default): see [Recording the screen](#recording-the-screen).

The overlay chat uses Claude Code [channels](https://code.claude.com/docs/en/channels) (research preview). Custom channels aren't on the allowlist yet, so start Claude Code with:

```powershell
claude --dangerously-load-development-channels plugin:screen-call@screen-call
```

The first call downloads Electron (~100 MB), so give it a minute.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), then fully quit Desktop (tray icon → Quit) and reopen it:

```json
{
  "mcpServers": {
    "screen-call": { "command": "npx", "args": ["-y", "screen-call"] }
  }
}
```

If Desktop can't start `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "screen-call"]`.

## Use

- **Claude Code:** run `/screen-call:start`.
- **Claude Desktop:** in a new chat, ask "start a screen call".

A picker opens: choose a screen, or a single window (the overlay then follows that window as it moves, and drawings show only while it's in front). The small Claude window shows Claude's messages; drag it by its header, **Switch** changes what's shared, **×** ends the call. Claude's cursor and drawings sit on a layer that never takes focus or clicks, so your apps keep working normally.

### Guide me

Ask for anything that takes several steps ("help me turn on 2FA on GitHub") and Claude marks the next thing to click, waits for your screen to change, checks you got there, and marks the next step.

### Voice messages and screenshots (Claude Code)

Click 🎤 in the chat to record, ⏹ to send (Esc cancels). Claude transcribes the clip with whatever you have connected (a transcription MCP server, or a local CLI like `whisper`); if nothing can, it tells you what to install. Click 📷 to attach a screenshot of the exact moment to your next message.

## Recording the screen

By default the overlay is hidden from screen capture, so Claude's screenshots show only your screen. That also hides it from OBS, Snipping Tool, Game Bar and Teams/Zoom sharing. To record or share the overlay, turn on **Recording mode**:

- **Claude Code:** `/config` → Recording mode, then restart Claude Code.
- **Claude Desktop:** add `"env": { "SC_RECORD": "true" }` to the `screen-call` entry, then restart Desktop.

Claude then sees its own cursor and drawings in its screenshots too, so it clears stale drawings before looking.

## Tools

| Tool | What it does |
|---|---|
| `start_call` | Opens the picker, then the overlay |
| `say(text)` | Message in the overlay's chat window |
| `look(snap?)` | Screenshot of the shared screen or window, 1280px wide. `snap: N` shows snapshot N the user attached with 📷 |
| `point(x, y, label?)` | Moves Claude's cursor; coordinates are pixels in the latest `look` image |
| `draw(shapes)` | Draws `rect`, `circle`, `arrow`, `line`, `text`, `path` (same coords); `fill`, `color`, `width`. Returns shape ids; pass an `id` to edit that shape |
| `erase(ids)` | Removes specific drawings |
| `clear()` | Removes all drawings |
| `wait_for_change(timeout?)` | Waits (no tokens spent) until the shared view changes and settles, then returns the new screenshot; returns early on a chat message |

Outside auto mode, add an allow rule for the plugin's tools so `say` doesn't prompt every time.

## Development

```powershell
git clone https://github.com/CrAzyScreamx/screen-call; cd screen-call; npm install
npm test
claude --plugin-dir .
```

## License

MIT
