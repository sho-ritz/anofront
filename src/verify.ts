import type { Fetch } from './blossom.js'
import type { PathMap } from './manifest.js'
import { contentTypeOk, mapLimit, sha256Hex, sleep } from './util.js'

export type GatewayStatus = 'ok' | 'stale' | 'failed'

export interface GatewayReport {
  gateway: string
  url: string
  status: GatewayStatus
  /** Served bytes that match no published version: possible tampering. */
  unknown: string[]
  /** Served an older published version (gateway cache). */
  stale: string[]
  /** Not served (HTTP error / network). */
  missing: string[]
  /** Served with a Content-Type that breaks the page. */
  badType: string[]
}

export interface VerifyOptions {
  origin: (gateway: string) => string
  /** Hashes of earlier published versions, to tell cache staleness from tampering. */
  previous?: Set<string>
  attempts?: number
  delayMs?: number
  f?: Fetch
}

async function checkOnce(gateway: string, paths: PathMap, o: VerifyOptions): Promise<GatewayReport> {
  const f = o.f ?? fetch
  const base = o.origin(gateway).replace(/\/+$/, '')
  const r: GatewayReport = { gateway, url: `${base}/`, status: 'ok', unknown: [], stale: [], missing: [], badType: [] }
  await mapLimit([...paths], 6, async ([path, want]) => {
    try {
      const res = await f(`${base}${path}`, { headers: { 'cache-control': 'no-cache' } })
      if (!res.ok && !(path === '/404.html' && res.status === 404)) {
        r.missing.push(path)
        return
      }
      const got = sha256Hex(new Uint8Array(await res.arrayBuffer()))
      if (got !== want) (o.previous?.has(got) ? r.stale : r.unknown).push(path)
      else if (!contentTypeOk(path, res.headers.get('content-type'))) r.badType.push(path)
    } catch {
      r.missing.push(path)
    }
  })
  for (const k of ['unknown', 'stale', 'missing', 'badType'] as const) r[k].sort()
  r.status = r.unknown.length || r.missing.length || r.badType.length ? 'failed' : r.stale.length ? 'stale' : 'ok'
  return r
}

/** Fetches every published path from the gateway and compares it with the signed manifest. */
export async function verifyGateway(gateway: string, paths: PathMap, o: VerifyOptions): Promise<GatewayReport> {
  const attempts = o.attempts ?? 6
  let last!: GatewayReport
  for (let i = 0; i < attempts; i++) {
    last = await checkOnce(gateway, paths, o)
    // Retry everything else: right after a deploy a gateway may not have the manifest yet.
    if (last.status === 'ok') return last
    if (i < attempts - 1) await sleep(o.delayMs ?? 5000)
  }
  return last
}
