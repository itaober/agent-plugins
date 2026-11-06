import type { Color } from 'claude-code'

export type SessionTheme = 'gruvbox' | 'hud' | 'terminal'

/** Color roles in the Session block; the three themes swap colors only here, drawing code knows only roles. */
export type Role = 'label' | 'ok' | 'warn' | 'bad' | 'usage' | 'usageWarn' | 'branch' | 'dirty' | 'model' | 'effort'

/** Color props spread straight onto a Text. */
export type Paint = { color: Color } | { dimColor: true }

const c = (color: Color): Paint => ({ color })
const dim: Paint = { dimColor: true }

export const THEMES: Record<SessionTheme, Record<Role, Paint>> = {
  gruvbox: {
    label: c('#928374'),
    ok: c('#b8bb26'),
    warn: c('#fabd2f'),
    bad: c('#fb4934'),
    usage: c('#83a598'),
    usageWarn: c('#d3869b'),
    branch: c('#8ec07c'),
    dirty: c('#fe8019'),
    model: c('#8ec07c'),
    effort: c('#d3869b'),
  },
  // claude-hud's default colors
  hud: {
    label: dim,
    ok: c('green'),
    warn: c('yellow'),
    bad: c('red'),
    usage: c('blue'),
    usageWarn: c('magenta'),
    branch: c('cyan'),
    dirty: c('magenta'),
    model: c('cyan'),
    effort: c('magenta'),
  },
  // ThemeKeys only, so it follows the Claude theme
  terminal: {
    label: c('subtle'),
    ok: c('success'),
    warn: c('warning'),
    bad: c('error'),
    usage: c('text'),
    usageWarn: c('merged'),
    branch: c('text'),
    dirty: c('merged'),
    model: c('text'),
    effort: c('merged'),
  },
}

export const SESSION_THEMES = Object.keys(THEMES) as SessionTheme[]

/** Role for a percentage: Context ≥85 bad, ≥70 warn; 5h / Week ≥90 bad, ≥75 warn. */
export function levelRole(kind: 'context' | 'usage', percent: number): Role {
  if (kind === 'context') return percent >= 85 ? 'bad' : percent >= 70 ? 'warn' : 'ok'
  return percent >= 90 ? 'bad' : percent >= 75 ? 'usageWarn' : 'usage'
}

export const BAR_CELLS = 10

/** Progress bar as [filled, empty], colored apart: filled in the value's color, empty in label gray, as claude-hud does. */
export function bar(percent: number): [string, string] {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((percent / 100) * BAR_CELLS)))
  return ['█'.repeat(filled), '░'.repeat(BAR_CELLS - filled)]
}
