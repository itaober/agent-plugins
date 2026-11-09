import { expect, test } from 'claude-code/testing'

import type { AgentStatus, SessionMessage } from 'claude-code'

import type { AgentRow } from '../types'
import { agentsFromMessages, historyLine, isHistory, mainRight, mainSegments, reconciled, rightLine, settledState, sortAgents, stepCounted, stepStarted, subSegments } from './sections/agents'
import type { Segment } from './sections/agents'
import { duration, tokenCount } from './section'

/** The second line as drawn: empty parts dropped, the rest joined */
const shown = (segments: Segment[]) =>
  segments
    .map(([text]) => text)
    .filter(Boolean)
    .join(' · ')

const row = (id: string, state: AgentRow['state'], startedAt: number, endedAt?: number): AgentRow => ({
  id,
  title: id,
  state,
  startedAt,
  endedAt,
})

test('puts running agents first, then the rest by end time, newest first', async () => {
  const list = [row('done-old', 'done', 0, 10), row('run-a', 'running', 5), row('fail-new', 'failed', 1, 30), row('run-b', 'running', 8)]
  expect(sortAgents(list).map(a => a.id)).toEqual(['run-b', 'run-a', 'fail-new', 'done-old'])
  expect(sortAgents(Array.from({ length: 60 }, (_, i) => row(`a${i}`, 'done', i, i)))).toHaveLength(50)
})

test('settles a finished turn from the engine list, else from the reason', async () => {
  expect(settledState('completed', 'answer', undefined)).toBe('done')
  expect(settledState('killed', 'answer', undefined)).toBe('aborted')
  expect(settledState('running', 'answer', undefined)).toBe('done')
  expect(settledState(undefined, 'error', undefined)).toBe('failed')
  expect(settledState(undefined, 'aborted', undefined)).toBe('aborted')
  expect(settledState('running', 'answer', 'teammate')).toBe('idle')
  expect(settledState('waiting', 'refusal', undefined)).toBe('failed')
  expect(settledState('idle', 'answer', undefined)).toBe('idle')
})

test('formats durations short', async () => {
  expect(duration(40_000)).toBe('40s')
  expect(duration(80_000)).toBe('1m 20s')
  expect(duration(437_000)).toBe('7m 17s')
  expect(duration(120_000)).toBe('2m')
  expect(duration(12 * 60_000 + 5_000)).toBe('12m')
  expect(duration(65 * 60_000)).toBe('1h 5m')
  expect(duration(120 * 60_000)).toBe('2h')
})

test('writes the right side as duration, tokens, then state', async () => {
  expect(rightLine({ ...row('a', 'running', 1), tokens: 7_200 }, 437_001)).toBe('7m 17s · ↓ 7.2k · Running')
  // forks and teammates get no extra mark
  expect(rightLine({ ...row('f', 'running', 1), kind: 'fork' }, 12_001)).toBe('12s · Running')
  expect(rightLine({ ...row('b', 'done', 1, 4_001), tokens: 324 }, 999_000)).toBe('4s · ↓ 324 · Done')
  expect(rightLine({ ...row('c', 'idle', 1, 300_001), kind: 'teammate' }, 999_000)).toBe('5m · Idle')
  // A rebuilt row has no start time
  expect(rightLine(row('d', 'done', 0), 999_000)).toBe('Done')
})

test('counts tokens the way Claude does', async () => {
  expect(tokenCount(950)).toBe('950')
  expect(tokenCount(1000)).toBe('1.0k')
  expect(tokenCount(114_820)).toBe('114.8k')
  expect(tokenCount(1_234_567)).toBe('1.2m')
})

test('writes the second line as description, model and effort', async () => {
  expect(subSegments({ ...row('a', 'running', 1), model: 'Haiku 5.5', effort: 'low', description: 'Count the panel test cases' })).toEqual([
    ['Count the panel test cases'],
    ['Haiku 5.5', 'model'],
    ['low', 'effort'],
  ])
  expect(shown(subSegments({ ...row('b', 'done', 1), model: 'Haiku 5.5' }))).toBe('Haiku 5.5')
  expect(shown(subSegments(row('c', 'done', 1)))).toBe('')
})

