import { expect, test } from 'claude-code/testing'

import type { SessionMessage } from 'claude-code'

import { extract, fromGh, GH_RE, merge, sentenceBefore, siteOf, textOf, urlsFromMessages } from './sources/urls'

test('takes the markdown text as the description', async () => {
  const [entry] = extract('Plan: [Sidebar plugin plan](https://claude.ai/code/artifact/abc)')
  expect(entry).toMatchObject({ desc: 'Sidebar plugin plan', rank: 1 })
})

test('falls back to the sentence before the URL, without its tail', async () => {
  const text = 'Bottom line first. Rate limit thread, see: https://acme.slack.com/archives/C123/p456'
  expect(extract(text)[0]).toMatchObject({ desc: 'Rate limit thread', rank: 3 })
  const bare = '- Link: https://x.dev'
  expect(sentenceBefore(bare, bare.indexOf('http'))).toBeUndefined()
})

test('reads Chinese sentences, tail words and full-width punctuation the same way', async () => {
  // "Bottom line first. PN rate-limit discussion, see: <url>", escaped to keep CJK out of the source
  const text = '\u5148\u8bf4\u7ed3\u8bba\u3002PN \u9891\u7387\u62e6\u622a\u8ba8\u8bba\u89c1\uff1ahttps://acme.slack.com/archives/C123/p456'
  expect(extract(text)[0]).toMatchObject({ desc: 'PN \u9891\u7387\u62e6\u622a\u8ba8\u8bba', rank: 3 })
  const bare = '- \u94fe\u63a5\uff1ahttps://x.dev'
  expect(sentenceBefore(bare, bare.indexOf('http'))).toBeUndefined()
  // A full-width comma ends the URL
  expect(extract('https://a.dev/x\uff0cnext')[0]?.url).toBe('https://a.dev/x')
})

test('names known sites: Artifact publishes and localhost', async () => {
  const published = extract('Published panel-ui.html (private) at https://claude.ai/code/artifact/u1')[0]
  expect(published).toMatchObject({ desc: 'panel-ui', rank: 2 })
  expect(extract('http://localhost:3000/')[0]).toMatchObject({ desc: 'Local dev server' })
})

test('falls back to host and first path segment', async () => {
  expect(extract('https://www.notion.site/team/Page-1')[0]).toMatchObject({ desc: 'Page 1', rank: 4 })
  expect(extract('https://acme.slack.com/archives/C1/p2')[0]?.desc).toBe('Slack thread')
  expect(extract('tool output https://acme.dev/x', false)[0]?.desc).toBe('acme.dev/x')
})

test('drops noise domains and trailing punctuation', async () => {
  const found = extract('<script src="https://cdnjs.cloudflare.com/x.js"></script> see https://acme.dev/a. and http://bridge/reload and https://example.com/b')
  expect(found.map(u => u.url)).toEqual(['https://acme.dev/a'])
})

test('canonicalises GitHub PRs and issues and dedupes by owner/repo/number', async () => {
  const found = extract(
    'https://github.com/acme/os/pull/482/files and https://github.com/acme/os/pull/482 and https://github.com/acme/os/issues/1203#c',
  )
  expect(found.map(u => [u.key, u.url, u.git?.kind])).toEqual([
    ['acme/os/pull/482', 'https://github.com/acme/os/pull/482', 'pr'],
    ['acme/os/issues/1203', 'https://github.com/acme/os/issues/1203', 'issue'],
  ])
})

test('files any other link under a GitHub repo as a repo entry', async () => {
  const [home, deep, releases] = extract(
    'https://github.com/acme/app https://github.com/acme/app/blob/main/src/a.ts?plain=1#L3 https://github.com/acme/app/releases',
  )
  expect(home).toMatchObject({ key: 'acme/app', desc: 'acme/app', git: { kind: 'repo', repo: 'acme/app', path: '' } })
  expect(deep).toMatchObject({
    key: 'acme/app/blob/main/src/a.ts',
    url: 'https://github.com/acme/app/blob/main/src/a.ts?plain=1#L3',
    desc: 'acme/app · main/src/a.ts',
    git: { kind: 'repo', path: 'blob/main/src/a.ts' },
  })
  expect(releases).toMatchObject({ desc: 'acme/app', git: { kind: 'repo' } })
  // Same path with a different query / hash counts once
  expect(extract('https://github.com/acme/app/tree/main?x=1 https://github.com/acme/app/tree/main#y')).toHaveLength(1)
})

