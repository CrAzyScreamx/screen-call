import { expect, mock, test } from 'claude-code/testing'

const reply = (text: string) => ({ value: { content: [{ type: 'text', text }], isError: false } })

test('overlay messages become user prompts; an empty inbox submits nothing', async ($, on) => {
  const clock = mock.clock(on)
  const inbox = ['', '[screen-call overlay] hi', '']
  const calls: string[] = []
  const submitted: { text: string; asUser?: true }[] = []
  on('mcp.call', (_, e) => { calls.push(`${e.server}/${e.tool}`); return reply(inbox.shift() ?? '') })
  on('prompt.submit', (_, e) => { submitted.push({ text: e.text, asUser: e.origin?.kind === 'plugin' ? e.origin.asUser : undefined }); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)

  expect(calls).toEqual(['plugin:screen-call:call/inbox', 'plugin:screen-call:call/inbox', 'plugin:screen-call:call/inbox'])
  expect(submitted).toEqual([{ text: '[screen-call overlay] hi', asUser: true }])
})

test('a refused prompt is submitted again when the next turn completes', async ($, on) => {
  const clock = mock.clock(on)
  const inbox = ['[screen-call overlay] first']
  const submitted: string[] = []
  let refuse = true
  on('mcp.call', () => reply(inbox.shift() ?? ''))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    if (refuse) return { drop: 'the session was stopped and nobody has sent input since' }
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  refuse = false
  await $.turn.complete({ answer: 'ok', durationMs: 1, reason: 'answer' } as never)
  await clock.settle()

  expect(submitted).toEqual(['[screen-call overlay] first', '[screen-call overlay] first'])
})
