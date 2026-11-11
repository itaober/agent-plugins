import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, On, SessionMessage, TurnCompleteReason, TurnUsage } from 'claude-code'

import type { AgentRow, AgentState, FoldId, SessionInfo } from '../../types'
import { duration, item, shortModel, tokenCount } from '../section'
import type { Block, SectionMeta, Tone, View } from '../section'
import { THEMES } from '../theme'
import type { Role } from '../theme'

const agents = atom({ plugin: 'panel', key: 'agents' } as const, [])
/** session is written by sections/session.tsx; declared again under the same key to read the session's effort at dispatch */
const sessionInfo = atom({ plugin: 'panel', key: 'session' } as const, { dir: '', model: '' })
/** The shell writes it on ×; declared again under the same key to bring an agent back when it acts again */
const dismissed = atom({ plugin: 'panel', key: 'dismissed' } as const, [])

const LIMIT = 50
/** The id in expanded that marks the summary line open */
export const HISTORY: FoldId = 'agents:history'
/** Failed / Aborted stay several times longer than Done: errors are likelier to need a second look */
const FAILED_KEEP = 6
/** An agent's key in dismissed; never collides with a UrlEntry.key */
export const dismissKey = (id: string) => `agent:${id}`
const LABEL: Record<AgentState, string> = { running: 'Running', idle: 'Idle', done: 'Done', failed: 'Failed', aborted: 'Aborted' }
const ICON: Record<AgentState, string> = { running: '◐', idle: '◌', done: '✓', failed: '✗', aborted: '⊘' }
const TONE: Record<AgentState, Tone> = { running: 'run', idle: 'dim', done: 'ok', failed: 'bad', aborted: 'dim' }

/** Running first, the rest by end time, newest first; keeps LIMIT rows. */
export function sortAgents(list: AgentRow[]) {
  const running = list.filter(a => a.state === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const rest = list
    .filter(a => a.state !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...running, ...rest].slice(0, LIMIT)
}

const LISTED: Partial<Record<AgentStatus, AgentState>> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'aborted',
}

/**
 * State after a turn ends: the engine's list when it no longer says running; if it still does (turn just ended, list lagging), infer from reason.
 * A teammate that answers a turn goes back to idle, not done.
 */
export function settledState(listed: AgentStatus | undefined, reason: TurnCompleteReason, kind: AgentRow['kind']): AgentState {
  const state = listed && LISTED[listed]
  if (state && state !== 'running') return state
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error' || reason === 'refusal') return 'failed'
  return kind === 'teammate' ? 'idle' : 'done'
}

/**
 * Rebuilt from the conversation: one row per Agent call with an agentId, newest first; the start time is unknown, so startedAt is 0 (no duration).
 * The engine's state if it still lists the agent; otherwise (a previous process's) from the call: a result is done, an error failed, no result interrupted.
 */
export function agentsFromMessages(messages: readonly SessionMessage[], listed: ReadonlyMap<string, AgentStatus>) {
  const rows: AgentRow[] = []
  for (const use of messages.flatMap(m => m.toolUses)) {
    if (use.tool !== 'Agent' || !use.agentId) continue
    const { name, description, subagent_type: type, model, effort } = use.input
    const status = listed.get(use.agentId)
    const ended: AgentState = use.result === undefined && use.text === undefined ? 'aborted' : use.isError ? 'failed' : 'done'
    rows.unshift({
      id: use.agentId,
      title: String(name ?? type ?? 'general-purpose'),
      description: typeof description === 'string' ? description : undefined,
      kind: type === 'fork' ? 'fork' : undefined,
      model: typeof model === 'string' ? shortModel(model) : undefined,
      effort: typeof effort === 'string' ? effort : undefined,
      state: (status && LISTED[status]) ?? ended,
      startedAt: 0,
    })
  }
  return sortAgents(rows)
}

/**
 * Joins rows gathered apart (the atom, a transcript rebuild, a saved copy), one per id: a row timed in a live process (startedAt > 0) wins,
 * a row rebuilt from the transcript (startedAt 0) gives way to more's, which knows at least as much.
 */
export function mergeAgents(list: readonly AgentRow[], more: readonly AgentRow[]) {
  const seen = new Set<string>()
  const rows = [...list.filter(a => a.startedAt > 0), ...more, ...list]
  return sortAgents(rows.filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true))))
}

