import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { deploy, DeployError, type Env } from '../src/deploy.js'
import { newKey, type SiteKey } from '../src/keys.js'
import { planPrune, prune, rollback, versions } from '../src/manage.js'
import { pathsOf } from '../src/manifest.js'
import { mockBlossom, mockGateway, mockRelay, type MockBlossom, type MockGateway, type MockRelay } from './mocks.js'

let relays: MockRelay[]
let lookup: MockRelay
let servers: MockBlossom[]
let plain: MockBlossom
let gw: MockGateway
let mirror: MockGateway
let key: SiteKey
let cwd: string
let cfg: Config
let env: Env

async function writeSite(js: string) {
  await mkdir(join(cwd, 'dist/assets'), { recursive: true })
  await writeFile(join(cwd, 'dist/index.html'), '<!doctype html><html><head></head><body><script src="/assets/app.js"></script></body></html>')
  await writeFile(join(cwd, 'dist/assets/app.js'), js)
  await writeFile(join(cwd, 'dist/assets/sql-wasm.wasm'), new Uint8Array([0, 97, 115, 109]))
  await writeFile(join(cwd, 'dist/logo.png'), new Uint8Array([1, 2, 3]))
}

beforeEach(async () => {
  relays = await Promise.all([mockRelay(), mockRelay(), mockRelay(), mockRelay()])
  lookup = await mockRelay()
  plain = await mockBlossom()
  plain.rejectUploads = true // like a server with an allow-list: must be skipped
  servers = await Promise.all([mockBlossom(), mockBlossom(), mockBlossom()])
  gw = await mockGateway(relays[0]!, servers)
  mirror = await mockGateway(relays[1]!, servers)
  key = newKey()
  cwd = await mkdtemp(join(tmpdir(), 'anofront-site-'))
  await writeSite('console.log("v1")')
  cfg = {
    npub: key.npub,
    dir: 'dist',
    gateway: 'canonical.test',
    mirrors: ['mirror.test'],
    servers: [plain.url, ...servers.map((s) => s.url)],
    relays: relays.map((r) => r.url),
    routes: ['/chat'],
  }
  env = {
    origin: (g) => (g === 'canonical.test' ? gw.origin : mirror.origin),
    lookupRelays: [lookup.url],
    verifyAttempts: 2,
    verifyDelayMs: 10,
  }
})

afterEach(async () => {
  await Promise.all([...relays, lookup].map((r) => r.close()))
  await Promise.all([plain, ...servers].map((s) => s.close()))
  await Promise.all([gw.close(), mirror.close()])
})