test('leaves GitHub root, owner pages, site pages and gists to Links', async () => {
  const found = extract('https://github.com https://github.com/acme https://github.com/orgs/acme/projects/1 https://gist.github.com/acme/abc')
  expect(found.map(u => u.git)).toEqual([undefined, undefined, undefined, undefined])
  expect(found.map(u => u.desc)).toEqual(['GitHub', 'acme', 'orgs', 'gist.github.com/acme'])
})

test('keeps a PR and an issue with the same number apart', async () => {
  const found = extract('https://github.com/a/b/pull/1 https://github.com/a/b/issues/1')
  expect(found.map(u => u.git?.kind)).toEqual(['pr', 'issue'])
})

test('cuts the sentence at the previous URL and falls back when it is not prose', async () => {
  const [, second] = extract('Docs https://a.dev/x and the thread https://b.dev/y')
  expect(second?.desc).toBe('and the thread')
  expect(extract('https://a.dev/x https://b.dev/y')[1]?.desc).toBe('b.dev/y')
  expect(extract('<Link href=https://c.dev/z')[0]?.desc).toBe('c.dev/z')
  expect(sentenceBefore('x: https://a.dev', 3)).toBeUndefined()
})

test('ignores URLs inside inline code and fences', async () => {
  const text = 'use `<Link href="https://a.dev/in">` then\n```\nfetch("https://b.dev/fenced")\n```\nreal https://c.dev/out'
  expect(extract(text).map(u => u.url)).toEqual(['https://c.dev/out'])
})

test('puts the newest first and keeps the better description', async () => {
  const first = extract('[Plan](https://a.dev/x) https://b.dev/y')
  const again = extract('https://a.dev/x')
  const list = merge(first, again)
  expect(list.map(u => u.url)).toEqual(['https://a.dev/x', 'https://b.dev/y'])
  expect(list[0]?.desc).toBe('Plan')
})

test('reads text and tool results out of a row', async () => {
  const content = [
    { type: 'text', text: 'a' },
    { type: 'tool_result', content: 'b' },
    { type: 'tool_result', content: [{ type: 'text', text: 'c' }, { type: 'image' }] },
    { type: 'tool_use', input: {} },
  ]
  expect(textOf(content)).toBe('a\nb\nc')
})

test('takes PR / issue links out of gh commands, from the output or the command', async () => {
  const keys = (command: string, output = '') => fromGh(command, output).map(u => u.key)
  expect(keys('cd x && gh pr create --fill', 'https://github.com/a/b/pull/3\nhttps://github.com/a/b')).toEqual(['a/b/pull/3'])
  expect(keys('gh issue close https://github.com/a/b/issues/4')).toEqual(['a/b/issues/4'])
  expect(keys('gh pr checks a/b#5')).toEqual(['a/b/pull/5'])
  expect(keys('gh pr merge -R a/b 6 --squash')).toEqual(['a/b/pull/6'])
  // Not a gh pr / issue action, or no repo to build the URL from: nothing
  expect(keys('echo https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1')).toEqual([])
  expect(keys('gh repo view a/b', 'https://github.com/a/b/pull/1')).toEqual([])
  expect(keys('gh pr view 7')).toEqual([])
  expect(GH_RE.test('gh pr list --limit 20')).toBe(true)
})