/**
 * Folded into the summary line: finished and past the keep period. Judged at draw time, the atom untouched; keepMs 0 folds nothing.
 * A finished row with no end time (rebuilt from the transcript) folds at once; a backfilled row's start time stands in for its end.
 */
export function isHistory(a: AgentRow, now: number, keepMs: number) {
  if (keepMs === 0 || a.state === 'running' || a.state === 'idle') return false
  const ended = a.endedAt ?? (a.startedAt || undefined)
  if (ended === undefined) return true
  return now - ended >= (a.state === 'done' ? keepMs : FAILED_KEEP * keepMs)
}

/** Summary line: ✓ 12 done · ✗ 1 failed · ↓ 184.0k; Aborted counts as failed, zero parts are left out, tokens add up these rows. */
export function historyLine(rows: AgentRow[]) {
  const done = rows.filter(a => a.state === 'done').length
  const failed = rows.length - done
  const tokens = rows.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
  return [done && `✓ ${done} done`, failed && `✗ ${failed} failed`, tokens && `↓ ${tokenCount(tokens)}`].filter(Boolean).join(' · ')
}

const patch = (list: AgentRow[], id: string, change: (row: AgentRow) => AgentRow) =>
  sortAgents(list.map(row => (row.id === id ? change(row) : row)))

/**
 * A step of the agent's loop is about to run, so it is running. A turnId the row has not seen starts a new run (the spawn, or a resume by SendMessage
 * after Done / Failed / Aborted): duration and tokens start over, as Claude's tasks bar registers a resumed agent afresh.
 */
export function stepStarted(row: AgentRow, turnId: string, now: number): AgentRow {
  const run = row.turnId === turnId ? {} : { turnId, startedAt: now, tokens: undefined, outputTokens: undefined }
  return { ...row, ...run, state: 'running', endedAt: undefined }
}

/** The tasks bar's count after a response: that request's whole input (uncached + cache written + cache read) plus the run's output so far. */
export function stepCounted(row: AgentRow, usage: TurnUsage): AgentRow {
  const outputTokens = (row.outputTokens ?? 0) + usage.output_tokens
  const input = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  return { ...row, outputTokens, tokens: input + outputTokens }
}

const isLive = (a: AgentRow) => a.state === 'running' || a.state === 'idle'

/**
 * Live rows (running / idle) checked against $.agent.list(), the source of truth; undefined when nothing changes.
 * There is no event for a stop (TaskStop, the person stopping it), and a turn.complete can be overtaken by events of the run it ends, so the list settles it:
 * a status that has ended (or a teammate gone idle) is taken as is. One the list no longer has was dropped after it ended, how is not known:
 * a running row becomes Aborted (an end that sent no turn.complete was a stop), an idle teammate Done. A row the list says runs again is left to its next step.
 */
export function reconciled(list: AgentRow[], listed: ReadonlyMap<string, AgentStatus>, now: number) {
  let changed = false
  const next = list.map(row => {
    if (!isLive(row)) return row
    const status = listed.get(row.id)
    const state: AgentState | undefined = status === undefined ? (row.state === 'running' ? 'aborted' : 'done') : LISTED[status]
    if (!state || state === 'running' || state === row.state) return row
    changed = true
    return { ...row, state, endedAt: now }
  })
  return changed ? sortAgents(next) : undefined
}

const RECONCILE_MS = 2000

/** Asks the engine only while a row is live, so an idle panel makes no calls. */
async function reconcile($: EngineInterface) {
  if (!(await read($, agents)).some(isLive)) return
  const listed = new Map((await $.agent.list()).map(a => [a.id, a.status]))
  const now = await $.clock.now()
  if (!reconciled(await read($, agents), listed, now)) return
  await update($, agents, list => reconciled(list, listed, now) ?? list)
}

/** An agent this plugin's agent.spawn never saw (running before a module reload, a teammate woken by SendMessage) gets a row from the engine list; its start time can only be now. */
function rowFromInfo(info: AgentInfo, now: number): AgentRow {
  return {
    id: info.id,
    title: info.name ?? info.type,
    description: info.description || undefined,
    kind: info.teammateId ? 'teammate' : info.type === 'fork' ? 'fork' : undefined,
    state: LISTED[info.status] ?? 'running',
    startedAt: now,
  }
}

