import type { Elements, RenderChildren, RenderNode, RenderSurface } from 'claude-code'

import type { SessionTheme } from './theme'

import type { FoldId, GitTab, SectionId } from '../types'

/** Row and section actions; the shell builds them (they need $), sections only attach them. */
export type RowActions = {
  /** key is the UrlEntry.key: after a successful copy that row's button turns into ✓ */
  copy: (url: string, key: string, surface: RenderSurface) => void
  dismiss: (key: string) => void
  /** Fold / unfold a section */
  fold: (id: FoldId) => void
  /** "+N more" / "Show less" / the Agents summary line: expand or collapse a section, a GitHub tab or the folded agents */
  more: (id: FoldId) => void
  /** Switch the GitHub tab, remembered across sessions */
  gitTab: (tab: GitTab) => void
  /** Switch the Links tab (a site group key), this session only */
  linksTab: (key: string) => void
  /** Pressing an agent's name: the engine has no API for a plugin to switch the transcript view, so open the tasks list and let the person pick */
  openAgent: () => void
}

/** What drawing needs: the element table (`$.ui.resolve(e)`), the pane's full width, row actions, color theme, the row just copied, and the row limits from settings. */
export type View = {
  t: Elements[RenderSurface]
  columns: number
  actions: RowActions
  theme: SessionTheme
  copied: string | null
  /** Rows per section or tab before "+N more" */
  visibleRows: number
  /** Links of one site needed to form a Links tab */
  tabThreshold: number
}

/**
 * Nerd Fonts Octicons (code points from Nerd Fonts 3.5.1 glyphnames.json); Ghostty falls back to its built-in Nerd symbols.
 * All private-use and single-cell, so width() counts each as 1 column.
 */
export const GLYPH = {
  /** nf-oct-git_pull_request */
  pr: '\uf407',
  /** nf-oct-git_merge */
  prMerged: '\uf419',
  /** nf-oct-git_pull_request_closed */
  prClosed: '\uf4dc',
  /** nf-oct-git_pull_request_draft */
  prDraft: '\uf4dd',
  /** nf-oct-issue_opened */
  issue: '\uf41b',
  /** nf-oct-repo */
  repo: '\uf401',
  /** nf-oct-link */
  link: '\uf44c',
  /** nf-oct-copy */
  copy: '\uf4bb',
  /** nf-oct-check */
  check: '\uf42e',
} as const
/** visible: rows drawn before the rest folds into "+N more"; left out, all are drawn. */
export type Block = { count: number; rows: RenderNode[]; visible?: number }

/**
 * One file per section, exporting `meta`; `render(view, ...values)`, pure, fed the atoms the shell read, called even when folded (the shell needs count);
 * and, if it collects data, `register(on)`, whose hooks write only that section's own atoms.
 * render never gets $: the engine only lets $ pass to functions in the same file and only lets a file read atoms it declares, so every $ call happens in the section's own hooks and lands in an atom.
 */
export type SectionMeta = { id: SectionId; title: string }

/** Icon / state word colors: white = in progress / open, green = done / passed, red = failed / needs action, purple = merged, gray = idle / closed / unknown. */
export type Tone = 'run' | 'ok' | 'bad' | 'merged' | 'dim'

const COLOR = { run: 'text', ok: 'success', bad: 'error', merged: 'merged' } as const

export const toneProps = (tone: Tone) => (tone === 'dim' ? { dimColor: true } : { color: COLOR[tone] })

/** CJK / full-width take two columns; only for truncation, not meant to cover every emoji. */
const isWide = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  )
}

/** Display width in columns. */
export function width(text: string) {
  let w = 0
  for (const ch of text) w += isWide(ch) ? 2 : 1
  return w
}

