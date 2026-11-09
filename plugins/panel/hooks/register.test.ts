import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { On, SessionAppendInput } from 'claude-code'

import { settings, toggled } from './register'
import { GLYPH, width } from './section'

/** $.store beneath the engine: an in-memory map that also records what was written. */
function memoryStore(on: On, entries: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(entries))
  const writes: [string, unknown][] = []
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    writes.push([e.key, e.value])
    return { value: undefined }
  })
  return writes
}

const PANE = {
  plugin: 'panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'panel',
  props: {
    title: 'panel',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** Producer tools beneath the plugin answer with the input's body; registered before the test's first $ call. */
const echoProducers = (on: On) =>
  on('tool.call', { tool: /^(?:Artifact|mcp__.*)$/ }, (_$, e) => ({ result: {}, text: String((e as Record<string, unknown>).body ?? '') }) as never)

/** A producer tool's call: the plugin reads its links in tool.call, where the input is visible. */
const produce = ($: Parameters<TestBody>[0], text: string, tool = 'Artifact', input: Record<string, unknown> = {}) =>
  $.tool.call({ tool, body: text, ...input } as never)

/** API usage of one response */
const usageOf = (input: number, cacheRead: number, output: number) => ({
  model: 'claude-haiku-5-5',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
})

/** turn.step beneath the plugin: each request answers with the next queued usage, none once the queue is empty */
function stepReplies(on: On) {
  const usages: ReturnType<typeof usageOf>[] = []
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usages.shift() ?? null } as never
  })
  return usages
}

/** One request of an agent's loop; a new turnId is a new run */
async function step($: Parameters<TestBody>[0], agentId: string, turnId = 't') {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId } as never));
}

test('toggles a section in and out of the collapsed set', async () => {
  expect(toggled([], 'git')).toEqual(['git'])
  expect(toggled(['git', 'links'], 'git')).toEqual(['links'])
})

test('draws links found in the conversation and folds a section on press', async ($, on) => {
  echoProducers(on)
  const writes = memoryStore(on)
  mock.clock(on)
  await produce($, 'Plan: [Sidebar plan](https://claude.ai/code/artifact/x) https://github.com/acme/app/pull/7')
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Link', text: 'Sidebar plan' }))?.props.href).toBe('https://claude.ai/code/artifact/x')
  expect(await ui.find({ type: 'Link', text: '#7' })).toBeDefined()
  // Agents has the main row, so no "—"; no section but Links is empty
  expect(await ui.find({ type: 'Text', text: /^  —$/ })).toBeUndefined()

  await ui.press({ key: 'toggle:links' })
  expect(await ui.find({ type: 'Link', text: 'Sidebar plan' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle:links' }))?.text).toBe('▸ Links')
  expect(writes).toEqual([['collapsed', ['links']]])

  await ui.press({ key: 'toggle:links' })
  expect(await ui.find({ type: 'Link', text: 'Sidebar plan' })).toBeDefined()
})

test('restores the folded sections a previous session saved', async ($, on) => {
  mock.clock(on)
  memoryStore(on, { collapsed: ['agents'], isOpen: false })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'toggle:agents' }))?.text).toBe('▸ Agents')
  expect((await ui.find({ key: 'toggle:git' }))?.text).toBe('▾ GitHub')
})

/** A Link's text is its href plus its children's text; the title sits in a child Text (the hover style has to hang on a Text) */
const linkLabel = (link: { text: string; props: Record<string, unknown> } | undefined) =>
  link?.text.slice(String(link.props.href).length)

const toolResult = (text: string): SessionAppendInput => ({
  uuid: `u-${text.length}`,
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Artifact' },
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
})

test('collects only what the session produced or operated on', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  const outputs: Record<string, string> = {
    'echo https://docs.dev/echo https://github.com/acme/app/pull/1': 'https://docs.dev/echo https://github.com/acme/app/pull/1',
    'gh pr create --fill': 'https://github.com/acme/app/pull/7',
    'gh pr merge 9 -R acme/app --squash': '✓ Merged pull request acme/app#9',
    'gh pr view 5 --repo acme/lib': 'title: Fix\nurl: https://github.com/acme/lib/pull/5\nsee https://docs.dev/body',
  }
  on('tool.call', { tool: 'Bash' }, (_$, e) => ({ result: {}, text: outputs[e.command] ?? '' }) as never)
  const user = (door: 'prompt' | 'response', text: string): SessionAppendInput => ({
    uuid: `${door}-${text.length}`,
    door,
    origin: door === 'prompt' ? { kind: 'composer' } : { kind: 'model', model: 'm' },
    message: door === 'prompt' ? { type: 'user', role: 'user', content: [{ type: 'text', text }] } : { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  })
  await $.session.append(user('prompt', 'Look at [Spec](https://docs.dev/spec)'))
  await $.session.append(user('response', 'The reply mentions https://docs.dev/reply'))
  await $.session.append({ ...toolResult('https://docs.dev/read'), origin: { kind: 'tool', tool: 'Read' } })
  await produce($, 'Published plan.html (private) at https://claude.ai/code/artifact/p1')
  for (const command of Object.keys(outputs)) await $.tool.call({ tool: 'Bash', tool_use_id: command, command } as never)
  // Plain Bash result rows are not collected either
  await $.session.append({ ...toolResult('https://docs.dev/bash-row'), origin: { kind: 'tool', tool: 'Bash' } })

  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['#5', '#9', '#7', 'plan', 'Spec'])
})