// ponytail: ids the engine does not list (workflow agents, the engine's own forks such as compaction) are remembered so their every step does not query $.agent.list(); cleared on reload, at most one extra query each
const unlisted = new Set<string>()

/** If the list lacks this id, fill it in from the engine list; if the engine does not list it either, let it be. */
async function ensureRow($: EngineInterface, id: string) {
  if (unlisted.has(id) || (await read($, agents)).some(a => a.id === id)) return
  const info = (await $.agent.list()).find(a => a.id === id)
  if (!info) {
    unlisted.add(id)
    return
  }
  const row = rowFromInfo(info, await $.clock.now())
  await update($, agents, list => (list.some(a => a.id === id) ? list : sortAgents([row, ...list])))
}

// ponytail: agent.spawn carries no effort, only the Agent tool call does; it is handed from call to spawn by tool_use_id and dropped when the call ends. Cleared on reload, losing at most one row's effort
const effortByCall = new Map<string, string | undefined>()

/** An agent that acts again comes out of dismissed: × only hides it on the pane, and a teammate woken by SendMessage shows as usual. */
async function restore($: EngineInterface, id: string) {
  const key = dismissKey(id)
  // Read before writing: every step lands here, and writing when nothing is hidden would redraw for nothing
  if ((await read($, dismissed)).includes(key)) await update($, dismissed, list => list.filter(k => k !== key))
}

/** Hooks its own events and writes only its own atom (except dismissed, from which it only removes the `agent:<id>` keys this section put there). */
export function register(on: On) {
  // spawn happens inside this call's next, so note the effort argument first
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const callId = e.tool_use_id
    if (!callId) return next(e)
    effortByCall.set(callId, e.effort)
    try {
      return await next(e)
    } finally {
      effortByCall.delete(callId)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    // The engine does not list workflow agents, so neither does the pane
    if (!started.agentId || e.workflow) return started
    const row: AgentRow = {
      id: started.agentId,
      title: e.name ?? e.subagentType,
      description: e.description,
      kind: e.fork ? 'fork' : e.isTeammate ? 'teammate' : undefined,
      model: shortModel(started.model),
      // A call that names no effort (forks always follow the main thread) runs at the session's current effort
      effort: effortByCall.get(e.tool_use_id) ?? (await read($, sessionInfo)).effort,
      state: 'running',
      startedAt: await $.clock.now(),
    }
    await update($, agents, list => sortAgents([row, ...list.filter(a => a.id !== row.id)]))
    return started
  })

  // Every run, the first included, goes through turn.step before any request, so a step (not a tool call, which an aborted run can still let land after its turn.complete) marks it running; session.tsx holds turn.step's matcherless hook
  on('turn.step', { agentId: /./ }, async function* ($, e, next) {
    const id = e.agentId
    if (!id) return yield* next(e)
    await ensureRow($, id)
    await restore($, id)
    const now = await $.clock.now()
    await update($, agents, list => (list.some(a => a.id === id) ? patch(list, id, row => stepStarted(row, e.turnId, now)) : list))
    const result = yield* next(e)
    const usage = result.usage
    // Tokens only: the state is the turn's and the list's to settle
    if (usage) await update($, agents, list => (list.some(a => a.id === id) ? patch(list, id, row => stepCounted(row, usage)) : list))
    return result
  })

  // An event can carry only one matcherless hook per module and session.tsx has it (main-thread busy state); this one takes only subagent turns
  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await ensureRow($, id)
      await restore($, id)
      const listed = (await $.agent.list()).find(a => a.id === id)?.status
      const now = await $.clock.now()
      await update($, agents, list =>
        patch(list, id, row => ({
          ...row,
          state: settledState(listed, e.reason, row.kind),
          endedAt: now,
        })),
      )
    }
    return next(e)
  })

  // After a restart or --resume $.state is empty, so rebuild from the transcript. It holds only what the last compaction kept, so the rows are merged in:
  // what the atom holds (from before a hot reload, or restored by snapshot.ts) is kept. On a timer so startup is not held up
  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    $.clock.every(RECONCILE_MS, () => void reconcile($))
    $.clock.after(1, async () => {
      const [messages, listed] = await Promise.all([$.session.messages(), $.agent.list()])
      const rebuilt = agentsFromMessages(messages, new Map(listed.map(a => [a.id, a.status])))
      if (rebuilt.length > 0) await update($, agents, list => mergeAgents(list, rebuilt))
    })
    return next(e)
  })
}

