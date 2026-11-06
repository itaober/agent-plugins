/** Sections with a title that fold; the Session block has no title and is not one. */
export type SectionId = 'agents' | 'git' | 'links'
/** The GitHub section's three tabs */
export type GitTab = 'pr' | 'issue' | 'repo'
/** What folds or expands: a section, and the agents the Agents summary line folds away; `git:<tab>` / `links:<site key>` only go in expanded (each tab's own "+N more") */
export type FoldId = SectionId | `git:${GitTab}` | `links:${string}` | 'agents:history'

/** A URL seen in the session: its description is settled at scan time, so views only filter and never re-parse. */
export type UrlEntry = {
  /** Dedupe key: PRs / issues use `owner/repo/pull|issues/n` (same number never collides), other repo links `owner/repo/<path>` (no query or hash), everything else the URL itself */
  key: string
  url: string
  /** Main line text */
  desc: string
  /** How trustworthy desc is: 1 markdown text, 2 known site, 3 preceding sentence, 4 fallback; a repeat keeps the better one */
  rank: number
  /** Set on every link under github.com/<owner>/<repo>; links without it go to Links */
  git?: { kind: 'pr' | 'issue'; repo: string; number: number } | { kind: 'repo'; repo: string; /** Path after the repo, empty for the repo home */ path: string }
}

export type AgentState = 'running' | 'idle' | 'done' | 'failed' | 'aborted'

export type AgentRow = {
  id: string
  /** First line: the Agent's name, else its type (general-purpose, Explore…), as Claude's own task list shows it */
  title: string
  /** Second line: the description it was dispatched with */
  description?: string
  /** Second line: short name such as Haiku 5.5; from agent.spawn's result, or the Agent call's model argument on rebuilt rows */
  model?: string
  /** Second line: the Agent call's effort argument, else the session's effort at dispatch */
  effort?: string
  /** Only forks and teammates are marked; plain subagents are not */
  kind?: 'fork' | 'teammate'
  state: AgentState
  /** Summed output_tokens: added on every turn.complete carrying its agentId, so a teammate's turns add up; rebuilt rows have none */
  tokens?: number
  /** 0 = unknown (a row rebuilt from the transcript): no duration is drawn */
  startedAt: number
  endedAt?: number
}

export type GitState =
  | 'merged'
  | 'closed'
  | 'draft'
  | 'ci-failed'
  | 'changes-requested'
  | 'approved'
  | 'review'
  | 'open'
  | 'completed'
  | 'unknown'

export type GitInfo = { title?: string; state: GitState }

/** Order of GitHub PRs / issues: needs action first / as seen / grouped by repo; Others (repo links) always go as seen */
export type GitSort = 'attention' | 'recent' | 'repo'

/** One usage window: 5h or Week. */
export type UsageLimit = { label: string; percent: number; resetsAt?: string }

/** What the Session block draws: collected in the session's own events, so drawing never asks the engine. */
export type SessionInfo = {
  /** Project root, home shortened to ~ */
  dir: string
  /** Absent outside a git repository */
  branch?: string
  /** Line count of `git status --porcelain` */
  dirty?: number
  /** Short name such as Opus 5.5 */
  model: string
  /** Effort level the main thread's turn.step carries; absent when the model has none */
  effort?: string
  contextPercent?: number
  /** A main-thread turn is running: from turn.start to the turn.complete without an agentId */
  isBusy?: boolean
  /** When the main thread's current turn began, for the main row's "running for" */
  turnStartedAt?: number
  /** Summed main-thread output_tokens, one add per turn.complete without an agentId; this process only, back to 0 after a restart */
  tokens?: number
  /** Windows the engine did not report are left out */
  limits?: UsageLimit[]
}

declare module 'claude-code' {
  interface PluginState {
    panel: {
      urls: UrlEntry[]
      agents: AgentRow[]
      /** By UrlEntry.key */
      gitStatus: Record<string, GitInfo>
      collapsed: FoldId[]
      /** Selected GitHub tab; also written to $.store so it survives sessions */
      gitTab: GitTab
      /** Selected Links tab, a site group key (siteOf's key or others); tabs come and go with the rows, so this session only, never $.store */
      linksTab: string
      /** Sections or GitHub tabs with "+N more" expanded, and an expanded Agents summary line; this session only, never $.store */
      expanded: FoldId[]
      /** Rows hidden with ×: a UrlEntry.key for GitHub / Links, `agent:<id>` for Agents; this session only */
      dismissed: string[]
      session: SessionInfo
      /** UrlEntry.key just copied: that row's copy button shows ✓ and goes back to null after 2 s ($.state takes no undefined) */
      copied: string | null
      /** Written with the current time every second while an agent or the main thread runs; drawing reads it only to redraw each second, durations still come from $.clock.now() */
      tick: number
      /** `/panel demo`: draw the seeded data in hooks/demo.ts instead of the session's; session state only, so a restart always comes back without it */
      demo: boolean
    }
  }
}