describe('deploy', () => {
  it('uploads, publishes and verifies; skips servers that refuse uploads', async () => {
    const res = await deploy(cwd, cfg, key, env)
    expect(res.url).toBe(`https://${key.npub}.canonical.test/`)
    expect(res.servers[0]).toMatchObject({ server: plain.url, ok: false })
    expect(res.servers[0]!.error).toMatch(/HTTP 401/)
    expect(res.servers.filter((s) => s.ok).map((s) => s.server)).toEqual(servers.map((s) => s.url))
    expect(res.relays).toHaveLength(4)
    expect(res.reports.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(res.snapshotUrl).toMatch(/^https:\/\/v[0-9a-z]{50}\.canonical\.test\/$/)

    const site = relays[0]!.events.find((e) => e.kind === 15128)!
    const paths = pathsOf(site)
    expect([...paths.keys()]).toEqual(['/404.html', '/assets/app.js', '/assets/sql-wasm.wasm', '/chat/index.html', '/index.html', '/logo.png'])
    expect(site.tags.filter((t) => t[0] === 'server').map((t) => t[1])).toEqual(servers.map((s) => s.url))
    expect(lookup.events.map((e) => e.kind).sort()).toEqual([10002, 10063])
    expect(relays[0]!.events.some((e) => e.kind === 5128)).toBe(true)
    // index.html, 404.html and /chat/index.html share one blob
    expect(servers[0]!.blobs.size).toBe(4)
  })

  it('redeploy uploads only changed files and moves created_at forward', async () => {
    const first = await deploy(cwd, cfg, key, env)
    const before = servers[0]!.uploads
    await writeSite('console.log("v2")')
    const second = await deploy(cwd, cfg, key, env)
    expect(servers[0]!.uploads - before).toBe(1)
    expect(second.site.created_at).toBeGreaterThan(first.site.created_at)
    expect(second.reports[0]!.status).toBe('ok')
  })

  it('tells a stale cache apart from tampering', async () => {
    const first = await deploy(cwd, cfg, key, env)
    mirror.pinned = first.site
    await writeSite('console.log("v2")')
    const second = await deploy(cwd, cfg, key, env)
    expect(second.reports[1]).toMatchObject({ gateway: 'mirror.test', status: 'stale', stale: ['/assets/app.js'] })

    gw.tamper.set('/assets/app.js', 'stealKeys()')
    await writeSite('console.log("v3")')
    const third = await deploy(cwd, cfg, key, env)
    expect(third.reports[0]).toMatchObject({ status: 'failed', unknown: ['/assets/app.js'] })
  })

  it('flags a gateway that serves scripts or WASM with the wrong Content-Type', async () => {
    mirror.forceType = 'text/plain'
    const res = await deploy(cwd, cfg, key, env)
    expect(res.reports[0]!.status).toBe('ok')
    expect(res.reports[1]).toMatchObject({ status: 'failed', badType: ['/404.html', '/assets/app.js', '/assets/sql-wasm.wasm', '/chat/index.html', '/index.html'] })
  })

  it('publishes nothing when fewer than 2 servers accept every file', async () => {
    servers[1]!.rejectUploads = true
    servers[2]!.rejectUploads = true
    await expect(deploy(cwd, cfg, key, env)).rejects.toThrow(DeployError)
    expect(relays.flatMap((r) => r.events)).toHaveLength(0)
  })

  it('fails when fewer than 3 relays acknowledge the manifest', async () => {
    relays[2]!.reject = true
    relays[3]!.reject = true
    await expect(deploy(cwd, cfg, key, env)).rejects.toThrow(/only 2 relay/)
    expect(lookup.events).toHaveLength(0)
  })

  it('refuses a key that is not the site key', async () => {
    await expect(deploy(cwd, cfg, newKey(), env)).rejects.toThrow(/does not match/)
  })
})

describe('rollback and prune', () => {
  it('rolls back to an earlier snapshot and prunes files only old versions use', async () => {
    const v1 = await deploy(cwd, cfg, key, env)
    await writeSite('console.log("v2")')
    await deploy(cwd, cfg, key, env)
    await writeSite('console.log("v3")')
    await deploy(cwd, cfg, key, env)

    const { list } = await versions(cfg, key)
    expect(list).toHaveLength(3)

    const v1snap = relays[0]!.events.find((e) => e.kind === 5128 && e.created_at === v1.site.created_at)!
    const { site, reports } = await rollback(cfg, key, v1snap.id, env)
    expect([...pathsOf(site)]).toEqual([...pathsOf(v1.site)])
    expect(reports[0]!.status).toBe('ok')

    // live = v1 contents; keeping the newest snapshot (v3) means v2's app.js is the only orphan
    const plan = await planPrune(cfg, key, 1)
    expect(plan.hashes).toHaveLength(1)
    const r = await prune(plan, key)
    expect(r.failed).toBe(0)
    expect(servers[0]!.deletes).toEqual(plan.hashes)
  })

  it('rollback refuses when the files are gone', async () => {
    const v1 = await deploy(cwd, cfg, key, env)
    for (const s of servers) s.blobs.clear()
    plain.blobs.clear()
    const snap = relays[0]!.events.find((e) => e.kind === 5128 && e.created_at === v1.site.created_at)!
    await expect(rollback(cfg, key, snap.id, env)).rejects.toThrow(/no server still holds/)
  })
})