test('shows six links and folds the rest into +N more', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  // One site per link, none reaches three, so no tabs
  const text = Array.from({ length: 8 }, (_, i) => `[Doc ${i}](https://d${i}.dev/x)`).join('\n')
  await produce($, text)
  const ui = await $.ui.mount(PANE)
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(6)
  expect((await ui.find({ key: 'more:links' }))?.text).toBe('+2 more')

  await ui.press({ key: 'more:links' })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(8)
  expect((await ui.find({ key: 'more:links' }))?.text).toBe('Show less')
})

test('leaves out a section switched off in settings', { options: { showGit: false, showSession: false } }, async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, 'https://github.com/acme/app/pull/7 and [Doc](https://docs.dev/a)')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'toggle:git' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: '#7' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle:links' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
})

test('reads width and switches from options with defaults', async () => {
  expect(settings({})).toEqual({
    session: true,
    agents: true,
    git: true,
    links: true,
    width: 46,
    agentsKeep: 10,
    gitSort: 'attention',
    sessionLines: ['dir', 'model', 'context', '5h', 'week'],
    sessionBars: true,
    sessionTheme: 'gruvbox',
    autoOpen: true,
    visibleRows: 6,
    tabThreshold: 3,
    ghRefreshSeconds: 60,
  })
  expect(settings({ sessionTheme: 'hud', sessionBars: false })).toMatchObject({ sessionTheme: 'hud', sessionBars: false })
  expect(settings({ sessionTheme: 'bogus' }).sessionTheme).toBe('gruvbox')
  expect(settings({ gitSort: 'repo' }).gitSort).toBe('repo')
  expect(settings({ gitSort: 'bogus' }).gitSort).toBe('attention')
  expect(settings({ showLinks: false, width: 56 })).toMatchObject({ links: false, width: 56 })
  expect(settings({ width: 0 }).width).toBe(46)
  expect(settings({ agentsKeep: 0 }).agentsKeep).toBe(0)
  expect(settings({ agentsKeep: -1 }).agentsKeep).toBe(10)
  expect(settings({ agentsKeep: 2.5 }).agentsKeep).toBe(10)
})

test('reads the open, row, tab and refresh options, falling back on bad values', async () => {
  expect(settings({ autoOpen: false, visibleRows: 3, tabThreshold: 2, ghRefreshSeconds: 0 })).toMatchObject({
    autoOpen: false,
    visibleRows: 3,
    tabThreshold: 2,
    ghRefreshSeconds: 0,
  })
  expect(settings({ visibleRows: 0, tabThreshold: -1, ghRefreshSeconds: -5 })).toMatchObject({ visibleRows: 6, tabThreshold: 3, ghRefreshSeconds: 60 })
  expect(settings({ visibleRows: 2.5, tabThreshold: 'x', ghRefreshSeconds: 1.5 })).toMatchObject({ visibleRows: 6, tabThreshold: 3, ghRefreshSeconds: 60 })
})

test('hides a dismissed row from both Git and Links for this session', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, 'https://github.com/acme/app/pull/7 and [Doc](https://docs.dev/a)')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'dismiss:https://docs.dev/a' })
  expect(await ui.find({ type: 'Link', text: 'Doc' })).toBeUndefined()
  await ui.press({ key: 'dismiss:acme/app/pull/7' })
  expect(await ui.find({ type: 'Link', text: '#7' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle:git' }))?.text).toBe('▾ GitHub')
  // GitHub and Links are empty; Agents still has the main row
  expect(await ui.findAll({ type: 'Text', text: /^  —$/ })).toHaveLength(2)
})

test('draws a link as description plus full URL, with a copy button', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, '[A very long description that runs well past forty columns](https://docs.dev/a)')
  const ui = await $.ui.mount(PANE)
  const label = String(linkLabel(await ui.find({ type: 'Link' })))
  // 40 columns - icon 2 - " copy ×" 4, plus the trailing …
  expect(label.endsWith('…')).toBe(true)
  expect(width(label)).toBeLessThanOrEqual(34)
  expect(await ui.find({ type: 'Text', text: /https:\/\/docs\.dev\/a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: `${GLYPH.link} ` })).toBeDefined()
  expect((await ui.find({ key: 'copy:https://docs.dev/a' }))?.text).toBe(GLYPH.copy)
})

/** The selected tab is an inverse Text (padded a cell each side), the rest gray Buttons: returns each tab's text and whether it is selected */
const tabsOf = async (ui: { findAll: (q: object) => Promise<{ text: string; props: Record<string, unknown> }[]> }) =>
  [...(await ui.findAll({ type: 'Text', text: /^ (PR|Issue|Others) \d+ $/ })), ...(await ui.findAll({ type: 'Button', text: /^ (PR|Issue|Others) \d+ $/ }))]
    .map(node => `${node.text.trim()}${node.props.inverse ? '*' : ''}${node.props.dimColor ? ' dim' : ''}`)
    .sort()

