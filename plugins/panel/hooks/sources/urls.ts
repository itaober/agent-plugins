import { atom, update } from 'claude-code'
import type { On, SessionMessage } from 'claude-code'

import type { UrlEntry } from '../../types'

const urls = atom({ plugin: 'panel', key: 'urls' } as const, [])

const LIMIT = 200
/** Page assets and spec sites: they show up in source and docs, not as links you would open, so they are never collected. */
const NOISE = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'npmjs.com', 'npmjs.org', 'w3.org', 'schema.org']
/** A URL also ends at full-width CJK punctuation and closing brackets (escaped to keep CJK out of the source) */
const URL_BODY = String.raw`https?://[^\s<>"'\`)\]}|\uff0c\u3002\u3001\uff1b\uff01\uff1f\uff09\u3011\u300d]+`
const URL_RE = new RegExp(URL_BODY, 'g')
const MD_RE = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g
const GIT_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/
/** github.com paths whose first segment is one of these are the site's own pages, not repos: they go to Links, like github.com itself and owner pages */
const NOT_OWNER = new Set(['orgs', 'settings', 'notifications', 'marketplace', 'sponsors', 'apps', 'features', 'topics', 'search', 'login', 'new'])
/** The Artifact tool reports `Published <file> … at <url>`; the file name makes a better title than the preceding sentence. */
const PUBLISHED_RE = new RegExp(String.raw`Published\s+(\S+?)\s[^\n]*?\bat\s+(${URL_BODY})`, 'g')
/** Sentence-ending punctuation is not part of the URL */
const trimTail = (url: string) => url.replace(/[.,;:!?]+$/, '')

const isNoise = (host: string) =>
  NOISE.some(d => host === d || host.endsWith(`.${d}`)) ||
  host === 'example.com' || host.endsWith('.example.com') ||
  // Dotless names such as bridge or host are placeholder hosts in docs; localhost is the exception
  (!host.includes('.') && host !== 'localhost')

/**
 * Only links this session produced or acted on are collected, not ones text merely mentions (as the Claude app does). Besides prompts, the two constants below are the only sources.
 * Producer tools: links in their results are things just published, sent or created (Artifact publishes; Slack, Notion, Docs and other MCP tools).
 * Read / Grep / WebFetch / Agent / plain Bash results hold source, docs and reports, and are never collected.
 */
