import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { FoldId, GitInfo, GitSort, GitState, GitTab, UrlEntry } from '../../types'
import { activeTab, fit, GLYPH, item, tabs, toneProps, withMore } from '../section'
import type { Block, SectionMeta, Tone, View } from '../section'

const gitStatus = atom({ plugin: 'panel', key: 'gitStatus' } as const, {})
/** urls is written by sources/urls.ts; declared again under the same key, read only */
const urls = atom({ plugin: 'panel', key: 'urls' } as const, [])
/** Written by the shell's /panel demo; declared again under the same key, read only */
const demo = atom({ plugin: 'panel', key: 'demo' } as const, false)

/** States never re-polled: finished ones, and unknown ones (repo gone / no access, asking again changes nothing) */
const TERMINAL = new Set<GitState>(['merged', 'closed', 'completed', 'unknown'])
export const LABEL: Record<GitState, string> = {
  merged: 'Merged',
  closed: 'Closed',
  draft: 'Draft',
  'ci-failed': 'CI failed',
  'changes-requested': 'Changes',
  approved: 'Approved',
  review: 'Review',
  open: 'Open',
  completed: 'Done',
  unknown: '',
}
const TONE: Record<GitState, Tone> = {
  merged: 'merged',
  closed: 'dim',
  draft: 'dim',
  'ci-failed': 'bad',
  'changes-requested': 'bad',
  approved: 'ok',
  review: 'run',
  open: 'run',
  completed: 'ok',
  unknown: 'dim',
}

type Check = { conclusion?: string | null; state?: string | null }
type PrView = {
  title?: string
  state?: string
  isDraft?: boolean
  reviewDecision?: string | null
  statusCheckRollup?: Check[] | null
}
type IssueView = { title?: string; state?: string; stateReason?: string | null }

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Priority: merged → closed → draft → CI failed → changes requested → approved → awaiting review. */
export function prState(pr: PrView): GitState {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft) return 'draft'
  if ((pr.statusCheckRollup ?? []).some(c => FAILED.has(c.conclusion ?? '') || FAILED.has(c.state ?? ''))) {
    return 'ci-failed'
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  return 'review'
}

export function issueState(issue: IssueView): GitState {
  if (issue.state === 'OPEN') return 'open'
  return issue.stateReason === 'COMPLETED' ? 'completed' : 'closed'
}

// ponytail: in-flight queries are tracked in the module to avoid duplicates; cleared on reload, at most one extra query
const inFlight = new Set<string>()

async function fetchOne($: EngineInterface, entry: UrlEntry): Promise<GitInfo> {
  const argv =
    entry.git?.kind === 'pr'
      ? ['gh', 'pr', 'view', entry.url, '--json', 'title,state,isDraft,reviewDecision,statusCheckRollup']
      : ['gh', 'issue', 'view', entry.url, '--json', 'title,state,stateReason']
  try {
    const run = await $.process.run(argv, { timeoutMs: 20_000 })
    if (run.exitCode !== 0) return { state: 'unknown' }
    const view = JSON.parse(run.stdout) as PrView & IssueView
    return { title: view.title, state: entry.git?.kind === 'pr' ? prState(view) : issueState(view) }
  } catch {
    // gh missing, logged out or timed out: just draw no state, no toast to interrupt
    return { state: 'unknown' }
  }
}

/** onlyNew: on discovery, only what was never asked; the timer refreshes every non-terminal one. */
async function refresh($: EngineInterface, onlyNew: boolean) {
  // Demo data is seeded, nothing to ask gh about
  if (await read($, demo)) return
  const [list, known] = await Promise.all([read($, urls), read($, gitStatus)])
  const due = list.filter(u => {
    // Repo links never go to gh
    if (!u.git || u.git.kind === 'repo' || inFlight.has(u.key)) return false
    const info = known[u.key]
    return onlyNew ? !info : !info || !TERMINAL.has(info.state)
  })
  await Promise.all(
    due.map(async u => {
      inFlight.add(u.key)
      try {
        const info = await fetchOne($, u)
        // On failure keep the last title rather than wipe a known one
        await update($, gitStatus, all => ({ ...all, [u.key]: { ...info, title: info.title ?? all[u.key]?.title } }))
      } finally {
        inFlight.delete(u.key)
      }
    }),
  )
}

/** Hooks its own events and writes only its own atom. refreshMs 0: statuses are fetched once and never re-polled. */
export function register(on: On, refreshMs: number) {
  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    if (refreshMs > 0) $.clock.every(refreshMs, () => void refresh($, false))
    $.clock.after(1, () => void refresh($, false))
    return next(e)
  })
  // sources/urls scans URLs: once it has written (next returned), look for new PRs / issues (refresh skips repo links). gh runs on a timer so this row's write is not held up
  on('session.append', { door: ['prompt', 'tool-result'] }, async ($, e, next) => {
    const appended = await next(e)
    // Most rows carry no GitHub link: a string check first, rather than reading two atoms per row
    if (JSON.stringify(e.message.content).includes('github.com/')) $.clock.after(1, () => void refresh($, true))
    return appended
  })
}