/** Cut to `columns` display columns, ending in …. Link has no wrap prop, so truncation is done here. */
export function fit(text: string, columns: number) {
  if (width(text) <= columns) return text
  let used = 0
  let out = ''
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1
    // Leave 2 columns for the …: the engine measures it as East Asian ambiguous, 2 wide, and with 1 left the line overflows by one and wraps
    if (used + w > columns - 2) break
    used += w
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** claude-opus-5-5[1m] → Opus 5.5, the Agent tool alias haiku → Haiku; anything unrecognised stays as is. Shared by Session and Agents. */
export function shortModel(model: string) {
  const m = /(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?/i.exec(model)
  if (!m) return model
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] ? `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : name
}

/** 7m 17s / 40s / 30m 12s / 1h 5m: seconds until the hour mark. */
export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

/** 114.8k / 1.2m / 950: written the way Claude writes its own token counts. */
export function tokenCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** "copy ×" takes 3 columns (× alone, 1), always reserved and drawn only on hover, so nothing shifts when it appears. */
const DISMISS = '×'
const ACTIONS_WIDTH = 3
/** Pressable titles underline and bold on hover: Link is an OSC 8 hyperlink with no pressed state, so hover is the only "you can press this" cue */
const PRESSABLE_HOVER = { underline: true, bold: true } as const

/**
 * One entry: main line "icon + space | title copy × | right-aligned right", optional sub line; both start at column 3 so sections line up.
 * Hovering either line counts. The title is cut to the columns left, on one line, never wrapped; right and the actions never shrink.
 */
export function item(
  view: View,
  row: {
    key: string
    icon: { glyph: string; tone: Tone }
    title: string
    /** Given: drawn as a Link */
    href?: string
    /** Given: the title is a plain Button calling it; exclusive with href */
    onPress?: () => void
    /** Right-aligned gray text such as Agents' "Done · 9s" */
    right?: string
    /** Sub line: a string or already-colored nodes */
    sub?: RenderChildren
    /** The UrlEntry's url and key: draws "copy ×" on hover, the buttons keyed by it */
    link?: { url: string; key: string }
    /** For rows with no URL to copy that only need × (Agents rows): the key pressing it records in dismissed */
    dismiss?: string
  },
) {
  const { Box, Text, Link, Button } = view.t
  const { link } = row
  const dismissKey = link?.key ?? row.dismiss
  const rightWidth = row.right ? width(row.right) + 2 : 0
  // Actions with their left margin: "copy ×" 4 columns, × alone 2
  const actionsWidth = link ? ACTIONS_WIDTH + 1 : dismissKey ? 2 : 0
  const label = fit(row.title, Math.max(8, view.columns - 2 - rightWidth - actionsWidth))
  const main = (
    // For a single-line entry this Box is the hover area (with a sub line, the outer two-line Box is)
    <Box key={row.sub === undefined ? row.key : undefined} flexDirection="row">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text {...toneProps(row.icon.tone)}>{row.icon.glyph} </Text>
        {/* Hover follows the nearest keyed Box, so the title lights up wherever the pointer is on the entry; Link has no hover prop, hence the inner Text */}
        {row.href ? (
          <Link href={row.href}>
            <Text hover={PRESSABLE_HOVER}>{label}</Text>
          </Link>
        ) : row.onPress ? (
          <Button key={`open:${row.key}`} plain label={label} hover={PRESSABLE_HOVER} onPress={row.onPress} />
        ) : (
          <Text wrap="truncate-end">{label}</Text>
        )}
        {/* Actions follow the title and draw only on hover; the cut title already left room, so nothing shifts */}
        {dismissKey && (
          <Box flexShrink={0} marginLeft={1} display="none" hover={{ display: 'flex' }}>
            {link && (
              <Button
                key={`copy:${link.key}`}
                plain
                dimColor
                label={view.copied === link.key ? GLYPH.check : GLYPH.copy}
                onPress={press => view.actions.copy(link.url, link.key, press.surface)}
              />
            )}
            {link && <Text> </Text>}
            <Button key={`dismiss:${dismissKey}`} plain dimColor label={DISMISS} onPress={() => view.actions.dismiss(dismissKey)} />
          </Box>
        )}
      </Box>
      {row.right && (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{row.right}</Text>
        </Box>
      )}
    </Box>
  )
  if (row.sub === undefined) return main
  return (
    <Box key={row.key} flexDirection="column">
      {main}
      <Box marginLeft={2}>
        <Text dimColor wrap="truncate-end">
          {row.sub}
        </Text>
      </Box>
    </Box>
  )
}

/** Unexpanded, only the first `visible` rows draw and the rest fold into "+N more", which becomes "Show less" once expanded; shared by sections and the GitHub / Links tabs. */
export function withMore(view: View, id: FoldId, rows: RenderNode[], visible: number, isExpanded: boolean): RenderNode[] {
  const hidden = rows.length - visible
  if (hidden <= 0) return rows
  const { Box, Button } = view.t
  return [
    ...(isExpanded ? rows : rows.slice(0, visible)),
    <Box key={`more-row:${id}`} marginLeft={2}>
      <Button key={`more:${id}`} plain dimColor label={isExpanded ? 'Show less' : `+${hidden} more`} onPress={() => view.actions.more(id)} />
    </Box>,
  ]
}

/** One tab in a tab row: count drawn after the name, 0 included (in gray) */
export type TabItem<T extends string> = { id: T; name: string; count: number }

/** If the selected tab is gone or empty, land on the first with rows; if all are empty, stay on the selected one */
export function activeTab<T extends string>(items: readonly TabItem<T>[], selected: T) {
  if (items.some(tab => tab.id === selected && tab.count > 0)) return selected
  return items.find(tab => tab.count > 0)?.id ?? selected
}

/**
 * A tab row " PR 1    Issue 0 ": the selected one inverse, the rest gray and pressable, buttons keyed `tab:<section>:<id>`; shared by GitHub and Links.
 * Each label is padded one cell each side so the inverse one reads as a tag; one more cell between tabs makes three between words.
 * The selected tab is an inverse Text, not a Button: Button has no inverse and cannot sit inside Text, and pressing the selected tab does nothing anyway
 */
export function tabs<T extends string>(view: View, section: SectionId, items: readonly TabItem<T>[], active: T, onPick: (id: T) => void) {
  const { Box, Text, Button } = view.t
  return (
    // A blank line below: rows hugging the tab row look cramped
    <Box key={`${section}-tabs`} flexDirection="row" marginBottom={1}>
      {items.map((tab, i) => {
        const label = ` ${tab.name} ${tab.count} `
        const key = `tab:${section}:${tab.id}`
        return [
          i > 0 && <Text key={`tab-gap:${section}:${tab.id}`}> </Text>,
          tab.id === active ? (
            <Text key={key} inverse>
              {label}
            </Text>
          ) : (
            <Button key={key} plain dimColor label={label} onPress={() => onPick(tab.id)} />
          ),
        ]
      })}
    </Box>
  )
}