export const meta: SectionMeta = { id: 'agents', title: 'Agents' }

/** First line's right side, fixed order: duration · ↓ output tokens · state; state last so a glance at the right edge says it. Missing parts are skipped; main and subagents read the same. */
const stats = (state: string, took: number | undefined, tokens: number | undefined) =>
  [took === undefined ? undefined : duration(took), tokens ? `↓ ${tokenCount(tokens)}` : undefined, state]
    .filter(Boolean)
    .join(' · ')

/** A subagent's first-line right side; rebuilt rows have no start time, so no duration. */
export const rightLine = (a: AgentRow, now: number) =>
  stats(LABEL[a.state], a.startedAt > 0 ? (a.endedAt ?? now) - a.startedAt : undefined, a.tokens)

/** One part of the second line: text and color role; parts without a role stay in the sub line's gray. */
export type Segment = [text: string | undefined, role?: Role]

/** A subagent's second line: description (gray) · model · effort. */
export const subSegments = (a: AgentRow): Segment[] => [[a.description], [a.model, 'model'], [a.effort, 'effort']]

/** main's first-line right side: while running, how long this turn has run; idle, no duration. */
export const mainRight = (session: SessionInfo, now: number) =>
  session.isBusy
    ? stats('Running', session.turnStartedAt === undefined ? undefined : now - session.turnStartedAt, session.tokens)
    : stats('Idle', undefined, session.tokens)

/** main's second line: model · effort, from the same source and in the same colors as the Session block. */
export const mainSegments = (session: SessionInfo): Segment[] => [[session.model, 'model'], [session.effort, 'effort']]

/** Drops empty parts and joins with " · "; parts with a role take the theme's color. With no parts there is no second line. */
function painted(view: View, segments: Segment[]) {
  const { Text } = view.t
  const shown = segments.filter(([text]) => text)
  if (shown.length === 0) return undefined
  return shown.flatMap(([text, role], i) => [
    ...(i > 0 ? [' · '] : []),
    role ? (
      <Text key={role} {...THEMES[view.theme][role]}>
        {text}
      </Text>
    ) : (
      text!
    ),
  ])
}

/** How the Agents section draws: keys hidden with ×, the keep period, whether the summary line is expanded. */
export type AgentsView = { dismissed: readonly string[]; keepMs: number; isExpanded: boolean }

/**
 * The first row is always the main session: not counted, no ×; subagents list under it at the same indent.
 * Running and recently finished agents get a row each, the rest fold into a summary line at the end that expands on press; rows hidden with × are neither drawn nor summed.
 */
export function render(view: View, list: AgentRow[], now: number, session: SessionInfo, opts: AgentsView): Block {
  const { Box, Button } = view.t
  const main = item(view, {
    key: 'agent-main',
    icon: session.isBusy ? { glyph: ICON.running, tone: 'run' } : { glyph: '●', tone: 'dim' },
    title: 'main',
    right: mainRight(session, now),
    sub: painted(view, mainSegments(session)),
  })
  const kept = list.filter(a => !opts.dismissed.includes(dismissKey(a.id)))
  const history = kept.filter(a => isHistory(a, now, opts.keepMs))
  const current = kept.filter(a => !history.includes(a))
  // First line: name / type on the left (pressing it opens the tasks list), duration · tokens · state on the right; second line: description · model · effort
  const row = (a: AgentRow) =>
    item(view, {
      key: `agent-${a.id}`,
      icon: { glyph: ICON[a.state], tone: TONE[a.state] },
      title: a.title,
      onPress: view.actions.openAgent,
      right: rightLine(a, now),
      sub: painted(view, subSegments(a)),
      dismiss: dismissKey(a.id),
    })
  return {
    count: current.length,
    rows: [
      main,
      ...current.map(row),
      ...(opts.isExpanded ? history.map(row) : []),
      ...(history.length > 0
        ? [
            <Box key="agents-history" marginLeft={2}>
              <Button key={`more:${HISTORY}`} plain dimColor label={historyLine(history)} onPress={() => view.actions.more(HISTORY)} />
            </Box>,
          ]
        : []),
    ],
  }
}