test('writes the main row like a subagent: state, this turn, tokens; then model and effort', async () => {
  const session = { dir: '~', model: 'Fable 5.1', effort: 'high' }
  expect(mainRight({ ...session, isBusy: true, turnStartedAt: 1_000, tokens: 7_200 }, 438_000)).toBe('7m 17s · ↓ 7.2k · Running')
  // Idle: no duration
  expect(mainRight({ ...session, isBusy: false, turnStartedAt: 1_000, tokens: 324 }, 438_000)).toBe('↓ 324 · Idle')
  expect(mainRight(session, 438_000)).toBe('Idle')
  expect(mainSegments(session)).toEqual([
    ['Fable 5.1', 'model'],
    ['high', 'effort'],
  ])
  expect(shown(mainSegments({ dir: '~', model: 'Fable 5.1' }))).toBe('Fable 5.1')
})

test('rebuilds agent rows from the transcript after a restart', async () => {
  const messages: SessionMessage[] = [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 't1', tool: 'Agent', input: { description: 'Look up docs' }, agentId: 'a1', text: 'done' },
        { tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' }, text: 'x' },
      ],
    },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 't3', tool: 'Agent', input: { description: 'Merge', name: 'merger', model: 'haiku', effort: 'low' }, agentId: 'a2', text: 'boom', isError: true },
        { tool_use_id: 't4', tool: 'Agent', input: { description: 'Cut short', subagent_type: 'fork' }, agentId: 'a3' },
        { tool_use_id: 't5', tool: 'Agent', input: { description: 'Still going' }, agentId: 'a4', text: 'launched' },
      ],
    },
  ]
  const rows = agentsFromMessages(messages, new Map([['a4', 'running' as const]]))
  expect(rows.map(r => [r.id, r.title, r.description, r.state, r.kind, r.startedAt])).toEqual([
    ['a4', 'general-purpose', 'Still going', 'running', undefined, 0],
    ['a3', 'fork', 'Cut short', 'aborted', 'fork', 0],
    ['a2', 'merger', 'Merge', 'failed', undefined, 0],
    ['a1', 'general-purpose', 'Look up docs', 'done', undefined, 0],
  ])
  expect(rows.map(r => [r.model, r.effort])).toEqual([
    [undefined, undefined],
    [undefined, undefined],
    ['Haiku', 'low'],
    [undefined, undefined],
  ])
})

const MIN = 60_000
const KEEP = 10 * MIN

test('folds a finished agent after agentsKeep, a failed one after six times that', async () => {
  const end = 100 * MIN
  expect(isHistory(row('d', 'done', 1, end), end + KEEP - 1, KEEP)).toBe(false)
  expect(isHistory(row('d', 'done', 1, end), end + KEEP, KEEP)).toBe(true)
  expect(isHistory(row('f', 'failed', 1, end), end + KEEP, KEEP)).toBe(false)
  expect(isHistory(row('f', 'failed', 1, end), end + 6 * KEEP, KEEP)).toBe(true)
  expect(isHistory(row('x', 'aborted', 1, end), end + 6 * KEEP, KEEP)).toBe(true)
  // Running and idle agents always keep their own row
  expect(isHistory(row('r', 'running', 1), end * 9, KEEP)).toBe(false)
  expect(isHistory(row('i', 'idle', 1, end), end * 9, KEEP)).toBe(false)
})

test('sends rebuilt finished rows straight to the summary, keeps rebuilt running ones', async () => {
  expect(isHistory(row('d', 'done', 0), 1, KEEP)).toBe(true)
  expect(isHistory(row('r', 'running', 0), 1, KEEP)).toBe(false)
  // A rebuilt row that finishes after the restart has an end time and is kept as usual
  expect(isHistory(row('d', 'done', 0, 5 * MIN), 6 * MIN, KEEP)).toBe(false)
})

