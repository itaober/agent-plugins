import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, On, RenderChildren, RenderSurface } from 'claude-code'

import type { SessionInfo, UsageLimit } from '../../types'
import { shortModel } from '../section'
import { BAR_CELLS, bar, levelRole, THEMES } from '../theme'
import type { Role, SessionTheme } from '../theme'

const sessionInfo = atom({ plugin: 'panel', key: 'session' } as const, { dir: '', model: '' })

const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }

/** Lines sessionLines knows, in default order. The branch is drawn in the dir line; there is no separate git line. */
export const SESSION_LINES = ['dir', 'model', 'context', '5h', 'week'] as const
export type SessionLine = (typeof SESSION_LINES)[number]

/** Comma list → lines to draw, in order: unknown ones ignored, repeats keep the first; if none is left, the default. */
export function parseLines(raw: unknown): SessionLine[] {
  const picked = String(raw ?? '')
    .split(',')
    .map(one => one.trim().toLowerCase())
    .filter((one, i, all): one is SessionLine => SESSION_LINES.includes(one as SessionLine) && all.indexOf(one) === i)
  return picked.length > 0 ? picked : [...SESSION_LINES]
}

/** turn.step's effort: only levels such as low / high are drawn; absent on models without effort, and a numeric budget is not drawn either. */
export const effortLevel = (effort: unknown) => (typeof effort === 'string' && effort ? effort : undefined)

/** `git status --porcelain` prints one line per change. */
export const dirtyCount = (porcelain: string) => porcelain.split('\n').filter(line => line.trim()).length

