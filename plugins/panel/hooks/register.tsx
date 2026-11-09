import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { FoldId, GitSort, GitTab, SectionId } from '../types'
import { demoData } from './demo'
import { withMore } from './section'
import type { RowActions, View } from './section'
import { SESSION_THEMES } from './theme'
import { HISTORY, meta as agentsMeta, register as registerAgents, render as renderAgents } from './sections/agents'
import { meta as gitMeta, register as registerGit, render as renderGit, TABS } from './sections/git'
import { meta as linksMeta, render as renderLinks } from './sections/links'
import { parseLines, register as registerSession, render as renderSession } from './sections/session'
import { register as registerUrls } from './sources/urls'

const PANE = 'panel'

const collapsed = atom({ plugin: 'panel', key: 'collapsed' } as const, [])
const expanded = atom({ plugin: 'panel', key: 'expanded' } as const, [])
const dismissed = atom({ plugin: 'panel', key: 'dismissed' } as const, [])
const gitTab = atom({ plugin: 'panel', key: 'gitTab' } as const, 'pr')
const linksTab = atom({ plugin: 'panel', key: 'linksTab' } as const, '')
const demo = atom({ plugin: 'panel', key: 'demo' } as const, false)
// Each section writes its own atoms; the engine only lets a file read atoms it declares, so they are declared again here under the same keys
const sessionInfo = atom({ plugin: 'panel', key: 'session' } as const, { dir: '', model: '' })
const agents = atom({ plugin: 'panel', key: 'agents' } as const, [])
const urls = atom({ plugin: 'panel', key: 'urls' } as const, [])
const titles = atom({ plugin: 'panel', key: 'titles' } as const, {})
const gitStatus = atom({ plugin: 'panel', key: 'gitStatus' } as const, {})
const tick = atom({ plugin: 'panel', key: 'tick' } as const, 0)
const copied = atom({ plugin: 'panel', key: 'copied' } as const, null)
const COPIED_MS = 2000
const TICK_MS = 1000

/** Write tick to force a redraw only while something runs (a subagent or the main thread); when all is still, skip it and save the redraws. */
async function heartbeat($: EngineInterface) {
  const [list, session] = await Promise.all([read($, agents), read($, sessionInfo)])
  if (!session.isBusy && !list.some(a => a.state === 'running')) return
  const now = await $.clock.now()
  await update($, tick, () => now)
}

export const toggled = <T extends string>(list: readonly T[], id: T) =>
  list.includes(id) ? list.filter(one => one !== id) : [...list, id]

/** The folded set goes to the atom to redraw, and to $.store to survive sessions. */
async function toggle($: EngineInterface, id: FoldId) {
  const next = await update($, collapsed, list => toggled(list, id))
  await $.store.set('collapsed', next)
}

/** The tab goes to the atom to redraw, and to $.store to survive sessions. */
async function pickTab($: EngineInterface, tab: GitTab) {
  await update($, gitTab, () => tab)
  await $.store.set('gitTab', tab)
}

/** An expanded "+N more" is for this session only, never stored. */
async function toggleMore($: EngineInterface, id: FoldId) {
  await update($, expanded, list => toggled(list, id))
}

/** After a successful copy the row's button shows ✓ for 2 s; if another row was copied meanwhile, leave that one be. */
async function copyUrl($: EngineInterface, url: string, key: string, surface: RenderSurface) {
  const result = await $.ui.copy({ text: url, surface })
  $.ui.toast(result.isCopied ? 'Copied' : `Copy failed: ${result.reason}`)
  if (!result.isCopied) return
  await update($, copied, () => key)
  $.clock.after(COPIED_MS, () => void update($, copied, now => (now === key ? null : now)))
}

