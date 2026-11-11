import { resolve4, resolveCname } from 'node:dns/promises'
import { finalizeEvent, type Event } from 'nostr-tools'
import { deleteBlob, type Fetch } from './blossom.js'
import { CANDIDATE_RELAYS, siteUrl, type Config } from './config.js'
import { DeployError, gatewaysOf, history, MIN_RELAYS, verifyAll, type Env } from './deploy.js'
import type { SiteKey } from './keys.js'
import { KIND_ROOT_SITE, KIND_SNAPSHOT, pathsOf, rootSite, serversOf } from './manifest.js'
import { publish } from './relay.js'
import { base36ToHex, hexToBase36, normalizeServer } from './util.js'
import type { GatewayReport } from './verify.js'

export interface Version {
  id: string
  kind: number
  createdAt: number
  files: number
  url: string
}

export async function versions(cfg: Config, key: Pick<SiteKey, 'pubkey'>): Promise<{ current: Event | undefined; snapshots: Event[]; list: Version[] }> {
  const evs = await history(cfg.relays ?? CANDIDATE_RELAYS, key.pubkey)
  const current = evs.find((e) => e.kind === KIND_ROOT_SITE)
  const snapshots = evs.filter((e) => e.kind === KIND_SNAPSHOT)
  const { canonical } = gatewaysOf(cfg)
  const list = snapshots.map((s) => ({ id: s.id, kind: s.kind, createdAt: s.created_at, files: pathsOf(s).size, url: `https://v${hexToBase36(s.id)}.${canonical}/` }))
  return { current, snapshots, list }
}

/** Accepts a snapshot event id (hex), its base36 label (with or without the leading v), or a version URL. */
export function parseSnapshotRef(ref: string): string {
  const label = ref.replace(/^https?:\/\//, '').split('.')[0]!
  if (/^[0-9a-f]{64}$/.test(label)) return label
  const b36 = label.replace(/^v/, '')
  return base36ToHex(b36)
}

export async function rollback(cfg: Config, key: SiteKey, ref: string, env: Env = {}): Promise<{ site: Event; reports: GatewayReport[] }> {
  const f = env.f ?? fetch
  const id = parseSnapshotRef(ref)
  const { current, snapshots } = await versions(cfg, key)
  const snap = snapshots.find((s) => s.id === id)
  if (!snap) throw new DeployError(`snapshot ${id} not found on the relays`)
  const paths = pathsOf(snap)
  const servers = serversOf(snap)
  // Gate: the files must still exist before the manifest points at them.
  const holding: string[] = []
  for (const s of servers) {
    const heads = await Promise.all([...new Set(paths.values())].map((h) => f(`${normalizeServer(s)}/${h}`, { method: 'HEAD' }).then((r) => r.ok, () => false)))
    if (heads.every(Boolean)) holding.push(s)
  }
  if (holding.length === 0) throw new DeployError('no server still holds every file of that version (pruned?). Nothing was published.')
  const createdAt = Math.max(Math.floor(Date.now() / 1000), (current?.created_at ?? 0) + 1)
  const title = snap.tags.find((t) => t[0] === 'title')?.[1]
  const description = snap.tags.find((t) => t[0] === 'description')?.[1]
  const site = finalizeEvent(rootSite(paths, holding, { title, description }, createdAt), key.sk)
  const acks = (await publish(cfg.relays ?? CANDIDATE_RELAYS, site)).filter((r) => r.ok)
  if (acks.length < MIN_RELAYS) throw new DeployError(`rollback manifest accepted by only ${acks.length} relay(s); need ${MIN_RELAYS}`)
  const previous = new Set(current ? [...pathsOf(current).values()] : [])
  for (const h of paths.values()) previous.delete(h)
  return { site, reports: await verifyAll(cfg, paths, previous, env) }
}

export interface PrunePlan {
  keep: number
  hashes: string[]
  servers: string[]
}

/** Blobs referenced only by versions older than the newest `keep` snapshots (the live one is always kept). */
export async function planPrune(cfg: Config, key: Pick<SiteKey, 'pubkey'>, keep: number): Promise<PrunePlan> {
  const { current, snapshots } = await versions(cfg, key)
  const kept = [current, ...snapshots.slice(0, keep)].filter((e): e is Event => !!e)
  const old = snapshots.slice(keep)
  const keepHashes = new Set(kept.flatMap((e) => [...pathsOf(e).values()]))
  const hashes = [...new Set(old.flatMap((e) => [...pathsOf(e).values()]))].filter((h) => !keepHashes.has(h))
  const servers = [...new Set([...kept, ...old].flatMap(serversOf).map(normalizeServer))]
  return { keep, hashes, servers }
}

export async function prune(plan: PrunePlan, key: SiteKey, f: Fetch = fetch): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  for (const s of plan.servers)
    for (const h of plan.hashes) {
      const ok = await deleteBlob(s, h, key.sk, f).catch(() => false)
      if (ok) deleted++
      else failed++
    }
  return { deleted, failed }
}

export interface DomainReport {
  domain: string
  target: string
  cname: string[] | null
  pointsAtGateway: boolean
  https: 'ok' | 'failed'
  httpsError?: string
  servesSite: boolean
}

/**
 * Optional custom domain: CNAME <domain> → <npub>.<gateway>. Whether the gateway issues a TLS
 * certificate for it is up to the gateway; this only reports what actually happens.
 */
export async function checkDomain(cfg: Config, f: Fetch = fetch): Promise<DomainReport> {
  if (!cfg.domain) throw new Error('no "domain" in anofront.json')
  const { canonical } = gatewaysOf(cfg)
  const target = new URL(siteUrl(cfg, canonical)).hostname
  const cname = await resolveCname(cfg.domain).catch(() => null)
  let pointsAtGateway = !!cname?.some((c) => c.replace(/\.$/, '').toLowerCase() === target.toLowerCase())
  if (!pointsAtGateway && !cname) {
    // Apex domains (ALIAS / flattening) have no CNAME; compare addresses instead.
    const none = (): string[] => []
    const [a, b] = await Promise.all([resolve4(cfg.domain).catch(none), resolve4(target).catch(none)])
    pointsAtGateway = a.length > 0 && a.some((ip) => b.includes(ip))
  }
  const report: DomainReport = { domain: cfg.domain, target, cname, pointsAtGateway, https: 'failed', servesSite: false }
  try {
    const [mine, theirs] = await Promise.all([f(`https://${cfg.domain}/`), f(`https://${target}/`)])
    report.https = 'ok'
    report.servesSite = mine.ok && theirs.ok && (await mine.text()) === (await theirs.text())
  } catch (e) {
    report.httpsError = ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message
  }
  return report
}
