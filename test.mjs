import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDip, shapeToDip, dhash, hamming, waitForChange, overlayPrompt } from './server.mjs'

test('overlayPrompt tags the message and lists attachments', () => {
  assert.equal(overlayPrompt({ text: 'hi' }), '[screen-call overlay] hi')
  assert.equal(overlayPrompt({ text: 'look', snaps: ['3', '4'] }), '[screen-call overlay] look\n(attached screenshots 3, 4: call look with snap=N for each)')})

test('identity when image matches display', () => {
  assert.deepEqual(toDip(100, 50, { imgW: 1280, imgH: 720, dispW: 1280, dispH: 720 }), { x: 100, y: 50 })
})

test('scales image pixels up to DIPs', () => {
  // 1920x1080 DIP display, 1280x720 screenshot -> 1.5x
  assert.deepEqual(toDip(640, 360, { imgW: 1280, imgH: 720, dispW: 1920, dispH: 1080 }), { x: 960, y: 540 })
})

test('clamps out-of-range points to the display', () => {
  assert.deepEqual(toDip(-10, 9999, { imgW: 1280, imgH: 720, dispW: 1920, dispH: 1080 }), { x: 0, y: 1080 })
})

test('shapeToDip maps both corners and keeps other fields', () => {
  const s = { imgW: 1280, imgH: 720, dispW: 1920, dispH: 1080 }
  assert.deepEqual(shapeToDip({ kind: 'rect', x: 0, y: 0, x2: 640, y2: 360, color: 'red' }, s),
    { kind: 'rect', x: 0, y: 0, x2: 960, y2: 540, color: 'red' })
  assert.deepEqual(shapeToDip({ kind: 'text', x: 640, y: 360, text: 'hi' }, s), { kind: 'text', x: 960, y: 540, text: 'hi' })
  assert.deepEqual(shapeToDip({ kind: 'path', points: [[0, 0], [640, 360]] }, s), { kind: 'path', points: [[0, 0], [960, 540]] })
})

test('dhash: 256 bits, identical for same image, far apart for different images', () => {
  const ramp = Array.from({ length: 17 * 16 }, (_, i) => i % 17) // brightness rises left to right
  const flip = ramp.map((v) => 16 - v)
  assert.equal(dhash(ramp).length, 256)
  assert.equal(hamming(dhash(ramp), dhash(ramp)), 0)
  assert.equal(hamming(dhash(ramp), dhash(flip)), 256)
})

test('waitForChange: returns only once a change has settled', async () => {
  const run = (frames, interrupted = () => false) => {
    let i = 0
    return waitForChange({ base: 'A', probe: async () => frames[i++], interrupted, ticks: frames.length, sleep: async () => {}, threshold: 0 })
  }
  assert.equal(await run(['A', 'A', 'A']), 'timeout') // nothing happened
  assert.equal(await run(['B', 'C', 'D']), 'timeout') // still animating/loading
  assert.equal(await run(['A', 'B', 'B']), 'changed') // new page, then stable
  assert.equal(await run(['B', 'A', 'A']), 'timeout') // flickered back to the same view
  assert.equal(await run(['B', 'B'], () => true), 'interrupted') // user typed in the chat
})

test('waitForChange: settle waits for several identical polls', async () => {
  const run = (frames) => {
    let i = 0
    return waitForChange({ base: 'A', probe: async () => frames[i++], interrupted: () => false, ticks: frames.length, sleep: async () => {}, settle: 2, threshold: 0 })
  }
  assert.equal(await run(['B', 'B', 'C', 'C']), 'timeout') // paused once mid-load, not settled
  assert.equal(await run(['B', 'C', 'C', 'C']), 'changed')
})
