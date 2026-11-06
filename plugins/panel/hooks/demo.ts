import type { AgentRow, GitInfo, SessionInfo, UrlEntry } from '../types'

const MIN = 60_000
const REPO = 'itaober/agent-plugins'

/**
 * `/panel demo`: a fictional session for screenshots, so no real repo, link or usage ever shows.
 * Times are relative to the moment of drawing, so durations and resets read the same in every shot.
 */
export function demoData(now: number) {
  const session: SessionInfo = {
    dir: '~/code/agent-plugins',
    branch: 'main',
    dirty: 3,
    model: 'Opus 5.5',
    effort: 'high',
    contextPercent: 42,
    isBusy: true,
    turnStartedAt: now - 72_000,
    tokens: 9_400,
    limits: [
      { label: '5h', percent: 18, resetsAt: new Date(now + (3 * 60 + 12) * MIN).toISOString() },
      { label: 'Week', percent: 61, resetsAt: new Date(now + (2 * 24 + 4) * 60 * MIN).toISOString() },
    ],
  }

  // Ended well past any keep period: folds into "✓ 6 done · ↓ 48.2k"
  const history = (
    [
      ['Map the hooks API', 12_000],
      ['Draft the release notes', 9_800],
      ['Trace the double pane bug', 8_400],
      ['Audit the link capture rules', 7_600],
      ['Check the tsc output', 6_200],
      ['Summarise open issues', 4_200],
    ] as const
  ).map(([description, tokens], i): AgentRow => ({
    id: `demo-history-${i}`,
    title: i % 2 ? 'general-purpose' : 'Explore',
    description,
    model: 'Haiku 5.5',
    state: 'done',
    tokens,
    startedAt: now - (180 + i * 10) * MIN,
    endedAt: now - (175 + i * 10) * MIN,
  }))
  const agents: AgentRow[] = [
    { id: 'demo-explore', title: 'Explore', description: 'Find every caller of withMore', model: 'Haiku 5.5', effort: 'low', state: 'running', tokens: 1_200, startedAt: now - 23_000 },
    { id: 'demo-reviewer', title: 'reviewer', kind: 'teammate', description: 'Review PR #42', model: 'Opus 5.5', effort: 'high', state: 'idle', tokens: 18_300, startedAt: now - 250_000, endedAt: now },
    { id: 'demo-tests', title: 'general-purpose', description: 'Run the panel test suite', model: 'Haiku 5.5', effort: 'low', state: 'done', tokens: 4_800, startedAt: now - 290_000, endedAt: now - 2 * MIN },
    { id: 'demo-vite', title: 'general-purpose', description: 'Port the guard to Windows paths', model: 'Haiku 5.5', effort: 'low', state: 'failed', tokens: 2_100, startedAt: now - 9 * MIN, endedAt: now - 450_000 },
    ...history,
  ]

  const gitStatus: Record<string, GitInfo> = {}
  const item = (repo: string, kind: 'pr' | 'issue', number: number, info: GitInfo): UrlEntry => {
    const key = `${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`
    gitStatus[key] = info
    return { key, url: `https://github.com/${key}`, desc: `#${number}`, rank: 4, git: { kind, repo, number } }
  }
  const link = (url: string, desc: string): UrlEntry => ({ key: url, url, desc, rank: 1 })
  const urls: UrlEntry[] = [
    item(REPO, 'pr', 42, { title: 'feat(panel): demo mode', state: 'approved' }),
    item(REPO, 'pr', 41, { title: 'ci: validate and test both plugins', state: 'ci-failed' }),
    item(REPO, 'issue', 44, { title: 'Pane cannot dock on the left', state: 'open' }),
    item(REPO, 'pr', 45, { title: 'feat(panel): links tabs by site', state: 'draft' }),
    item(REPO, 'pr', 39, { title: 'fix(panel): resets in shows minutes', state: 'changes-requested' }),
    item(REPO, 'pr', 38, { title: 'docs: plugin READMEs', state: 'review' }),
    item(REPO, 'pr', 36, { title: 'feat(inline-images): force option', state: 'merged' }),
    item(REPO, 'issue', 33, { title: 'Copy icon missing in some fonts', state: 'completed' }),
    {
      key: `${REPO}/blob/main/README.md`,
      url: `https://github.com/${REPO}/blob/main/README.md`,
      desc: `${REPO} · main/README.md`,
      rank: 4,
      git: { kind: 'repo', repo: REPO, path: 'blob/main/README.md' },
    },
    link('https://claude.ai/code/artifact/demo-design-review', 'Design review'),
    link('https://acme.slack.com/archives/C0DEMO/p1730000000000', 'Slack thread'),
    link('https://claude.ai/code/artifact/demo-weekly-report', 'Weekly report'),
    link('http://localhost:5173/cart', 'Local dev server'),
    link('https://claude.ai/code/artifact/demo-panel-ui-board', 'Panel UI board'),
  ]

  return { session, agents, urls, gitStatus }
}