export const PRODUCER_TOOL_RE = /^(?:Artifact$|mcp__)/
/** Browser automation is reading, like WebFetch: pages it navigated (logins, consoles, search results) are not links it produced, and their results carry no description but host/path */
const BROWSER_TOOL_RE = /^mcp__(?:claude-in-chrome|browseros|chrome-devtools|playwright|puppeteer)__/
/** gh commands that act on a PR / issue: only these Bash calls' results contribute PRs / issues; echo, cat and test output do not. */
/** gh must start a command (or follow && ; |); commands carrying gh as a string, like `grep "gh pr create" …`, do not count */
export const GH_RE = /(?:^|[;&|(]\s*|\bcd\s+\S+\s*&&\s*)gh\s+(pr|issue)\s+(create|view|merge|comment|checks|review|edit|close|reopen|ready|diff|status|list)\b/
/** Blocks the engine injects next to a prompt (reminders, notifications, teammate messages) are not yours and are stripped when rebuilding; a row's isMeta is not visible on SessionMessage */
const INJECTED_RE = /<(system-reminder|task-notification|teammate-message|local-command-stdout|local-command-stderr)\b[^>]*>[\s\S]*?<\/\1>/g

const isProducer = (tool: string | undefined) => tool !== undefined && PRODUCER_TOOL_RE.test(tool) && !BROWSER_TOOL_RE.test(tool)

/**
 * The sentence before a URL: same line only, after the previous URL, with tails like "see / link / :" and markdown marks removed, at most 24 characters.
 * Anything that does not read as prose (contains http, looks like code, fewer than 2 letters or digits) is dropped in favour of the host/path fallback.
 * The tail words also cover Chinese ("(please) see / look / open / link / address / here") and full-width CJK punctuation.
 */
export function sentenceBefore(text: string, index: number, from = 0) {
  const line = text.slice(Math.max(from, text.lastIndexOf('\n', index - 1) + 1), index)
  const sentence = line.split(/[\u3002\uff01\uff1f!?]\s*|\.\s+|\|/).pop() ?? ''
  const cleaned = sentence
    .replace(/^[\s>*#\-+\d.`_]+/, '')
    .replace(/[\s:\uff1a,\uff0c(\uff08\[\u3010<→=*`_-]+$/, '')
    .replace(/(\u8bf7)?(\u89c1|\u770b|\u6253\u5f00|\u94fe\u63a5|\u5730\u5740|\u5728\u8fd9\u91cc?|at|here|see|link)$/i, '')
    .replace(/[\s:\uff1a,\uff0c(\uff08\[\u3010<→=*`_-]+$/, '')
    .trim()
  const isProse = !/https?:|[<>{}=]/i.test(cleaned) && (cleaned.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2
  return isProse ? [...cleaned].slice(0, 24).join('') : undefined
}

/** URLs in code (``` fences and `inline`) are not links to open: blank them out with spaces of equal length, so later indexes still hold. */
function maskCode(text: string) {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, code => code.replace(/[^\n]/g, ' '))
}

/**
 * A link's site: grouped by main domain (the last two labels of the hostname; two-label suffixes like co.uk are not handled), with claude.ai Artifacts and local hosts as their own sites;
 * the label is the key's name part, capitalised. The Links tabs and the fallback description below share it, so there is no hard-coded site list.
 */
export function siteOf(url: URL) {
  const host = url.hostname
  const domain = host.split('.').slice(-2).join('.')
  const key =
    host === 'localhost' || host === '127.0.0.1' ? 'local' : domain === 'claude.ai' && url.pathname.includes('/artifact') ? 'artifact' : domain
  const name = key.split('.')[0] ?? key
  return { key, label: name.charAt(0).toUpperCase() + name.slice(1) }
}

/** With no better description, a readable name per site instead of a bare host/path. */
function fallbackDesc(url: URL) {
  const host = url.hostname.replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  const site = siteOf(url).key
  if (site === 'local') return 'Local dev server'
  // Links under a repo already went to GitHub (githubEntry); only github.com itself and owner pages reach here
  if (host === 'github.com') return parts[0] ?? 'GitHub'
  if (site === 'slack.com') return 'Slack thread'
  if (site === 'artifact') return 'Artifact'
  if (site === 'notion.so' || site === 'notion.site') {
    const page = parts.at(-1)?.replace(/-[0-9a-f]{32}$/i, '').replace(/-/g, ' ')
    return page || 'Notion'
  }
  return `${host}${parts[0] ? `/${parts[0]}` : ''}`
}

/**
 * Every link under github.com/<owner>/<repo> belongs to GitHub: PRs / issues normalise to `/pull|issues/n`;
 * the rest (home, blob, tree, releases, actions…) are repo entries with desc owner/repo, deep links adding the path after the ref.
 */
function githubEntry(raw: string, url: URL): UrlEntry | undefined {
  const git = GIT_RE.exec(raw)
  if (git) {
    return {
      key: `${git[1]}/${git[2]}/${git[3]}/${git[4]}`,
      url: `https://github.com/${git[1]}/${git[2]}/${git[3]}/${git[4]}`,
      desc: `#${git[4]}`,
      rank: 4,
      git: { kind: git[3] === 'pull' ? 'pr' : 'issue', repo: `${git[1]}/${git[2]}`, number: Number(git[4]) },
    }
  }
  if (url.hostname.replace(/^www\./, '') !== 'github.com') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2 || NOT_OWNER.has(parts[0]!)) return undefined
  const repo = `${parts[0]}/${parts[1]}`
  // blob/<ref>/a.ts and the like: skip the blob / tree segment, start at the ref
  const desc = parts.length > 3 ? `${repo} · ${parts.slice(3).join('/')}` : repo
  return { key: parts.join('/'), url: raw, desc, rank: 4, git: { kind: 'repo', repo, path: parts.slice(2).join('/') } }
}

/** URLs in a text with descriptions, by priority 1 markdown, 2 known site, 3 preceding sentence, 4 fallback. */
export function extract(source: string, allowSentence = true): UrlEntry[] {
  const text = maskCode(source)
  const named = new Map<string, { desc: string; rank: number }>()
  for (const m of text.matchAll(MD_RE)) named.set(m[2]!, { desc: m[1]!.trim(), rank: 1 })
  for (const m of text.matchAll(PUBLISHED_RE)) {
    const url = trimTail(m[2]!)
    if (!named.has(url)) named.set(url, { desc: m[1]!.split('/').pop()!.replace(/\.\w+$/, ''), rank: 2 })
  }
  const found = new Map<string, UrlEntry>()
  let lastEnd = 0
  for (const m of text.matchAll(URL_RE)) {
    const from = lastEnd
    lastEnd = m.index + m[0].length
    const raw = trimTail(m[0])
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (isNoise(url.hostname)) continue
    let entry = githubEntry(raw, url)
    if (!entry) {
      const before = named.has(raw) || !allowSentence ? undefined : sentenceBefore(text, m.index, from)
      const described = named.get(raw) ?? (before ? { desc: before, rank: 3 } : { desc: fallbackDesc(url), rank: 4 })
      entry = { key: raw, url: raw, ...described }
    }
    const seen = found.get(entry.key)
    if (!seen || entry.rank < seen.rank) found.set(entry.key, entry)
  }
  return [...found.values()]
}

/** Newest first; a repeat moves to the front too, keeping the more trustworthy description. */
export function merge(list: UrlEntry[], found: UrlEntry[]) {
  if (found.length === 0) return list
  const byKey = new Map(list.map(u => [u.key, u]))
  const fresh = found.map(u => {
    const old = byKey.get(u.key)
    return old && old.rank <= u.rank ? { ...u, desc: old.desc, rank: old.rank } : u
  })
  const keys = new Set(fresh.map(u => u.key))
  return [...fresh.reverse(), ...list.filter(u => !keys.has(u.key))].slice(0, LIMIT)
}

/** The readable text of a row: text blocks, and a tool_result's string or text sub-blocks. */
export function textOf(content: readonly { type: string; [field: string]: unknown }[]) {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type !== 'tool_result') continue
    const inner = block.content
    if (typeof inner === 'string') parts.push(inner)
    else if (Array.isArray(inner)) {
      for (const sub of inner as { type?: string; text?: unknown }[]) {
        if (sub.type === 'text' && typeof sub.text === 'string') parts.push(sub.text)
      }
    }
  }
  return parts.join('\n')
}

/**
 * PRs / issues of one gh command: from the output first (create prints the URL, view ends with it); failing that, a URL in the command, `owner/repo#n`, or `-R owner/repo <n>`.
 * PRs and issues only: a repo link does not count as acted on.
 */
export function fromGh(command: string, output: string): UrlEntry[] {
  // Only the command's first line: gh and URLs in a heredoc or multi-line script body are data, not actions (`gh … --body "$(cat <<EOF` keeps gh itself on the first line)
  const head = command.split('\n')[0] ?? ''
  const gh = GH_RE.exec(head)
  if (!gh) return []
  const isItem = (u: UrlEntry) => u.git !== undefined && u.git.kind !== 'repo'
  const found = extract(output, false).filter(isItem)
  if (found.length > 0) return found
  const inCommand = extract(head, false).filter(isItem)
  if (inCommand.length > 0) return inCommand
  const kind = gh[1] === 'pr' ? 'pull' : 'issues'
  const short = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/.exec(head)
  if (short) return extract(`https://github.com/${short[1]}/${kind}/${short[2]}`, false)
  const repo = /(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/.exec(head)?.[1]
  // ponytail: the number is the first bare integer after the subcommand not following a flag; `--squash 12` style is missed, and then the output's URL has to do
  const args = head.slice(gh.index + gh[0].length).trim().split(/\s+/)
  const number = args.find((a, i) => /^\d+$/.test(a) && !args[i - 1]?.startsWith('-'))
  return repo && number ? extract(`https://github.com/${repo}/${kind}/${number}`, false) : []
}

/** Links one tool call produced: gh commands contribute PRs / issues only; producer tools' results get site fallback descriptions; nothing else counts. */
function fromToolUse(u: SessionMessage['toolUses'][number]) {
  if (u.tool === 'Bash') return typeof u.input.command === 'string' ? fromGh(u.input.command, u.text ?? '') : []
  return isProducer(u.tool) ? extract(u.text ?? '', false) : []
}

/**
 * Rebuilds urls from the conversation by the same rules as live collection: merged message by message in time order, newest first.
 * The main conversation contributes your prompts (user rows' text; tool result rows have none), gh commands and producer tools; subagents contribute gh commands only.
 */
export function urlsFromMessages(messages: readonly SessionMessage[], children: ReadonlyMap<string, readonly SessionMessage[]>) {
  let list: UrlEntry[] = []
  for (const m of messages) {
    if (m.role === 'user') list = merge(list, extract(m.text.replace(INJECTED_RE, '')))
    list = merge(list, m.toolUses.flatMap(fromToolUse))
    for (const use of m.toolUses) {
      const child = use.agentId ? children.get(use.agentId) : undefined
      for (const c of child ?? []) {
        list = merge(list, c.toolUses.flatMap(u => (u.tool === 'Bash' ? fromToolUse(u) : [])))
      }
    }
  }
  return list
}

/** The session's only URL scanner: what you pasted, what gh acted on, what producer tools returned; assistant replies and other tool results are not collected. */
export function register(on: On) {
  // Your prompts and producer tools' results. Subagent rows are skipped (their gh commands go through tool.call below); Bash result rows are judged in tool.call, where the command is visible
  on('session.append', { door: ['prompt', 'tool-result'] }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const isPrompt = e.door === 'prompt' && !e.message.isMeta
    const isProduced = e.door === 'tool-result' && e.origin.kind === 'tool' && isProducer(e.origin.tool)
    if (!isPrompt && !isProduced) return next(e)
    // Tool result text is not prose: descriptions fall back to the site only
    const found = extract(textOf(e.message.content), isPrompt)
    // Write before next: the git section's session.append in this plugin reads the new entries after next returns, whichever layer it sits on
    if (found.length > 0) await update($, urls, list => merge(list, found))
    return next(e)
  })

  // The command is only visible in tool.call; subagent calls come through here too. Returns after writing, and the result row's session.append comes later, so the git section sees the new entries
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      const found = fromGh(e.command, ran.text ?? '')
      if (found.length > 0) await update($, urls, list => merge(list, found))
    }
    return ran
  })

  // Startup and hot reload both rebuild from the transcript: old entries then follow changed description rules, and a scan of the conversation is cheap. On a timer so startup is not held up
  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    $.clock.after(1, async () => {
      const messages = await $.session.messages()
      const children = new Map<string, SessionMessage[]>()
      for (const use of messages.flatMap(m => m.toolUses)) {
        if (!use.agentId) continue
        const child = await $.session.messages({ agentId: use.agentId })
        if (Array.isArray(child)) children.set(use.agentId, child)
      }
      const rebuilt = urlsFromMessages(messages, children)
      if (rebuilt.length > 0) await update($, urls, () => rebuilt)
    })
    return next(e)
  })
}