/** The engine does not let a plugin switch to an agent's transcript (SiteView is read-only), so fall back to opening /tasks for the person to pick. */
async function openAgent($: EngineInterface) {
  $.ui.toast('Pick it in the tasks list')
  try {
    await $.command.run({ command: 'tasks' })
  } catch (error) {
    $.ui.toast(`Could not open tasks: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Hide only, data untouched: the same URL coming back stays hidden for this session; the Agents section brings an agent back when it acts again. */
async function dismissUrl($: EngineInterface, key: string) {
  await update($, dismissed, list => (list.includes(key) ? list : [...list, key]))
}

const GIT_SORTS: readonly GitSort[] = ['attention', 'recent', 'repo']

/** /config switches: a section switched off is not drawn and does not hook the events that feed it (GitHub off means no gh). */
export function settings(options: Readonly<Record<string, unknown>>) {
  const width = Number(options.width)
  const agentsKeep = Number(options.agentsKeep)
  const visibleRows = Number(options.visibleRows)
  const tabThreshold = Number(options.tabThreshold)
  const ghRefreshSeconds = Number(options.ghRefreshSeconds)
  return {
    session: options.showSession !== false,
    agents: options.showAgents !== false,
    git: options.showGit !== false,
    links: options.showLinks !== false,
    width: Number.isInteger(width) && width > 0 ? width : 46,
    /** Minutes; 0 = never fold */
    agentsKeep: Number.isInteger(agentsKeep) && agentsKeep >= 0 ? agentsKeep : 10,
    gitSort: GIT_SORTS.find(mode => mode === options.gitSort) ?? 'attention',
    sessionLines: parseLines(options.sessionLines),
    sessionBars: options.sessionBars !== false,
    sessionTheme: SESSION_THEMES.find(theme => theme === options.sessionTheme) ?? 'gruvbox',
    autoOpen: options.autoOpen !== false,
    visibleRows: Number.isInteger(visibleRows) && visibleRows > 0 ? visibleRows : 6,
    tabThreshold: Number.isInteger(tabThreshold) && tabThreshold > 0 ? tabThreshold : 3,
    /** 0 = fetch each PR / issue once, never re-poll */
    ghRefreshSeconds: Number.isInteger(ghRefreshSeconds) && ghRefreshSeconds >= 0 ? ghRefreshSeconds : 60,
  }
}

export const register: Register = (on, options) => {
  const show = settings(options)
  if (show.git || show.links) registerUrls(on)
  // The Agents main row reads session too (model, effort, isBusy), so collect it when only Agents is on
  if (show.session || show.agents) registerSession(on)
  if (show.agents) registerAgents(on)
  if (show.git) registerGit(on, show.ghRefreshSeconds * 1000)

  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Toggle the panel', argumentHint: '[demo]' })
    const saved = await $.store.get('collapsed')
    if (Array.isArray(saved)) await update($, collapsed, () => saved as FoldId[])
    const savedTab = await $.store.get('gitTab')
    const tab = TABS.find(one => one.id === savedTab)?.id
    if (tab) await update($, gitTab, () => tab)
    // A pane the plugin opens waits undrawn below 144 columns and docks once the terminal is wide enough
    if (show.autoOpen && ((await $.store.get('isOpen')) ?? true)) void $.ui.open({ id: PANE, columns: show.width })
    // Durations only redraw on a write; without this the tasks list at the bottom ticks while the pane stands still
    if (show.agents) $.clock.every(TICK_MS, () => void heartbeat($))
    return next(e)
  })

  on('command.run', { command: 'panel' }, async ($, e) => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    // Demo lives in $.state only, never $.store, so a restart always comes back without it.
    // args can arrive missing from a caller's $.command.run, hence ?.
    if (e.args?.trim() === 'demo') {
      const isDemo = await update($, demo, was => !was)
      if (isDemo && !pane?.isPlaced) await $.ui.open({ id: PANE, columns: show.width })
      return { text: isDemo ? 'Panel demo on' : 'Panel demo off' }
    }
    // Open but undrawn for lack of width counts as closed: this time it was asked for, so open draws it
    if (pane?.isPlaced) {
      await $.ui.close({ id: PANE })
      await $.store.set('isOpen', false)
      return { text: 'Panel closed' }
    }
    await $.ui.open({ id: PANE, columns: show.width })
    await $.store.set('isOpen', true)
    return { text: 'Panel opened' }
  })

  // Closing the pane by its own close mark (ctrl+x x) is remembered too: the next session does not open it
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set('isOpen', false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    // Reading subscribes: whichever atom changes triggers a redraw
    // tick is subscribed, not used: its value may be from the last run, durations come from the current time
    const [folded, more, gone, session, agentList, urlList, known, , justCopied, now, tab, siteTab, isDemo, titled] = await Promise.all([
      read($, collapsed),
      read($, expanded),
      read($, dismissed),
      read($, sessionInfo),
      read($, agents),
      read($, urls),
      read($, gitStatus),
      read($, tick),
      read($, copied),
      $.clock.now(),
      read($, gitTab),
      read($, linksTab),
      read($, demo),
      read($, titles),
    ])
    const data = isDemo ? { ...demoData(now), titles: {} } : { session, agents: agentList, urls: urlList, gitStatus: known, titles: titled }
    const actions: RowActions = {
      copy: (url, key, surface) => void copyUrl($, url, key, surface),
      dismiss: key => void dismissUrl($, key),
      fold: id => void toggle($, id),
      more: id => void toggleMore($, id),
      gitTab: id => void pickTab($, id),
      // Links tabs change with the rows, so remembering them across sessions means nothing: atom only
      linksTab: key => void update($, linksTab, () => key),
      openAgent: () => void openAgent($),
    }
    const view: View = {
      t,
      columns: e.props.bodyColumns,
      actions,
      theme: show.sessionTheme,
      copied: justCopied,
      visibleRows: show.visibleRows,
      tabThreshold: show.tabThreshold,
    }
    // A rule splits two sections: content → blank line → rule → blank line → next title
    const rule = (
      <Box marginY={1}>
        <Text dimColor>{'─'.repeat(e.props.bodyColumns)}</Text>
      </Box>
    )
    const style = {
      lines: show.sessionLines,
      bars: show.sessionBars,
      theme: show.sessionTheme,
      columns: e.props.bodyColumns,
    }
    // Sections with a title that fold; the Session block has no title and always sits on top. render runs even when folded: the title shows the count
    const shown = [
      {
        ...agentsMeta,
        block: renderAgents(view, data.agents, now, data.session, {
          dismissed: gone,
          keepMs: show.agentsKeep * 60_000,
          isExpanded: more.includes(HISTORY),
        }),
      },
      { ...gitMeta, block: renderGit(view, data.urls, data.gitStatus, gone, show.gitSort, tab, more) },
      { ...linksMeta, block: renderLinks(view, data.urls, data.titles, gone, siteTab, more) },
    ].filter(s => show[s.id])
    return (
      <Box flexDirection="column">
        {show.session && renderSession(t, data.session, now, style)}
        {shown.map((s, i) => {
          const isOpen = !folded.includes(s.id)
          const { count, rows, visible = rows.length } = s.block
          return (
            <Box key={`section-${s.id}`} flexDirection="column">
              {(show.session || i > 0) && rule}
              <Box flexDirection="row">
                {/* No hotkey: a plain button with one draws as "a: ▾ Agents" and spoils the title; press it, or focus and Tab + Enter, to fold */}
                <Button
                  key={`toggle:${s.id}`}
                  plain
                  label={`${isOpen ? '▾' : '▸'} ${s.title}`}
                  onPress={() => toggle($, s.id)}
                />
                <Text dimColor> {count}</Text>
              </Box>
              {isOpen &&
                (rows.length > 0 ? (
                  <Box flexDirection="column" marginTop={1}>
                    {withMore(view, s.id, rows, visible, more.includes(s.id))}
                  </Box>
                ) : (
                  <Box marginTop={1}>
                    <Text dimColor>{'  —'}</Text>
                  </Box>
                ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