/** Time until reset: 12m / 3h / 2d 7h; undefined once passed or unreadable. */
export function resetsIn(resetsAt: string | undefined, now: number) {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at) || at <= now) return undefined
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  // Under a day keep the minutes, as claude-hud does (3h 3m); on the hour, hours only
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`
}

/** Directory, branch, change count, model, context and usage windows in one go. SessionRepo carries no branch, so git is asked; outside a repository the dir line is just the directory. */
async function collect($: EngineInterface): Promise<SessionInfo> {
  const [root, model, usage, home] = await Promise.all([
    $.session.root(),
    $.session.model(),
    $.session.usage(),
    $.env.get('HOME'),
  ])
  const git = (args: string[]) =>
    $.process.run(['git', '-C', root, ...args], { timeoutMs: 3000 }).then(
      r => (r.exitCode === 0 ? r.stdout : undefined),
      () => undefined,
    )
  const [branch, status] = await Promise.all([git(['branch', '--show-current']), git(['status', '--porcelain'])])
  const limits: UsageLimit[] = []
  for (const kind of Object.keys(WINDOWS)) {
    const limit = usage.rateLimits.find(r => r.kind === kind)
    if (limit) limits.push({ label: WINDOWS[kind]!, percent: limit.percentUsed, resetsAt: limit.resetsAt })
  }
  return {
    dir: home && root.startsWith(home) ? `~${root.slice(home.length)}` : root,
    branch: branch === undefined ? undefined : branch.trim() || 'HEAD',
    dirty: status === undefined ? undefined : dirtyCount(status),
    model: shortModel(model),
    contextPercent: usage.context.percent,
    limits,
  }
}

/** effort and isBusy come from other events that collect cannot see: a refresh keeps the last ones. */
async function refresh($: EngineInterface) {
  const info = await collect($)
  await update($, sessionInfo, old => ({ ...old, ...info }))
}

export function register(on: On) {
  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    $.clock.after(1, () => refresh($))
    return next(e)
  })
  // The engine fires this once it has measured usage (end of each main turn, a usage window moving a point): exactly when this block should refresh, so no timer of its own. git status runs here too
  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })
  // turn.start fires only for the main thread (subagent turns do not), and a turn.complete without agentId ends a main turn; the Agents main row draws ◐ from this
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, sessionInfo, old => ({ ...old, isBusy: true, turnStartedAt: now }))
    return next(e)
  })
  // Main turn over: add its output tokens (interrupted turns and API errors carry no usage)
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const spent = e.usage?.output_tokens ?? 0
      await update($, sessionInfo, old => ({ ...old, isBusy: false, tokens: (old.tokens ?? 0) + spent }))
    }
    return next(e)
  })
  // Every main-thread request carries effort (session setting or model default); switching to a model without effort clears it.
  // Not classic.Stop: the built-in cc-plugin-sec-default hooks classic.*, which bypasses user plugins' classic hooks so they never run
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId ? undefined : effortLevel(e.effort)
    if (!e.agentId && (await read($, sessionInfo)).effort !== effort) {
      await update($, sessionInfo, old => ({ ...old, effort }))
    }
    return yield* next(e)
  })
}

export type SessionStyle = { lines: readonly SessionLine[]; bars: boolean; theme: SessionTheme; columns: number }

/** Label column: 8 columns, left-aligned, then one space. */
const LABEL_WIDTH = 8
const label = (text: string) => `${text.padEnd(LABEL_WIDTH)} `
/** Bar plus one space */
const BAR_WIDTH = BAR_CELLS + 1
/** Spacing: lines in a group touch, a new group gets a blank line (dir / model, then the three usage lines) */
const GROUP: Record<SessionLine, number> = { dir: 0, model: 0, context: 1, '5h': 1, week: 1 }

/** No title: the directory is the title. columns is the full width; this block has no icon prefix. */
export function render(t: Elements[RenderSurface], info: SessionInfo, now: number, style: SessionStyle) {
  const { Box, Text } = t
  const theme = THEMES[style.theme]
  const paint = (role: Role) => theme[role]
  const percentRow = (key: string, name: string, percent: number, kind: 'context' | 'usage', extra?: string) => {
    const shown = `${Math.round(percent)}%`
    const value = paint(levelRole(kind, percent))
    const [filled, empty] = bar(percent)
    const used = label(name).length + (style.bars ? BAR_WIDTH : 0) + shown.length
    // If it does not fit, drop the resets part whole rather than half of it
    const tail = extra && used + extra.length <= style.columns ? extra : undefined
    return (
      <Text key={key} wrap="truncate-end">
        <Text {...paint('label')}>{label(name)}</Text>
        {style.bars && <Text {...value}>{filled}</Text>}
        {style.bars && <Text {...paint('label')}>{`${empty} `}</Text>}
        <Text {...value}>{shown}</Text>
        {tail && <Text {...paint('label')}>{tail}</Text>}
      </Text>
    )
  }
  const draw: Record<SessionLine, () => RenderChildren> = {
    // ~/code/app · main* · 2 modified: just the directory outside a repository; cut from the start when too long, so the branch stays
    dir: () =>
      info.dir && (
        <Text key="dir" wrap="truncate-start">
          <Text bold>{info.dir}</Text>
          {info.branch !== undefined && <Text {...paint('label')}> · </Text>}
          {info.branch !== undefined && <Text {...paint('branch')}>{info.branch}</Text>}
          {info.branch !== undefined && !!info.dirty && <Text {...paint('dirty')}>*</Text>}
          {info.branch !== undefined && !!info.dirty && <Text {...paint('label')}> · {info.dirty} modified</Text>}
        </Text>
      ),
    model: () =>
      info.model && (
        <Text key="model" wrap="truncate-end">
          <Text {...paint('model')}>{info.model}</Text>
          {info.effort && <Text {...paint('label')}> · effort </Text>}
          {info.effort && <Text {...paint('effort')}>{info.effort}</Text>}
        </Text>
      ),
    context: () =>
      info.contextPercent !== undefined && percentRow('context', 'Context', info.contextPercent, 'context'),
    '5h': () => windowRow('5h'),
    week: () => windowRow('week'),
  }
  function windowRow(id: '5h' | 'week') {
    const limit = info.limits?.find(l => l.label.toLowerCase() === id)
    if (!limit) return undefined
    const reset = resetsIn(limit.resetsAt, now)
    return percentRow(`limit-${id}`, limit.label, limit.percent, 'usage', reset && ` · resets in ${reset}`)
  }
  const drawn = style.lines.map(line => ({ line, node: draw[line]() })).filter(one => one.node)
  return drawn.map((one, i) => (
    <Box key={`session-${one.line}`} flexDirection="column" marginTop={i > 0 && GROUP[one.line] !== GROUP[drawn[i - 1]!.line] ? 1 : 0}>
      {one.node}
    </Box>
  ))
}