test('never folds when agentsKeep is 0', async () => {
  expect(isHistory(row('d', 'done', 1, 1), 999 * MIN, 0)).toBe(false)
  expect(isHistory(row('d', 'done', 0), 999 * MIN, 0)).toBe(false)
})

test('writes the summary line, leaving out zero counts and adding up tokens', async () => {
  const done = (id: string, tokens?: number): AgentRow => ({ ...row(id, 'done', 1, 2), tokens })
  expect(historyLine([done('a', 100_000), done('b', 84_000), { ...row('c', 'aborted', 1, 2), tokens: 500 }, row('d', 'failed', 1, 2)])).toBe(
    '✓ 2 done · ✗ 2 failed · ↓ 184.5k',
  )
  expect(historyLine([done('a'), done('b')])).toBe('✓ 2 done')
  expect(historyLine([{ ...row('c', 'failed', 1, 2), tokens: 300 }])).toBe('✗ 1 failed · ↓ 300')
})

test('starts a new run on a turnId the row has not seen, and keeps the run on its own steps', async () => {
  const failed: AgentRow = { ...row('a', 'failed', 1_000, 5_000), turnId: 'run1', tokens: 9_000, outputTokens: 800 }
  // Same run: running again, start and tokens kept
  expect(stepStarted(failed, 'run1', 9_000)).toEqual({ ...failed, state: 'running', endedAt: undefined })
  // Resumed: timed and counted afresh
  expect(stepStarted(failed, 'run2', 9_000)).toEqual({ ...row('a', 'running', 9_000), turnId: 'run2', tokens: undefined, outputTokens: undefined })
})

test('counts tokens as the tasks bar: the last request input with cache, plus the run output', async () => {
  const usage = (input: number, created: number, cached: number, output: number) => ({
    model: 'm',
    input_tokens: input,
    cache_creation_input_tokens: created,
    cache_read_input_tokens: cached,
    output_tokens: output,
  })
  const first = stepCounted(row('a', 'running', 1), usage(100, 2_000, 30_000, 400))
  expect([first.tokens, first.outputTokens]).toEqual([32_500, 400])
  // The input is replaced, not added; output adds up
  const second = stepCounted(first, usage(50, 500, 40_000, 600))
  expect([second.tokens, second.outputTokens]).toEqual([41_550, 1_000])
})

test('reconciles live rows with the engine list', async () => {
  const list = [
    row('killed', 'running', 1),
    row('failed', 'running', 1),
    row('completed', 'running', 1),
    row('gone', 'running', 1),
    row('goneIdle', 'idle', 1, 2),
    row('nowIdle', 'running', 1),
    row('waiting', 'running', 1),
    row('resumed', 'done', 1, 2),
  ]
  const listed = new Map<string, AgentStatus>([
    ['killed', 'killed'],
    ['failed', 'failed'],
    ['completed', 'completed'],
    ['nowIdle', 'idle'],
    ['waiting', 'waiting'],
    ['resumed', 'running'],
  ])
  const byId = Object.fromEntries((reconciled(list, listed, 50) ?? []).map(a => [a.id, [a.state, a.endedAt]]))
  expect(byId).toEqual({
    killed: ['aborted', 50],
    failed: ['failed', 50],
    completed: ['done', 50],
    gone: ['aborted', 50],
    goneIdle: ['done', 50],
    nowIdle: ['idle', 50],
    // Still running by the list: untouched
    waiting: ['running', undefined],
    // Ended rows are left to their next step, however the list reads
    resumed: ['done', 2],
  })
  // Nothing to change: no write
  expect(reconciled([row('r', 'running', 1)], new Map([['r', 'running']]), 50)).toBeUndefined()
})