test('splits GitHub into PR / Issue / Others tabs and remembers the pick', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  const writes = memoryStore(on)
  await produce($, 'https://github.com/acme/app/issues/3 https://github.com/acme/app/pull/7 https://github.com/acme/app/blob/main/a.ts [Doc](https://docs.dev/a)')
  const ui = await $.ui.mount(PANE)
  expect(await tabsOf(ui)).toEqual(['Issue 1 dim', 'Others 1 dim', 'PR 1*'])
  // The section count is the sum of all three; Links no longer has github.com
  expect(await ui.find({ type: 'Text', text: ' 3' })).toBeDefined()
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['#7', 'Doc'])

  await ui.press({ key: 'tab:git:repo' })
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['acme/app · main/a.ts', 'Doc'])
  expect(await ui.find({ type: 'Text', text: `${GLYPH.repo} ` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^https:\/\/github\.com\/acme\/app\/blob.*…$/ })).toBeDefined()
  expect(await tabsOf(ui)).toEqual(['Issue 1 dim', 'Others 1*', 'PR 1 dim'])
  expect(writes).toContainEqual(['gitTab', 'repo'])
})

test('restores the GitHub tab a previous session picked', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on, { gitTab: 'issue', isOpen: false })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await produce($, 'https://github.com/acme/app/issues/3 https://github.com/acme/app/pull/7')
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['#3'])
})

test('lands on the first tab with rows while PR is empty, and still shows the empty tab', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, 'https://github.com/acme/app https://github.com/acme/app/issues/3')
  const ui = await $.ui.mount(PANE)
  expect(await tabsOf(ui)).toEqual(['Issue 1*', 'Others 1 dim', 'PR 0 dim'])
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['#3'])
  // The selected tab was emptied by dismissing, so the next one with rows takes over
  await ui.press({ key: 'dismiss:acme/app/issues/3' })
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['acme/app'])
})

test('folds each GitHub tab into its own +N more', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  const prs = Array.from({ length: 7 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`).join(' ')
  const repos = Array.from({ length: 8 }, (_, i) => `https://github.com/acme/r${i}`).join(' ')
  await produce($, `${prs} ${repos} https://github.com/acme/app/issues/9`)
  const ui = await $.ui.mount(PANE)
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(6)
  expect((await ui.find({ key: 'more:git:pr' }))?.text).toBe('+1 more')
  expect(await ui.find({ key: 'more:git' })).toBeUndefined()

  await ui.press({ key: 'more:git:pr' })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(7)
  expect((await ui.find({ key: 'more:git:pr' }))?.text).toBe('Show less')

  await ui.press({ key: 'tab:git:repo' })
  expect((await ui.find({ key: 'more:git:repo' }))?.text).toBe('+2 more')
  await ui.press({ key: 'tab:git:issue' })
  expect(await ui.find({ key: 'more:git:issue' })).toBeUndefined()
})

test('keeps the status column empty until gh answers, never "Unknown"', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, 'https://github.com/acme/app/pull/7 https://github.com/acme/lib/pull/2')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /acme\/lib/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: '#2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Unknown/ })).toBeUndefined()
})

test('puts the main session first in Agents, outside the count', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^● $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
  // With no subagents the main row fills the section, so no "—"; main is not counted
  expect(await ui.findAll({ type: 'Text', text: /^  —$/ })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^ 0$/ })).toBeDefined()
})

test('marks the main row busy between a main turn start and its end', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const ui = await $.ui.mount(PANE)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await ui.find({ type: 'Text', text: /^◐ $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\d+s · Running$/ })).toBeDefined()
  // A subagent's turn ending does not count
  await $.turn.complete({ turnId: 't1', agentId: 'a1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(await ui.find({ type: 'Text', text: /^◐ $/ })).toBeDefined()
  const usage = { model: 'claude-fable-5-1', input_tokens: 1, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage } as never)
  expect(await ui.find({ type: 'Text', text: /^● $/ })).toBeDefined()
  // That subagent turn's tokens do not count toward main
  expect(await ui.find({ type: 'Text', text: /^↓ 1\.0k · Idle$/ })).toBeDefined()
})

test('lists a subagent with model, effort from its call, and opens the tasks list on its name', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  const ran: string[] = []
  const toasts: string[] = []
  on('command.run', (_$, e) => (ran.push(e.command), { text: '' }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }) as never)
  on('turn.complete', () => ({ text: '' }))
  const usages = stepReplies(on)
  // In the engine, spawn happens inside the Agent tool call's next
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    await $.agent.spawn({
      tool_use_id: e.tool_use_id ?? '',
      prompt: e.prompt,
      description: e.description,
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-fable-5-1',
      background: true,
      fork: false,
    })
    return { result: 'launched' } as never
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'Count lines in files', prompt: 'wc -l', effort: 'high' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'Count lines in files · Haiku 5.5 · high' })).toBeDefined()
  // The mock clock starts at 0, and startedAt 0 means "start unknown": no duration
  expect(await ui.find({ type: 'Text', text: /^Running$/ })).toBeDefined()
  expect((await ui.find({ key: 'open:agent-a1' }))?.text).toBe('general-purpose')
  expect(await ui.find({ type: 'Text', text: /^ 1$/ })).toBeDefined()

  // As the tasks bar counts: the last request's whole input plus the run's summed output; a request with no usage changes nothing
  usages.push(usageOf(1_000, 20_000, 500), usageOf(1_000, 30_000, 700))
  await step($, 'a1')
  expect(await ui.find({ type: 'Text', text: /^↓ 21\.5k · Running$/ })).toBeDefined()
  await step($, 'a1')
  await step($, 'a1')
  expect(await ui.find({ type: 'Text', text: /^↓ 32\.2k · Running$/ })).toBeDefined()
  // Interrupted: Aborted, and turn.complete adds no tokens of its own
  await $.turn.complete({ turnId: 't', agentId: 'a1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted', usage: usageOf(1, 0, 9_000) } as never)
  expect(await ui.find({ type: 'Text', text: /^↓ 32\.2k · Aborted$/ })).toBeDefined()

  await ui.press({ key: 'open:agent-a1' })
  expect(ran).toEqual(['tasks'])
  expect(toasts).toEqual(['Pick it in the tasks list'])
})

