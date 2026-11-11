import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRow, GitInfo, UrlEntry } from '../types'
import { mergeAgents } from './sections/agents'
import { union } from './sources/urls'

// Written by their sections; declared again under the same keys, since carrying them across processes is this file's one job
const urls = atom({ plugin: 'panel', key: 'urls' } as const, [])
const titles = atom({ plugin: 'panel', key: 'titles' } as const, {})
const agents = atom({ plugin: 'panel', key: 'agents' } as const, [])
const gitStatus = atom({ plugin: 'panel', key: 'gitStatus' } as const, {})

/** The rows a session has collected, saved under `session:<id>` in $.store. */
export type Snapshot = {
  urls: UrlEntry[]
  titles: Record<string, string>
  agents: AgentRow[]
  gitStatus: Record<string, GitInfo>
}

const PREFIX = 'session:'
/** Sessions kept, the least recently opened dropped first; a session tops out near 100 KB (the sections' own limits), under the store's 4 MiB */
const KEEP = 30
const SAVE_MS = 10_000

const isRecord = (value: unknown): value is Record<string, never> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A stored value as a snapshot; a part missing or of another shape (an older version wrote it) is empty. */
export function parse(value: unknown): Snapshot {
  const v: Record<string, unknown> = isRecord(value) ? value : {}
  return {
    urls: Array.isArray(v.urls) ? v.urls : [],
    titles: isRecord(v.titles) ? v.titles : {},
    agents: Array.isArray(v.agents) ? v.agents : [],
    gitStatus: isRecord(v.gitStatus) ? v.gitStatus : {},
  }
}

/** What the atoms hold now, in the shape that is saved: titles and statuses only for the links listed, so a copy stays within the sections' limits. */
async function current($: EngineInterface): Promise<Snapshot> {
  const [u, t, a, g] = await Promise.all([read($, urls), read($, titles), read($, agents), read($, gitStatus)])
  const keys = new Set(u.map(entry => entry.key))
  const listed = <T>(all: Record<string, T>) => Object.fromEntries(Object.entries(all).filter(([key]) => keys.has(key)))
  return { urls: u, titles: listed(t), agents: a, gitStatus: listed(g) }
}

/** Writes the copy under key when it changed since the last write; resolves to what is now saved. A session with no rows writes nothing, so it never pushes one that has some out of KEEP. */
async function save($: EngineInterface, key: string, last: string) {
  const now = await current($)
  const text = JSON.stringify(now)
  if (text === last || (now.urls.length === 0 && now.agents.length === 0)) return text
  await $.store.set(key, now)
  return text
}

/** The saved copy goes under what the atoms hold, whichever of this and the sections' transcript rebuilds runs first: both only merge. Resolves to whether a copy was there. */
async function restore($: EngineInterface, key: string) {
  const stored = await $.store.get(key)
  const saved = parse(stored)
  await update($, urls, list => union(list, saved.urls))
  await update($, titles, all => ({ ...saved.titles, ...all }))
  await update($, agents, list => mergeAgents(list, saved.agents))
  await update($, gitStatus, all => ({ ...saved.gitStatus, ...all }))
  return stored !== undefined
}

/** Drops the least recently opened sessions past KEEP, this one aside: store keys keep insertion order, oldest first. */
async function prune($: EngineInterface, key: string) {
  const others = (await $.store.keys()).filter(k => k.startsWith(PREFIX) && k !== key)
  for (const old of others.slice(0, Math.max(0, others.length - (KEEP - 1)))) await $.store.delete(old)
}

/**
 * Takes up the copy under key: merged back, the sessions past KEEP dropped, and key deleted so the next save writes it at the end, the last pruning reaches
 * (the atoms hold the copy meanwhile). False when the copy could not be read: nothing may be written over it.
 */
async function open($: EngineInterface, key: string) {
  const isStored = await restore($, key).catch(() => undefined)
  if (isStored === undefined) return false
  await prune($, key).catch(() => undefined)
  if (isStored) await $.store.delete(key).catch(() => undefined)
  return true
}

/**
 * $.session.messages() holds only what the last compaction kept, so after a restart or --resume the sections can rebuild only that part.
 * This keeps the rest: the atoms are saved per session while it runs and merged back when it starts again.
 */
export function register(on: On) {
  on('session.start', { surface: 'terminal', isInteractive: true }, async ($, e, next) => {
    $.clock.after(1, async () => {
      let key = ''
      let last = ''
      // ponytail: a failed write (the store over its limit) is retried each tick, never reported; prune by size if that shows up
      const tick = async () => {
        const id = PREFIX + (await $.session.id())
        // /clear and an in-process /resume go on under another id with no session.start: that session's copy is taken up before anything is written over it
        if (id !== key) {
          if (!(await open($, id))) return
          key = id
          last = ''
        }
        last = await save($, key, last)
      }
      await tick().catch(() => undefined)
      // A copy that could not be taken up at start is left alone for this process
      if (!key) return
      $.clock.every(SAVE_MS, () => void tick().catch(() => undefined))
    })
    return next(e)
  })
}
