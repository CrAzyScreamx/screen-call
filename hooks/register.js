// screen-call mod: overlay chat -> this session, no channels flag needed.
// Drains the MCP server's inbox and submits each batch as the user's own prompt.
const SERVER = 'plugin:screen-call:call' // the plugin's MCP server, as /mcp lists it

let polling = false
let pending = '' // a batch the session refused (the user pressed Esc); retried when a turn completes

// Not awaited by callers: submit resolves only once its turn starts.
async function submit($, text) {
  const r = await $.prompt.submit({ text, asUser: true }).catch((err) => ({ drop: String(err?.message ?? err) }))
  if (r?.drop) pending = pending ? `${pending}\n\n${text}` : text
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // ponytail: 1s poll; a long-polling inbox would cut the delay if it ever matters
    $.clock.every(1000, async () => {
      if (polling) return
      polling = true
      try {
        const r = await $.mcp.call(SERVER, 'inbox')
        const text = r.isError ? '' : (r.content ?? []).map((c) => c.text ?? '').join('')
        if (text) void submit($, text)
      } catch {
        // server not connected yet, or overlay chat is off (no inbox tool): try again next tick
      } finally {
        polling = false
      }
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (pending && e.agentId === undefined) {
      const text = pending
      pending = ''
      void submit($, text)
    }
    return next(e)
  })
}