test('puts git branch and changes on the directory line, with no Git line of its own', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  on('session.root', () => ({ value: '/home/me/code/app' })) // guard:allow fixture home path
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { context: { percent: 20 }, rateLimits: [] } }) as never)
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_$, e) => {
    const stdout = e.argv.includes('--porcelain') ? ' M a.ts\n?? b.ts\n' : 'main\n'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('session.measure', () => ({ changed: [] }))
  const ui = await $.ui.mount(PANE)
  await $.session.measure({ context: { percent: 20 }, rateLimits: [] } as never)
  expect((await ui.find({ type: 'Text', text: /^~\/code\/app/ }))?.text).toBe('~/code/app · main* · 2 modified')
  expect(await ui.find({ type: 'Text', text: /^Git / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Fable 5\.1$/ })).toBeDefined()
})

/** A teammate this plugin's agent.spawn never saw: on the engine list, not on the panel's */
function teammateOnEngineList(on: On) {
  const status = { now: 'running' as 'running' | 'idle' }
  on('agent.list', () => ({ value: [{ id: 'tm1', teammateId: 'scout@team', name: 'scout', description: 'Watch CI', type: 'teammate', status: status.now }] }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: '' }))
  stepReplies(on)
  return status
}

test('keeps running durations moving once a second', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  memoryStore(on, { isOpen: false })
  teammateOnEngineList(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($, 'tm1')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^0s · Running$/ })).toBeDefined()
  // No other write in between: only tick redraws
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /^3s · Running$/ })).toBeDefined()
})

test('adds a row for an agent the engine lists but the panel never saw, and follows a teammate waking and idling', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  memoryStore(on)
  const status = teammateOnEngineList(on)
  const ui = await $.ui.mount(PANE)
  // Woken by SendMessage: its first step adds the row
  await step($, 'tm1', 't1')
  expect((await ui.find({ key: 'open:agent-tm1' }))?.text).toBe('scout')
  expect(await ui.find({ type: 'Text', text: 'Watch CI' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Running$/ })).toBeDefined()

  status.now = 'idle'
  await $.turn.complete({ turnId: 't', agentId: 'tm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(await ui.find({ type: 'Text', text: /Idle$/ })).toBeDefined()

  // Woken again: back to running, no duplicate row
  status.now = 'running'
  await step($, 'tm1', 't2')
  expect(await ui.find({ type: 'Text', text: /Running$/ })).toBeDefined()
  expect(await ui.findAll({ key: 'open:agent-tm1' })).toHaveLength(1)
})

test('turns the copy button into a check for two seconds after a copy', async ($, on) => {
  echoProducers(on)
  const clock = mock.clock(on)
  memoryStore(on)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('ui.toast', () => ({ value: undefined }))
  await produce($, '[Doc](https://docs.dev/a) [Other](https://docs.dev/b)')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'copy:https://docs.dev/a' })
  expect((await ui.find({ key: 'copy:https://docs.dev/a' }))?.text).toBe(GLYPH.check)
  // Other rows are untouched
  expect((await ui.find({ key: 'copy:https://docs.dev/b' }))?.text).toBe(GLYPH.copy)
  await clock.advance(1_999)
  expect((await ui.find({ key: 'copy:https://docs.dev/a' }))?.text).toBe(GLYPH.check)
  await clock.advance(1)
  expect((await ui.find({ key: 'copy:https://docs.dev/a' }))?.text).toBe(GLYPH.copy)
})

test('picks the PR glyph by state and colors it like the state word', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, 'https://github.com/acme/app/pull/7 https://github.com/acme/app/issues/3')
  const ui = await $.ui.mount(PANE)
  // State not fetched yet: the open PR glyph, in gray
  const pr = await ui.find({ type: 'Text', text: `${GLYPH.pr} ` })
  expect(pr?.props.dimColor).toBe(true)
  await ui.press({ key: 'tab:git:issue' })
  expect(await ui.find({ type: 'Text', text: `${GLYPH.issue} ` })).toBeDefined()
})

test('takes effort from the main thread turn step, not a subagent one', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' } as never
  })
  const ui = await $.ui.mount(PANE)
  const step = (effort: string, agentId?: string) =>
    $.turn.step({ turnId: 't', index: 0, model: 'claude-fable-5-1', effort, messageCount: 1, agentId } as never)
  for await (const _ of step('low', 'a1'));
  expect(await ui.find({ type: 'Text', text: 'low' })).toBeUndefined()
  for await (const _ of step('high'));
  expect(await ui.find({ type: 'Text', text: 'high' })).toBeDefined()
})

