import { finalizeEvent } from 'nostr-tools'
import type { SiteFile } from './files.js'
import { mapLimit, normalizeServer } from './util.js'

export type Fetch = typeof fetch

/** BUD-11 authorization header (kind 24242), scoped to one action, the given hashes and one server. */
export function authHeader(sk: Uint8Array, server: string, t: 'upload' | 'delete', hashes: string[], note: string): string {
  const now = Math.floor(Date.now() / 1000)
  const ev = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: note,
      tags: [['t', t], ['expiration', String(now + 300)], ['server', new URL(server).hostname.toLowerCase()], ...hashes.map((x) => ['x', x])],
    },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`
}

export interface ServerResult {
  server: string
  ok: boolean
  uploaded: number
  skipped: number
  error?: string
}

/**
 * Makes sure every blob is on `server` and retrievable. A server passes only if all of them are;
 * any failure rejects the whole server. Content-Type is not checked here: gateways derive it from
 * the path (nsite-gateway does), and `verify` checks what the gateway actually serves.
 */
export async function syncServer(server: string, blobs: SiteFile[], sk: Uint8Array, f: Fetch = fetch): Promise<ServerResult> {
  const base = normalizeServer(server)
  let uploaded = 0
  let skipped = 0
  try {
    await mapLimit(blobs, 4, async (b) => {
      const head = await f(`${base}/${b.sha256}`, { method: 'HEAD' })
      if (head.ok) {
        skipped++
        return
      }
      const res = await f(`${base}/upload`, {
        method: 'PUT',
        headers: {
          authorization: authHeader(sk, base, 'upload', [b.sha256], `Upload ${b.path}`),
          'content-type': b.type,
          'content-length': String(b.data.byteLength),
          'x-sha-256': b.sha256,
        },
        body: b.data as Uint8Array<ArrayBuffer>,
      })
      if (!res.ok) {
        const reason = res.headers.get('x-reason') ?? (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`upload ${b.path}: HTTP ${res.status} ${reason}`.trim())
      }
      const desc = (await res.json().catch(() => ({}))) as { sha256?: string }
      if (desc.sha256 && desc.sha256 !== b.sha256) throw new Error(`upload ${b.path}: server stored a different hash`)
      const check = await f(`${base}/${b.sha256}`, { method: 'HEAD' })
      if (!check.ok) throw new Error(`${b.path}: not retrievable after upload (HTTP ${check.status})`)
      uploaded++
    })
    return { server: base, ok: true, uploaded, skipped }
  } catch (e) {
    return { server: base, ok: false, uploaded, skipped, error: (e as Error).message }
  }
}

/** Tries servers in order until `want` of them hold every blob. */
export async function uploadAll(
  servers: string[],
  blobs: SiteFile[],
  sk: Uint8Array,
  opts: { want: number; f?: Fetch; onResult?: (r: ServerResult) => void },
): Promise<ServerResult[]> {
  const results: ServerResult[] = []
  for (const s of servers) {
    if (results.filter((r) => r.ok).length >= opts.want) break
    const r = await syncServer(s, blobs, sk, opts.f)
    results.push(r)
    opts.onResult?.(r)
  }
  return results
}

export async function deleteBlob(server: string, sha256: string, sk: Uint8Array, f: Fetch = fetch): Promise<boolean> {
  const base = normalizeServer(server)
  const res = await f(`${base}/${sha256}`, { method: 'DELETE', headers: { authorization: authHeader(sk, base, 'delete', [sha256], 'Delete old site files') } })
  return res.ok || res.status === 404
}
