import { finalizeEvent, type Event } from 'nostr-tools'
import { uploadAll, type Fetch, type ServerResult } from './blossom.js'
import {
  CANDIDATE_RELAYS,
  CANDIDATE_SERVERS,
  DEFAULT_GATEWAY,
  DEFAULT_MIRRORS,
  LOOKUP_RELAYS,
  siteUrl,
  type Config,
} from './config.js'
import { collect, uniqueBlobs, type SiteFile } from './files.js'
import type { SiteKey } from './keys.js'
import {
  filesToPaths,
  KIND_ROOT_SITE,
  KIND_SNAPSHOT,
  pathsOf,
  relayList,
  rootSite,
  serverList,
  snapshotOf,
  type PathMap,
} from './manifest.js'
import { newest, publish, query, type PublishResult } from './relay.js'
import { hexToBase36 } from './util.js'
import { verifyGateway, type GatewayReport } from './verify.js'

export const MIN_SERVERS = 2
export const MAX_SERVERS = 3
export const MIN_RELAYS = 3

export interface Env {
  f?: Fetch
  /** Overrides https://<npub>.<gateway> (tests). */
  origin?: (gateway: string) => string
  lookupRelays?: string[]
  log?: (line: string) => void
  verifyAttempts?: number
  verifyDelayMs?: number
}

export class DeployError extends Error {}

export const gatewaysOf = (cfg: Config) => {
  const canonical = cfg.gateway ?? DEFAULT_GATEWAY
  return { canonical, mirrors: (cfg.mirrors ?? DEFAULT_MIRRORS).filter((g) => g !== canonical) }
}

const ok = (rs: PublishResult[]) => rs.filter((r) => r.ok).map((r) => r.relay)

export interface DeployResult {
  url: string
  snapshotUrl: string | undefined
  files: SiteFile[]
  servers: ServerResult[]
  relays: string[]
  site: Event
  reports: GatewayReport[]
}

/** Earlier versions of the site, newest first (current manifest + snapshots). */
export async function history(relays: string[], pubkey: string): Promise<Event[]> {
  const evs = await query(relays, { kinds: [KIND_ROOT_SITE, KIND_SNAPSHOT], authors: [pubkey], limit: 50 })
  return evs.sort((a, b) => b.created_at - a.created_at)
}

export async function verifyAll(cfg: Config, paths: PathMap, previous: Set<string>, env: Env): Promise<GatewayReport[]> {
  const { canonical, mirrors } = gatewaysOf(cfg)
  const origin = env.origin ?? ((g: string) => siteUrl(cfg, g))
  return Promise.all(
    [canonical, ...mirrors].map((g) =>
      verifyGateway(g, paths, {
        origin,
        previous,
        ...(env.f ? { f: env.f } : {}),
        ...(env.verifyAttempts !== undefined ? { attempts: env.verifyAttempts } : {}),
        ...(env.verifyDelayMs !== undefined ? { delayMs: env.verifyDelayMs } : {}),
      }),
    ),
  )
}

/**
 * Publish order, each step gated on the previous one:
 * 1. every blob on >= 2 servers that serve it back with the right Content-Type
 * 2. the root-site manifest acknowledged by >= 3 relays
 * 3. relay list (10002) and server list (10063), also on the lookup relays gateways use
 * 4. a snapshot (5128) for rollback
 * 5. verification through the canonical gateway and mirrors
 */
export async function deploy(cwd: string, cfg: Config, key: SiteKey, env: Env = {}): Promise<DeployResult> {
  const log = env.log ?? (() => {})
  if (key.npub !== cfg.npub) throw new DeployError(`key ${key.npub} does not match anofront.json (${cfg.npub})`)
  const { canonical } = gatewaysOf(cfg)
  const url = siteUrl(cfg, canonical)

  const { files, spa, warnings } = await collect(cwd, cfg, url)
  warnings.forEach((w) => log(`warning: ${w}`))
  const blobs = uniqueBlobs(files)
  const bytes = blobs.reduce((n, b) => n + b.data.byteLength, 0)
  log(`${files.length} paths, ${blobs.length} files, ${(bytes / 1024).toFixed(0)} KB${spa ? ' (SPA: /404.html serves the app)' : ''}`)

  const relays = cfg.relays ?? CANDIDATE_RELAYS
  const lookup = env.lookupRelays ?? LOOKUP_RELAYS
  const prior = await history(relays, key.pubkey)
  const current = prior.find((e) => e.kind === KIND_ROOT_SITE)

  // 1. blobs
  const servers = await uploadAll(cfg.servers ?? CANDIDATE_SERVERS, blobs, key.sk, {
    want: MAX_SERVERS,
    ...(env.f ? { f: env.f } : {}),
    onResult: (r) => log(r.ok ? `  ✓ ${r.server} (${r.uploaded} uploaded, ${r.skipped} already there)` : `  ✗ ${r.server}: ${r.error}`),
  })
  const good = servers.filter((r) => r.ok).map((r) => r.server)
  if (good.length < MIN_SERVERS) throw new DeployError(`only ${good.length} Blossom server(s) accepted every file; need ${MIN_SERVERS}. Nothing was published.`)

  // 2. manifest
  const now = Math.floor(Date.now() / 1000)
  const createdAt = Math.max(now, (current?.created_at ?? 0) + 1)
  const paths = filesToPaths(files)
  const site = finalizeEvent(rootSite(paths, good, { title: cfg.title, description: cfg.description }, createdAt), key.sk)
  const siteResults = await publish(relays, site)
  const siteAcks = ok(siteResults)
  log(`manifest accepted by ${siteAcks.length}/${relays.length} relays`)
  for (const r of siteResults) if (!r.ok) log(`  ✗ ${r.relay}: ${r.message}`)
  if (siteAcks.length < MIN_RELAYS)
    throw new DeployError(`manifest accepted by only ${siteAcks.length} relay(s); need ${MIN_RELAYS}. The previous version stays live where it was not replaced.`)

  // 3. discovery lists
  const lists = [finalizeEvent(relayList(siteAcks, createdAt), key.sk), finalizeEvent(serverList(good, createdAt), key.sk)]
  for (const ev of lists) {
    const acks = ok(await publish([...new Set([...siteAcks, ...lookup])], ev))
    if (!acks.some((r) => lookup.includes(r))) log(`warning: no lookup relay accepted kind ${ev.kind}; gateways may not find the site`)
  }

  // 4. snapshot
  const snap = finalizeEvent(snapshotOf(site), key.sk)
  const snapAcks = ok(await publish(siteAcks, snap))
  const snapshotUrl = snapAcks.length ? `https://v${hexToBase36(snap.id)}.${canonical}/` : undefined

  // 5. verify
  const previous = new Set(prior.flatMap((e) => [...pathsOf(e).values()]))
  for (const h of paths.values()) previous.delete(h)
  log('verifying through gateways…')
  const reports = await verifyAll(cfg, paths, previous, env)
  return { url, snapshotUrl, files, servers, relays: siteAcks, site, reports }
}