test('fills PR status from gh, keeps the last title when gh fails, then stops asking', async ($, on) => {
  echoProducers(on)
  const clock = mock.clock(on)
  memoryStore(on, { isOpen: false })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const gh = { calls: 0, reply: { exitCode: 0, stdout: JSON.stringify({ title: 'Fix login', state: 'OPEN', reviewDecision: 'APPROVED' }), stderr: '' } }
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'gh') return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
    gh.calls++
    return { value: gh.reply } as never
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await produce($, 'https://github.com/acme/app/pull/7')
  await clock.advance(1)
  const ui = await $.ui.mount(PANE)
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('#7 Fix login')
  expect(await ui.find({ type: 'Text', text: 'Approved' })).toBeDefined()

  // The timed re-poll fails: the state word goes, the title stays
  gh.reply = { exitCode: 1, stdout: '', stderr: '' }
  await clock.advance(60_000)
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('#7 Fix login')
  expect(await ui.find({ type: 'Text', text: 'Approved' })).toBeUndefined()

  // Unknown is terminal: gh is not asked again
  const asked = gh.calls
  await clock.advance(60_000)
  expect(gh.calls).toBe(asked)
})

test('/panel closes a placed pane and opens one that is not, remembering the choice', async ($, on) => {
  const writes = memoryStore(on)
  const pane = { isPlaced: true }
  on('ui.panes', () => ({ value: [{ id: 'panel', title: 'panel', isPlaced: pane.isPlaced }] }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  expect(await $.command.run({ command: 'panel' } as never)).toMatchObject({ text: 'Panel closed' })
  pane.isPlaced = false
  expect(await $.command.run({ command: 'panel' } as never)).toMatchObject({ text: 'Panel opened' })
  expect(writes).toEqual([
    ['isOpen', false],
    ['isOpen', true],
  ])
})

/** Plain subagents on the engine list, their status set by the test; this plugin's agent.spawn never saw them, so each gets a row on its first action */
function subagentsOnEngineList(on: On, status: Record<string, string>) {
  on('agent.list', () => ({ value: Object.entries(status).map(([id, s]) => ({ id, name: id, description: '', type: 'general-purpose', status: s })) }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', () => ({ text: '' }))
  return stepReplies(on)
}

const finish = (agentId: string, reason = 'answer') =>
  ({ turnId: 't', agentId, answer: '', durationMs: 1, isAborted: reason === 'aborted', reason }) as never

test('settles a stopped agent from the engine list even with no turn.complete, or one a late tool call follows', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const status: Record<string, string> = { stopped: 'running', killed: 'running', late: 'running', gone: 'running', busy: 'running' }
  subagentsOnEngineList(on, status)
  await startSession($, on, { isOpen: false })
  for (const id of Object.keys(status)) await step($, id)
  const ui = await $.ui.mount(PANE)

  // Stopped by the person / killed by TaskStop: no event at all, only the list says killed
  status.stopped = status.killed = 'killed'
  // A turn.complete with the list still lagging, then a tool call of that run landing after it: the tool call no longer revives the row
  await $.turn.complete(finish('late', 'aborted'))
  await $.tool.call({ tool: 'Bash', agentId: 'late', command: 'ls' } as never)
  status.late = 'killed'
  // Ended and already dropped from the list, its end never seen
  delete status.gone
  expect(await ui.findAll({ type: 'Text', text: /Running$/ })).toHaveLength(4)

  await clock.advance(2_000)
  expect(await ui.findAll({ type: 'Text', text: /Running$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /Aborted$/ })).toHaveLength(4)
})

test('restarts duration and tokens when SendMessage resumes an agent that failed on an API error, as the tasks bar does', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const status: Record<string, string> = { a1: 'running' }
  const usages = subagentsOnEngineList(on, status)
  await startSession($, on, { isOpen: false })
  usages.push(usageOf(1_000, 100_000, 2_000))
  await step($, 'a1', 'run1')
  await clock.advance(60 * 60_000)
  status.a1 = 'failed'
  await $.turn.complete(finish('a1', 'error'))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '1h · ↓ 103.0k · Failed' })).toBeDefined()

  // Resumed ten minutes later: a new run, timed and counted from its own first request
  await clock.advance(10 * 60_000)
  status.a1 = 'running'
  usages.push(usageOf(500, 140_000, 300), usageOf(500, 150_000, 200))
  await step($, 'a1', 'run2')
  await clock.advance(5 * 60_000)
  await step($, 'a1', 'run2')
  expect(await ui.find({ type: 'Text', text: '5m · ↓ 151.0k · Running' })).toBeDefined()
  // The list agrees it runs: reconcile leaves it be
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /^5m 2s · ↓ 151\.0k · Running$/ })).toBeDefined()
})

