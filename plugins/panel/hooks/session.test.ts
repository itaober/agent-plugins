import { expect, test } from 'claude-code/testing'

import { shortModel } from './section'
import { dirtyCount, effortLevel, parseLines, resetsIn } from './sections/session'
import { bar, levelRole, THEMES } from './theme'

const NOW = Date.parse('2026-11-06T12:00:00Z')

test('says how long until a usage window resets', async () => {
  expect(resetsIn('2026-11-06T12:12:00Z', NOW)).toBe('12m')
  expect(resetsIn('2026-11-06T12:00:20Z', NOW)).toBe('1m')
  expect(resetsIn('2026-11-06T15:30:00Z', NOW)).toBe('3h 30m')
  expect(resetsIn('2026-11-06T15:00:00Z', NOW)).toBe('3h')
  expect(resetsIn('2026-11-08T19:00:00Z', NOW)).toBe('2d 7h')
  expect(resetsIn('2026-11-08T12:00:00Z', NOW)).toBe('2d')
  expect(resetsIn('2026-11-06T11:00:00Z', NOW)).toBeUndefined()
  expect(resetsIn(undefined, NOW)).toBeUndefined()
})

test('shortens model ids', async () => {
  expect(shortModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(shortModel('haiku')).toBe('Haiku')
  expect(shortModel('custom')).toBe('custom')
})

test('reads sessionLines as order and visibility, falling back to the default', async () => {
  // There is no git line: naming one counts as unknown
  expect(parseLines('week, Model,bogus,week,git')).toEqual(['week', 'model'])
  expect(parseLines('')).toEqual(['dir', 'model', 'context', '5h', 'week'])
  expect(parseLines('git')).toEqual(['dir', 'model', 'context', '5h', 'week'])
  expect(parseLines(undefined)).toHaveLength(5)
})

test('takes the effort level a turn step carries', async () => {
  expect(effortLevel('high')).toBe('high')
  expect(effortLevel('')).toBeUndefined()
  // A numeric budget is not drawn
  expect(effortLevel(2048)).toBeUndefined()
  expect(effortLevel(undefined)).toBeUndefined()
})

test('counts git status --porcelain lines', async () => {
  expect(dirtyCount(' M a.ts\n?? b.ts\n')).toBe(2)
  expect(dirtyCount('')).toBe(0)
})

test('draws a ten-cell bar', async () => {
  expect(bar(22)).toEqual(['██', '░░░░░░░░'])
  expect(bar(79)).toEqual(['████████', '░░'])
  expect(bar(0)).toEqual(['', '░░░░░░░░░░'])
  expect(bar(130)).toEqual(['██████████', ''])
})

test('picks colors from the three themes by threshold', async () => {
  expect(levelRole('context', 69)).toBe('ok')
  expect(levelRole('context', 70)).toBe('warn')
  expect(levelRole('context', 85)).toBe('bad')
  expect(levelRole('usage', 74)).toBe('usage')
  expect(levelRole('usage', 75)).toBe('usageWarn')
  expect(levelRole('usage', 90)).toBe('bad')
  expect(THEMES.gruvbox[levelRole('context', 90)]).toEqual({ color: '#fb4934' })
  expect(THEMES.gruvbox.dirty).toEqual({ color: '#fe8019' })
  expect(THEMES.hud[levelRole('usage', 80)]).toEqual({ color: 'magenta' })
  expect(THEMES.hud.label).toEqual({ dimColor: true })
  expect(THEMES.terminal[levelRole('context', 72)]).toEqual({ color: 'warning' })
  expect(THEMES.terminal.label).toEqual({ color: 'subtle' })
})
