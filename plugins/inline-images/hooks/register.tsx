import type { Register } from 'claude-code'

const TOOL = 'mcp__inline-images__show_images'
const GAP = 2
/** Side by side, each image needs at least this many columns to stay legible; narrower falls back to stacked. */
const MIN_ROW_COLUMNS = 40

// The runtime has it (as the engine's own docs use it), but the es2023 lib the engine's tsconfig names does not declare it
declare global {
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array
  }
}

type Shown = { path: string; label: string; width: number; height: number }
type Layout = 'stack' | 'row'
type Preview = { layout: Layout; shown: Shown[] }

/** PNG width and height sit in IHDR, bytes 16–23, big-endian. Unreadable: assume 16:10, so a wrong ratio still draws. */
export function pngSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const isPng = bytes.length >= 24 && view.getUint32(0) === 0x89504e47
  return isPng ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 16, height: 10 }
}

/** Terminal cells are about twice as tall as wide; sizing rows to the image's ratio keeps Image from stretching it to the box. */
export function rowsFor(image: { width: number; height: number }, columns: number) {
  return Math.max(1, Math.min(60, Math.round((columns * image.height) / image.width / 2)))
}

/** Side by side, images split the width evenly with GAP columns between them. */
export function columnsFor(layout: Layout, count: number, available: number) {
  const total = Math.max(20, Math.min(layout === 'row' ? 200 : 100, available))
  return layout === 'row' ? Math.max(10, Math.floor((total - GAP * (count - 1)) / count)) : total
}

/**
 * The model only gets the tool where pixels can be drawn: in the desktop app, -p or tmux it would just make a wasted call.
 * Claude Code does not expose the terminal's graphics support, so this goes by the variables the terminal sets itself.
 */
export function drawsImages(env: { term?: string; termProgram?: string; tmux?: string }) {
  if (env.tmux) return false
  return env.termProgram === 'ghostty' || /ghostty|kitty/.test(env.term ?? '')
}

/** A plugin tool's result can only be a string: the list travels to the renderer as JSON, and the model reads the same list. */
export function parsePreview(output: unknown): Preview | null {
  try {
    const parsed = JSON.parse(String(output)) as Partial<Preview>
    if (!Array.isArray(parsed.shown) || parsed.shown.length === 0) return null
    return { layout: parsed.layout === 'row' ? 'row' : 'stack', shown: parsed.shown }
  } catch {
    return null
  }
}

export const register: Register = (on, options) => {
  // For kitty / Ghostty setups the env check misses, e.g. TERM rewritten by ssh or sudo
  const force = options.force === true

  on('session.start', async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.isInteractive) return next(e)
    const env = {
      term: await $.env.get('TERM'),
      termProgram: await $.env.get('TERM_PROGRAM'),
      tmux: await $.env.get('TMUX'),
    }
    if (!force && !drawsImages(env)) return next(e)
    await $.tool.register({
      name: 'show_images',
      description:
        'Draw PNG images for the user inline in the conversation (Ghostty / kitty). Use it whenever you produce screenshots the user should look at. For before / after comparisons pass layout "row" to put them side by side. Paths must be absolute .png files.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          layout: {
            type: 'string',
            enum: ['stack', 'row'],
            description: '"row": side by side, for comparing 2–3 images; default "stack": one per line',
          },
          images: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path of a .png file' },
                label: { type: 'string', description: 'Short caption, e.g. "Before"' },
              },
              required: ['path'],
            },
          },
        },
        required: ['images'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // Tool arguments sit flat on e beside tool / tool_use_id
    const { images = [], layout } = e as { images?: { path?: string; label?: string }[]; layout?: string }
    const shown: Shown[] = []
    for (const [index, item] of images.slice(0, 4).entries()) {
      const path = item.path ?? ''
      if (!path.startsWith('/') || !path.toLowerCase().endsWith('.png')) {
        return { deny: `Not an absolute .png path: ${path}` }
      }
      if (!(await $.fs.exists(path))) return { deny: `File not found: ${path}` }
      let size = { width: 16, height: 10 }
      try {
        const { base64 } = await $.fs.read(path, { as: 'bytes' })
        size = pngSize(Uint8Array.fromBase64(base64))
      } catch {
        // Over 4 MiB it cannot be read in: the terminal reads the file itself and still draws it, only the ratio is guessed
      }
      shown.push({ path, label: item.label ?? `#${index + 1}`, ...size })
    }
    if (shown.length === 0) return { deny: 'No images given' }
    const preview: Preview = { layout: layout === 'row' ? 'row' : 'stack', shown }
    return { result: JSON.stringify(preview) }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isErrored || e.surface !== 'terminal') return next(e)
    const preview = parsePreview(e.props.output)
    if (!preview) return next(e)
    const { Box, Button, Image } = $.ui.resolve(e)
    const { shown } = preview
    const available = (e.viewport?.columns ?? 80) - 6
    const layout =
      preview.layout === 'row' && columnsFor('row', shown.length, available) >= MIN_ROW_COLUMNS ? 'row' : 'stack'
    const columns = columnsFor(layout, shown.length, available)
    return (
      <Box flexDirection={layout === 'row' ? 'row' : 'column'} columnGap={GAP} marginTop={1}>
        {shown.map((image, index) => (
          <Box flexDirection="column" width={columns} marginBottom={layout === 'row' ? 0 : 1}>
            {/* Image takes no press, so the caption is the button that opens the original in the default viewer. Not a file:// link: Ghostty reveals those in Finder instead */}
            <Button
              plain
              dimColor
              label={image.label}
              onPress={async () => {
                // The file may be gone by now: say so on a non-zero exit or a failed launch rather than fail silently
                const opened = await $.process.run(['open', image.path]).then(r => r.exitCode === 0, () => false)
                if (!opened) $.ui.toast(`Cannot open ${image.path}`)
              }}
            />
            <Image
              key={`image-${index}`}
              source={{ file: image.path, format: 'png' }}
              columns={columns}
              rows={rowsFor(image, columns)}
              alt={`${image.label}: ${image.path}`}
            />
          </Box>
        ))}
      </Box>
    )
  })
}