test('folds finished agents into a summary line after agentsKeep and expands it on press', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  memoryStore(on)
  const status: Record<string, string> = { a1: 'running', a2: 'running', a3: 'running' }
  const usages = subagentsOnEngineList(on, status)
  usages.push(usageOf(0, 0, 1000))
  for (const id of ['a1', 'a2', 'a3']) await step($, id)
  status.a1 = 'completed'
  await $.turn.complete(finish('a1', 'answer'))
  status.a2 = 'failed'
  await $.turn.complete(finish('a2', 'error'))
  // Kept 10 minutes by default: Done folds into the summary, Failed keeps its row, running ones stay
  await clock.advance(10 * 60_000)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'open:agent-a1' })).toBeUndefined()
  expect(await ui.find({ key: 'open:agent-a2' })).toBeDefined()
  expect(await ui.find({ key: 'open:agent-a3' })).toBeDefined()
  expect((await ui.find({ key: 'more:agents:history' }))?.text).toBe('✓ 1 done · ↓ 1.0k')
  expect(await ui.find({ key: 'more:agents' })).toBeUndefined()
  // The count covers only rows of their own
  expect(await ui.find({ type: 'Text', text: /^ 2$/ })).toBeDefined()

  await ui.press({ key: 'more:agents:history' })
  expect(await ui.find({ key: 'open:agent-a1' })).toBeDefined()
  await ui.press({ key: 'more:agents:history' })
  expect(await ui.find({ key: 'open:agent-a1' })).toBeUndefined()
})

test('hides a dismissed agent from rows and summary, and brings it back when it moves again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  memoryStore(on)
  const status: Record<string, string> = { a1: 'running', a2: 'running' }
  subagentsOnEngineList(on, status)
  for (const id of ['a1', 'a2']) await step($, id)
  status.a1 = status.a2 = 'completed'
  await $.turn.complete(finish('a1'))
  await $.turn.complete(finish('a2'))
  await clock.advance(10 * 60_000)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'more:agents:history' }))?.text).toBe('✓ 2 done')
  await ui.press({ key: 'more:agents:history' })
  // The main row has no ×
  expect(await ui.find({ key: 'dismiss:agent:main' })).toBeUndefined()
  await ui.press({ key: 'dismiss:agent:a1' })
  expect(await ui.find({ key: 'open:agent-a1' })).toBeUndefined()
  expect((await ui.find({ key: 'more:agents:history' }))?.text).toBe('✓ 1 done')

  // Resumed by SendMessage: its new run's first step puts it back to Running on its own row
  status.a1 = 'running'
  await step($, 'a1', 't2')
  expect(await ui.find({ key: 'open:agent-a1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Running$/ })).toBeDefined()
  expect((await ui.find({ key: 'more:agents:history' }))?.text).toBe('✓ 1 done')
  expect(await ui.find({ type: 'Text', text: /^ 1$/ })).toBeDefined()
})

/** Links tabs in drawing order: "name count", * on the selected one, dim on gray ones */
const linkTabsOf = async (ui: { findAll: (q: object) => Promise<{ type: string; text: string; props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ text: /^ (Artifact|Slack|Others) \d+ $/ }))
    .filter(node => node.type === 'Text' || node.type === 'Button')
    .map(node => `${node.text.trim()}${node.props.inverse ? '*' : ''}${node.props.dimColor ? ' dim' : ''}`)

const artifacts = (n: number) => Array.from({ length: n }, (_, i) => `[A${i}](https://claude.ai/code/artifact/a${i})`).join('\n')
const SLACK = '[Thread](https://acme.slack.com/archives/C1/p2)'

test('splits Links into a tab per site with three or more links, the rest under Others', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  const writes = memoryStore(on)
  await produce($, `${artifacts(3)}\n${SLACK}`)
  const ui = await $.ui.mount(PANE)
  expect(await linkTabsOf(ui)).toEqual(['Artifact 3*', 'Others 1 dim'])
  // Later in the same text comes first (merge puts the newest first)
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['A2', 'A1', 'A0'])
  // The section count is the sum of all tabs
  expect(await ui.find({ type: 'Text', text: ' 4' })).toBeDefined()

  await ui.press({ key: 'tab:links:others' })
  expect(await linkTabsOf(ui)).toEqual(['Artifact 3 dim', 'Others 1*'])
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['Thread'])
  // This session only
  expect(writes.filter(([key]) => key === 'linksTab')).toEqual([])
})

test('keeps Links flat while no site reaches three', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, `${artifacts(2)}\n${SLACK}`)
  const ui = await $.ui.mount(PANE)
  expect(await linkTabsOf(ui)).toEqual([])
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['Thread', 'A1', 'A0'])
})

test('drops the Links tabs once a dismissed row leaves no site at three', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, `${artifacts(3)}\n${SLACK}`)
  const ui = await $.ui.mount(PANE)
  expect(await linkTabsOf(ui)).toEqual(['Artifact 3*', 'Others 1 dim'])
  await ui.press({ key: 'dismiss:https://claude.ai/code/artifact/a0' })
  expect(await linkTabsOf(ui)).toEqual([])
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['Thread', 'A2', 'A1'])
})

test('orders Links tabs by size with Others last, each with its own +N more', async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  const slack = Array.from({ length: 3 }, (_, i) => `[T${i}](https://acme.slack.com/archives/C1/p${i})`).join('\n')
  await produce($, `${slack}\n${artifacts(8)}`)
  const ui = await $.ui.mount(PANE)
  expect(await linkTabsOf(ui)).toEqual(['Artifact 8*', 'Slack 3 dim', 'Others 0 dim'])
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(6)
  expect((await ui.find({ key: 'more:links:artifact' }))?.text).toBe('+2 more')
  expect(await ui.find({ key: 'more:links' })).toBeUndefined()

  await ui.press({ key: 'tab:links:slack.com' })
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['T2', 'T1', 'T0'])
  expect(await ui.find({ key: 'more:links:slack.com' })).toBeUndefined()
})

