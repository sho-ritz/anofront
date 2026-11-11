import { createHash } from 'node:crypto'

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

/** NIP-5A base36: the 32-byte value as a big-endian integer, lowercase 0-9a-z, left-padded to 50 chars. */
export function hexToBase36(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`not a 32-byte hex value: ${hex}`)
  return BigInt(`0x${hex}`).toString(36).padStart(50, '0')
}

export function base36ToHex(b36: string): string {
  if (!/^[0-9a-z]{50}$/.test(b36)) throw new Error(`not a 50-char base36 value: ${b36}`)
  let v = 0n
  for (const c of b36) v = v * 36n + BigInt(parseInt(c, 36))
  if (v >= 1n << 256n) throw new Error('base36 value out of range')
  return v.toString(16).padStart(64, '0')
}

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain',
  xml: 'application/xml',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

export function mimeOf(path: string): string {
  const ext = path.split('/').pop()!.split('.').slice(1).pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Types where a wrong Content-Type breaks the page (HTML downloaded instead of shown, scripts or
 * WASM refused). Compared by the part before `;`. `text/javascript` and `application/javascript`
 * are both accepted for scripts.
 */
export function contentTypeOk(path: string, got: string | null): boolean {
  const want = mimeOf(path)
  const critical = ['text/html', 'text/css', 'text/javascript', 'application/wasm']
  if (!critical.includes(want)) return true
  const base = (got ?? '').split(';')[0]!.trim().toLowerCase()
  if (want === 'text/javascript') return base === 'text/javascript' || base === 'application/javascript'
  return base === want
}

/** Minimal glob: `**` any path, `*` within a segment, `?` one char. Matched against `/`-rooted paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.startsWith('/') ? glob : `/**/${glob}`
  g = g.replace(/\/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001')
  let re = ''
  for (const ch of g) {
    if (ch === '\u0000') re += '/(?:.*/)?'
    else if (ch === '\u0001') re += '.*'
    else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const normalizeServer = (url: string) => url.replace(/\/+$/, '')
