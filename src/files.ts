import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Config } from './config.js'
import { globToRegExp, mimeOf, sha256Hex } from './util.js'

export interface SiteFile {
  /** Absolute site path, e.g. /assets/app.js */
  path: string
  data: Uint8Array
  sha256: string
  type: string
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** Adds `<meta name="anofront:canonical">` so the app (anoDB) can tell when it runs on a mirror. */
export function injectCanonical(html: string, canonical: string): string {
  const tag = `<meta name="anofront:canonical" content="${canonical}">`
  const cleaned = html.replace(/<meta name="anofront:canonical"[^>]*>\s*/gi, '')
  const m = /<head(\s[^>]*)?>/i.exec(cleaned)
  if (!m) return tag + cleaned
  const at = m.index + m[0].length
  return cleaned.slice(0, at) + tag + cleaned.slice(at)
}

const isHidden = (path: string) =>
  path.split('/').some((s) => (s.startsWith('.') && s !== '.well-known') || s === 'node_modules') || path === '/anofront.json'

export interface CollectResult {
  files: SiteFile[]
  spa: boolean
  warnings: string[]
}

export async function collect(cwd: string, cfg: Config, canonical: string): Promise<CollectResult> {
  const root = join(cwd, cfg.dir)
  let abs: string[]
  try {
    abs = await walk(root)
  } catch {
    throw new Error(`Build output not found: ${root}. Build first, or fix "dir" in anofront.json.`)
  }
  const excludes = (cfg.exclude ?? []).map(globToRegExp)
  const warnings: string[] = []
  const byPath = new Map<string, SiteFile>()
  for (const file of abs.sort()) {
    const path = '/' + relative(root, file).split(sep).join('/')
    if (isHidden(path) || excludes.some((re) => re.test(path))) continue
    let data: Uint8Array = await readFile(file)
    if (data.byteLength > MAX_FILE_BYTES) warnings.push(`${path} is ${(data.byteLength / 1048576).toFixed(1)} MB; some Blossom servers reject large files`)
    const type = mimeOf(path)
    if (type === 'text/html') data = new TextEncoder().encode(injectCanonical(new TextDecoder().decode(data), canonical))
    byPath.set(path, { path, data, sha256: sha256Hex(data), type })
  }
  const index = byPath.get('/index.html')
  if (!index) throw new Error(`${cfg.dir}/index.html not found`)

  const htmlCount = [...byPath.values()].filter((f) => f.type === 'text/html').length
  const spa = cfg.spa === undefined || cfg.spa === 'auto' ? htmlCount === 1 : cfg.spa
  // Same bytes, same hash: these copies cost no extra upload.
  if (spa && !byPath.has('/404.html')) byPath.set('/404.html', { ...index, path: '/404.html' })
  for (const r of cfg.routes ?? []) {
    const clean = '/' + r.replace(/^\/+|\/+$/g, '')
    if (clean === '/') continue
    const p = `${clean}/index.html`
    if (!byPath.has(p)) byPath.set(p, { ...index, path: p })
  }
  return { files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), spa, warnings }
}

/** One blob per distinct hash. */
export const uniqueBlobs = (files: SiteFile[]) => [...new Map(files.map((f) => [f.sha256, f])).values()]