/** Starts an interactive terminal session; returns the panes it asked to open. */
async function startSession($: Parameters<TestBody>[0], on: On, store: Record<string, unknown> = {}) {
  memoryStore(on, store)
  const opened: string[] = []
  on('ui.open', (_$, e) => (opened.push(e.id), { value: { isPlaced: true } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  return opened
}

test('opens the pane on session start by default', async ($, on) => {
  mock.clock(on)
  expect(await startSession($, on)).toEqual(['panel'])
})

test('leaves the pane closed on session start when autoOpen is off', { options: { autoOpen: false } }, async ($, on) => {
  mock.clock(on)
  expect(await startSession($, on)).toEqual([])
})

test('shows visibleRows rows per section and tab before +N more', { options: { visibleRows: 3 } }, async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  const prs = Array.from({ length: 4 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`).join(' ')
  const docs = Array.from({ length: 8 }, (_, i) => `[Doc ${i}](https://d${i}.dev/x)`).join('\n')
  await produce($, `${prs}\n${docs}`)
  const ui = await $.ui.mount(PANE)
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(6)
  expect((await ui.find({ key: 'more:git:pr' }))?.text).toBe('+1 more')
  expect((await ui.find({ key: 'more:links' }))?.text).toBe('+5 more')
})

test('gives a site its own Links tab at tabThreshold links', { options: { tabThreshold: 2 } }, async ($, on) => {
  echoProducers(on)
  mock.clock(on)
  memoryStore(on)
  await produce($, `${artifacts(2)}\n${SLACK}`)
  const ui = await $.ui.mount(PANE)
  expect(await linkTabsOf(ui)).toEqual(['Artifact 2*', 'Others 1 dim'])
})

/** Answers gh with an approved PR (never terminal, so due for every re-poll) and counts the calls. */
function ghCounter(on: On) {
  const gh = { calls: 0 }
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'gh') return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
    gh.calls++
    return { value: { exitCode: 0, stdout: JSON.stringify({ title: 'Fix login', state: 'OPEN', reviewDecision: 'APPROVED' }), stderr: '' } } as never
  })
  return gh
}

test('re-polls open PRs every ghRefreshSeconds', { options: { ghRefreshSeconds: 5 } }, async ($, on) => {
  echoProducers(on)
  const clock = mock.clock(on)
  const gh = ghCounter(on)
  await startSession($, on, { isOpen: false })
  await produce($, 'https://github.com/acme/app/pull/7')
  await clock.advance(1)
  const asked = gh.calls
  expect(asked).toBeGreaterThan(0)
  await clock.advance(5_000)
  expect(gh.calls).toBe(asked + 1)
})

test('asks gh once per PR and never re-polls when ghRefreshSeconds is 0', { options: { ghRefreshSeconds: 0 } }, async ($, on) => {
  echoProducers(on)
  const clock = mock.clock(on)
  const gh = ghCounter(on)
  await startSession($, on, { isOpen: false })
  await produce($, 'https://github.com/acme/app/pull/7')
  await clock.advance(1)
  const asked = gh.calls
  expect(asked).toBeGreaterThan(0)
  await clock.advance(10 * 60_000)
  expect(gh.calls).toBe(asked)
})

test('/panel demo draws the seeded data, opens a closed pane, and turns off again', async ($, on) => {
  echoProducers(on)
  mock.clock(on, { now: 1_000_000 })
  const writes = memoryStore(on)
  const pane = { isPlaced: false }
  const opened: string[] = []
  on('ui.panes', () => ({ value: [{ id: 'panel', title: 'panel', isPlaced: pane.isPlaced }] }) as never)
  on('ui.open', (_$, e) => (opened.push(e.id), (pane.isPlaced = true), { value: { isPlaced: true } }) as never)
  await produce($, '[Doc](https://docs.dev/a)')

  expect(await $.command.run({ command: 'panel', args: 'demo' } as never)).toMatchObject({ text: 'Panel demo on' })
  expect(opened).toEqual(['panel'])
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect((await ui.find({ type: 'Text', text: /^~\/code\/agent-plugins/ }))?.text).toBe('~/code/agent-plugins · main* · 3 modified')
  expect(await ui.find({ type: 'Text', text: /resets in 3h 12m$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resets in 2d 4h$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1m 12s · ↓ 9\.4k · Running$/ })).toBeDefined()
  expect((await ui.find({ key: 'open:agent-demo-explore' }))?.text).toBe('Explore')
  expect((await ui.find({ key: 'more:agents:history' }))?.text).toBe('✓ 6 done · ↓ 48.2k')
  // attention order puts the failing PR first
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('#41 ci: validate and test both plugins')
  // GitHub: PR 6, Issue 2, Others 1; Links: Artifact 3, Others 2
  expect(await tabsOf(ui)).toEqual(['Issue 2 dim', 'Others 1 dim', 'Others 2 dim', 'PR 6*'])
  expect((await ui.find({ type: 'Text', text: ' Artifact 3 ' }))?.props.inverse).toBe(true)
  expect(await ui.find({ type: 'Link', text: 'Doc' })).toBeUndefined()

  // Off again: the session's own data is back, the pane is left as it is, and nothing reached $.store
  expect(await $.command.run({ command: 'panel', args: 'demo' } as never)).toMatchObject({ text: 'Panel demo off' })
  expect(await ui.find({ type: 'Text', text: /agent-plugins/ })).toBeUndefined()
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('Doc')
  expect(opened).toEqual(['panel'])
  expect(writes).toEqual([])
})

test('asks gh nothing while the demo is on', async ($, on) => {
  echoProducers(on)
  const clock = mock.clock(on)
  const gh = ghCounter(on)
  on('ui.panes', () => ({ value: [{ id: 'panel', title: 'panel', isPlaced: true }] }) as never)
  await startSession($, on, { isOpen: false })
  await $.command.run({ command: 'panel', args: 'demo' } as never)
  await produce($, 'https://github.com/acme/app/pull/7')
  await clock.advance(5 * 60_000)
  expect(gh.calls).toBe(0)
})

/** Answers $.model.complete beneath the plugin and records each prompt it was asked. */
function haiku(on: On, answer: (prompt: string) => string | undefined) {
  const asked: string[] = []
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', (_$, e) => {
    asked.push(e.prompt)
    const text = answer(e.prompt)
    return { value: text === undefined ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } : { isAnswered: true, text, usage } } as never
  })
  return asked
}