export const meta: SectionMeta = { id: 'git', title: 'GitHub' }

/** A PR's glyph follows its state (merged / closed / draft each have one), otherwise it and issues use the open one; color comes from TONE. */
export function glyphOf(kind: 'pr' | 'issue', state: GitState | undefined) {
  if (kind === 'issue') return GLYPH.issue
  if (state === 'merged') return GLYPH.prMerged
  if (state === 'closed') return GLYPH.prClosed
  if (state === 'draft') return GLYPH.prDraft
  return GLYPH.pr
}

/** attention groups: needs action first, finished last; not yet fetched goes after open issues. */
const ATTENTION: Record<GitState, number> = {
  'ci-failed': 0,
  'changes-requested': 0,
  review: 1,
  approved: 2,
  draft: 3,
  open: 4,
  unknown: 5,
  merged: 6,
  closed: 6,
  completed: 6,
}

/** rows arrive in urls order (most recently seen first); every group keeps that order. */
export function sortGit(rows: readonly UrlEntry[], known: Record<string, GitInfo>, mode: GitSort) {
  if (mode === 'recent') return [...rows]
  const rank = (u: UrlEntry) => ATTENTION[known[u.key]?.state ?? 'unknown']
  const repo = (u: UrlEntry) => (mode === 'repo' ? u.git?.repo.toLowerCase() ?? '' : '')
  return rows
    .map((u, i) => ({ u, i }))
    .sort((a, b) => repo(a.u).localeCompare(repo(b.u)) || rank(a.u) - rank(b.u) || a.i - b.i)
    .map(({ u }) => u)
}

export const TABS: readonly { id: GitTab; name: string }[] = [
  { id: 'pr', name: 'PR' },
  { id: 'issue', name: 'Issue' },
  { id: 'repo', name: 'Others' },
]

/**
 * Reads the GitHub entries in urls (minus those dismissed with ×); PR / issue state comes from its own gitStatus.
 * First line is the tab row "PR n   Issue n   Others n", the selected one inverse; below, only the selected kind: PRs / issues sorted by mode, Others (kind repo) as seen,
 * each tab with its own "+N more" (expanded state lives in the shell's expanded under git:<tab>). The section count is the sum of all three; with none, no tab row and the shell draws "—".
 * PR / issue, two lines: "icon #n title … copy ×", sub line "owner/repo · state" with the state colored; unknown state draws just the repo, never "Unknown".
 * Others, two lines: "icon owner/repo … copy ×", sub line the full URL cut at the end, as in Links.
 */
export function render(
  view: View,
  list: UrlEntry[],
  known: Record<string, GitInfo>,
  dismissed: readonly string[],
  mode: GitSort,
  selected: GitTab,
  expanded: readonly FoldId[],
): Block {
  const { Text } = view.t
  const shown = list.filter(u => u.git && !dismissed.includes(u.key))
  const of = (tab: GitTab) => shown.filter(u => u.git!.kind === tab)
  const members = { pr: of('pr'), issue: of('issue'), repo: of('repo') }
  const counts = { pr: members.pr.length, issue: members.issue.length, repo: members.repo.length }
  const count = counts.pr + counts.issue + counts.repo
  if (count === 0) return { count, rows: [] }
  // If the selected tab is empty while another has rows (say PR, the default, still at 0), land on the first with rows
  const items = TABS.map(tab => ({ ...tab, count: counts[tab.id] }))
  const active = activeTab(items, selected)

  const rows =
    active === 'repo'
      ? members.repo.map(u =>
          item(view, { key: `git-${u.key}`, icon: { glyph: GLYPH.repo, tone: 'dim' }, title: u.desc, href: u.url, sub: fit(u.url, view.columns - 2), link: u }),
        )
      : sortGit(members[active], known, mode).map(u => {
          const { repo, number } = u.git as { repo: string; number: number }
          const state = known[u.key]?.state
          const title = known[u.key]?.title
          const label = state && LABEL[state]
          return item(view, {
            key: `git-${u.key}`,
            icon: { glyph: glyphOf(active, state), tone: state ? TONE[state] : 'dim' },
            title: title ? `#${number} ${title}` : `#${number}`,
            href: u.url,
            // The state word matches the icon's color; unknown state draws just the repo
            sub: label ? [repo, ' · ', <Text key="state" {...toneProps(TONE[state])}>{label}</Text>] : repo,
            link: u,
          })
        })
  const id: FoldId = `git:${active}`
  return { count, rows: [tabs(view, 'git', items, active, view.actions.gitTab), ...withMore(view, id, rows, view.visibleRows, expanded.includes(id))] }
}