test('rebuilds urls from the transcript by the same rules, subagents only through gh', async () => {
  const messages: SessionMessage[] = [
    { role: 'user', text: 'see [Spec](https://docs.dev/spec)<system-reminder>https://docs.dev/reminder</system-reminder>', toolUses: [] },
    {
      role: 'assistant',
      text: 'I will look at https://docs.dev/reply',
      toolUses: [
        { tool_use_id: 't1', tool: 'Bash', input: { command: 'gh pr create' }, text: 'https://github.com/acme/app/pull/9' },
        { tool_use_id: 't2', tool: 'Bash', input: { command: 'cat a.md' }, text: 'https://github.com/acme/app/pull/1' },
        { tool_use_id: 't3', tool: 'Read', input: {}, text: 'https://docs.dev/read' },
        { tool_use_id: 't4', tool: 'mcp__slack__send', input: {}, text: 'sent https://acme.slack.com/archives/C1/p2' },
        { tool_use_id: 't5', tool: 'Agent', input: {}, agentId: 'a1', text: 'report https://docs.dev/report' },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [] },
  ]
  const child: SessionMessage[] = [
    { role: 'user', text: 'task https://docs.dev/task', toolUses: [] },
    {
      role: 'assistant',
      text: 'opened https://github.com/acme/app/pull/11',
      toolUses: [
        { tool_use_id: 'c1', tool: 'Bash', input: { command: 'gh pr create' }, text: 'https://github.com/acme/app/pull/10' },
        { tool_use_id: 'c2', tool: 'Artifact', input: {}, text: 'Published x.html at https://claude.ai/code/artifact/x' },
      ],
    },
  ]
  const list = urlsFromMessages(messages, new Map([['a1', child]]))
  expect(list.map(u => u.key)).toEqual(['acme/app/pull/10', 'https://acme.slack.com/archives/C1/p2', 'acme/app/pull/9', 'https://docs.dev/spec'])
})

test('reads gh only from the first line: heredoc bodies are data', async () => {
  const script = "python3 - <<'EOF'\nexpect(keys('cd x && gh pr create', 'https://github.com/a/b/pull/3'))\nEOF"
  expect(fromGh(script, 'https://github.com/a/b/pull/3')).toEqual([])
  const create = 'gh issue create -R a/b --body "$(cat <<\'EOF\'\nsee https://github.com/c/d/pull/9\nEOF\n)"'
  expect(fromGh(create, 'https://github.com/a/b/issues/12').map(u => u.key)).toEqual(['a/b/issues/12'])
})

test('ignores commands that only mention gh as text', async () => {
  expect(GH_RE.test('grep -rn "gh pr create" hooks')).toBe(false)
  expect(GH_RE.test('echo gh pr view 7')).toBe(false)
  expect(GH_RE.test('gh pr view 7 -R a/b')).toBe(true)
  expect(GH_RE.test('cd /x && gh pr create --fill')).toBe(true)
  expect(GH_RE.test('git push && gh pr create')).toBe(true)
})

test('groups a link by its main domain, with Artifact and local as their own sites', async () => {
  const site = (url: string) => siteOf(new URL(url))
  expect(site('https://acme.slack.com/archives/C1/p2')).toEqual({ key: 'slack.com', label: 'Slack' })
  expect(site('https://www.notion.so/Page-1')).toEqual({ key: 'notion.so', label: 'Notion' })
  expect(site('https://foo.bar.notion.site/x')).toEqual({ key: 'notion.site', label: 'Notion' })
  expect(site('https://claude.ai/artifact/x')).toEqual({ key: 'artifact', label: 'Artifact' })
  expect(site('https://claude.ai/chat/1')).toEqual({ key: 'claude.ai', label: 'Claude' })
  expect(site('http://localhost:3000/')).toEqual({ key: 'local', label: 'Local' })
  expect(site('http://127.0.0.1:8080/')).toEqual({ key: 'local', label: 'Local' })
  expect(site('https://figma.com/file/1')).toEqual({ key: 'figma.com', label: 'Figma' })
  expect(site('https://linear.app/acme/issue/A-1')).toEqual({ key: 'linear.app', label: 'Linear' })
})