const prompt = (text: string): SessionAppendInput => ({
  uuid: `p-${text.length}`,
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
})

const THREAD = 'https://acme.slack.com/archives/C1/p2'

test('shows the old description at once, then the model title, asked once per link', async ($, on) => {
  const clock = mock.clock(on)
  memoryStore(on)
  const asked = haiku(on, () => '"\u9650\u6d41\u8ba8\u8bba"')
  await $.session.append(prompt(`Rate limit thread, see: ${THREAD}`))
  const ui = await $.ui.mount(PANE)
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('Rate limit thread')
  await clock.advance(1)
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('\u9650\u6d41\u8ba8\u8bba')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('Rate limit thread')
  // Pasted again: the cached title stands, no second call
  await $.session.append(prompt(`again ${THREAD}`))
  await clock.advance(1)
  expect(asked).toHaveLength(1)
})

test('keeps the old description when the model fails or answers a URL', async ($, on) => {
  const clock = mock.clock(on)
  memoryStore(on)
  haiku(on, text => (text.includes('docs.dev') ? 'https://docs.dev/a' : undefined))
  await $.session.append(prompt(`Rate limit thread, see: ${THREAD}\nThe spec: https://docs.dev/a`))
  await clock.advance(1)
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['The spec', 'Rate limit thread'])
})

test('titles a producer link from the tool input, leaving labelled links alone', async ($, on) => {
  const clock = mock.clock(on)
  memoryStore(on)
  echoProducers(on)
  const asked = haiku(on, () => '\u56de\u590d\u9f99\u9f99\uff1a\u5d29\u6e83\u7edf\u8ba1\u5df2\u4e0a\u7ebf')
  await produce($, `Sent ${THREAD}`, 'mcp__slack__send_message', { message: 'crash stats are live' })
  await produce($, '[Plan](https://docs.dev/plan)')
  await clock.advance(1)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('crash stats are live')
  const ui = await $.ui.mount(PANE)
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['Plan', '\u56de\u590d\u9f99\u9f99\uff1a\u5d29\u6e83\u7edf\u8ba1\u5df2\u4e0a\u7ebf'])
})

test('a rebuild from the transcript reuses cached titles without calling the model', async ($, on) => {
  const clock = mock.clock(on)
  const asked = haiku(on, () => 'Rate limit discussion')
  const transcript = [{ role: 'user', text: `Rate limit thread, see: ${THREAD}`, toolUses: [] }]
  on('session.messages', () => ({ value: transcript }) as never)
  memoryStore(on, { isOpen: false })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.append(prompt(transcript[0]!.text))
  await clock.advance(1)
  expect(asked).toHaveLength(1)
  // Hot reload: session.start rebuilds urls from the transcript
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  expect(asked).toHaveLength(1)
  const ui = await $.ui.mount(PANE)
  expect(linkLabel(await ui.find({ type: 'Link' }))).toBe('Rate limit discussion')
})

test('add_link files a link at the top with its title, over a markdown label, and refuses non-http', async ($, on) => {
  mock.clock(on)
  memoryStore(on, { isOpen: false })
  echoProducers(on)
  const registered: { name: string; isDeferred?: unknown }[] = []
  on('tool.register', (_$, e) => (registered.push(e), { value: { tool: `mcp__panel__${e.name}` } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(registered).toMatchObject([{ name: 'add_link', isDeferred: false }])

  await produce($, '[Report](https://docs.dev/report) [Other](https://docs.dev/other)')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'dismiss:https://docs.dev/report' })
  const added = await $.tool.call({ tool: 'mcp__panel__add_link', url: 'https://docs.dev/report', title: 'Weekly crash report' } as never)
  expect(added.text ?? JSON.stringify(added.result)).not.toContain('https://')
  // Asked for by name: back from \u00d7, at the top, with the given title
  expect((await ui.findAll({ type: 'Link' })).map(linkLabel)).toEqual(['Weekly crash report', 'Other'])

  const refused = await $.tool.call({ tool: 'mcp__panel__add_link', url: 'javascript:alert(1)', title: 'x' } as never)
  expect(refused.deny ?? refused.text).toContain('Only http(s)')
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(2)
})
