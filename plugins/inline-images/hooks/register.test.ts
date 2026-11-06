import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { On } from 'claude-code'

import { columnsFor, drawsImages, parsePreview, pngSize, rowsFor } from './register'

const TOOL = 'mcp__inline-images__show_images'

test('reads PNG width and height from IHDR', async () => {
  const bytes = new Uint8Array(24)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x89504e47)
  view.setUint32(16, 1302)
  view.setUint32(20, 630)
  expect(pngSize(bytes)).toEqual({ width: 1302, height: 630 })
  expect(pngSize(new Uint8Array(4))).toEqual({ width: 16, height: 10 })
})

test('keeps the aspect ratio in terminal cells and caps rows', async () => {
  expect(rowsFor({ width: 1302, height: 630 }, 80)).toBe(19)
  expect(rowsFor({ width: 100, height: 1000 }, 80)).toBe(60)
})

test('splits the width between side-by-side images', async () => {
  expect(columnsFor('stack', 2, 150)).toBe(100)
  expect(columnsFor('row', 2, 150)).toBe(74)
  expect(columnsFor('row', 3, 150)).toBe(48)
})

test('round-trips the preview through the string result', async () => {
  const shown = [{ path: '/tmp/a.png', label: 'Before', width: 10, height: 5 }]
  expect(parsePreview(JSON.stringify({ layout: 'row', shown }))).toEqual({ layout: 'row', shown })
  expect(parsePreview(JSON.stringify({ shown }))?.layout).toBe('stack')
  expect(parsePreview('not json')).toBeNull()
})

test('refuses a path that is not an absolute PNG', async $ => {
  const result = await $.tool.call({ tool: TOOL, images: [{ path: 'shot.jpg' }] })
  expect(result.deny ?? result.text).toContain('Not an absolute .png path')
})

test('offers the tool only in terminals that draw pixels', async () => {
  expect(drawsImages({ term: 'xterm-ghostty', termProgram: 'ghostty' })).toBe(true)
  expect(drawsImages({ term: 'xterm-kitty' })).toBe(true)
  expect(drawsImages({ term: 'xterm-ghostty', termProgram: 'ghostty', tmux: '/tmp/tmux-501/default,1,0' })).toBe(false)
  expect(drawsImages({ term: 'xterm-256color', termProgram: 'iTerm.app' })).toBe(false)
})

/** Starts a session in a terminal detection does not recognise; returns the tools it registered. */
async function startUndetected($: Parameters<TestBody>[0], on: On, surface: 'terminal' | 'desktop' = 'terminal') {
  mock.env(on, { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' })
  const registered: string[] = []
  on('tool.register', (_$, e) => (registered.push(e.name), { value: { tool: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
  return registered
}

test('leaves the tool out where detection fails and force is off', async ($, on) => {
  expect(await startUndetected($, on)).toEqual([])
})

test('offers the tool regardless of detection when force is on', { options: { force: true } }, async ($, on) => {
  expect(await startUndetected($, on)).toEqual(['show_images'])
})

test('still leaves the tool out off the terminal when force is on', { options: { force: true } }, async ($, on) => {
  expect(await startUndetected($, on, 'desktop')).toEqual([])
})
