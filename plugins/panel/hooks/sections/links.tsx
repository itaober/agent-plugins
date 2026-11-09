import type { FoldId, UrlEntry } from '../../types'
import { activeTab, fit, GLYPH, item, tabs, withMore } from '../section'
import type { Block, SectionMeta, TabItem, View } from '../section'
import { descOf, siteOf } from '../sources/urls'

const LIMIT = 30
const OTHERS = 'others'

export const meta: SectionMeta = { id: 'links', title: 'Links' }

/**
 * Reads urls minus GitHub's (every link under a github.com repo belongs to the GitHub section) and the ones dismissed with ×. Two lines: description (a model title over a weak one, descOf) … copy ×; then the full URL, cut at the end if it does not fit.
 * Grouped by site (siteOf): a site with view.tabThreshold or more links gets its own tab, bigger first, the rest go to Others (always last); with no site that big there is no tab row and the list stays flat.
 * Tabs and "+N more" are drawn as in GitHub; if the selected tab disappears, the first with rows takes over.
 */
export function render(
  view: View,
  list: UrlEntry[],
  titles: Readonly<Record<string, string>>,
  dismissed: readonly string[],
  selected: string,
  expanded: readonly FoldId[],
): Block {
  const shown = list.filter(u => !u.git && !dismissed.includes(u.key)).slice(0, LIMIT)
  const draw = (u: UrlEntry) =>
    item(view, { key: `link-${u.key}`, icon: { glyph: GLYPH.link, tone: 'dim' }, title: descOf(u, titles), href: u.url, sub: fit(u.url, view.columns - 2), link: u })

  const sites = shown.map(u => siteOf(new URL(u.url)))
  const counts = new Map<string, number>()
  for (const site of sites) counts.set(site.key, (counts.get(site.key) ?? 0) + 1)
  const tabOf = (key: string) => ((counts.get(key) ?? 0) >= view.tabThreshold ? key : OTHERS)
  const items: TabItem<string>[] = [...new Map(sites.map(site => [site.key, site.label]))]
    .filter(([key]) => tabOf(key) !== OTHERS)
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count)
  if (items.length === 0) return { count: shown.length, visible: view.visibleRows, rows: shown.map(draw) }

  items.push({ id: OTHERS, name: 'Others', count: sites.filter(site => tabOf(site.key) === OTHERS).length })
  const active = activeTab(items, selected)
  const rows = shown.filter((_, i) => tabOf(sites[i]!.key) === active).map(draw)
  const id: FoldId = `links:${active}`
  return { count: shown.length, rows: [tabs(view, 'links', items, active, view.actions.linksTab), ...withMore(view, id, rows, view.visibleRows, expanded.includes(id))] }
}
