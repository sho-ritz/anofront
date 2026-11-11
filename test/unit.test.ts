import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collect, injectCanonical } from '../src/files.js'
import { readConfig } from '../src/config.js'
import { detect } from '../src/detect.js'
import { loadKey, newKey, saveKey, toNsec } from '../src/keys.js'
import { aggregateHash } from '../src/manifest.js'
import { parseSnapshotRef } from '../src/manage.js'
import { base36ToHex, contentTypeOk, globToRegExp, hexToBase36, sha256Hex } from '../src/util.js'

const tmp = () => mkdtemp(join(tmpdir(), 'anofront-'))

describe('base36 (NIP-5A)', () => {
  it('round-trips and pads to 50 chars', () => {
    const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    expect(hexToBase36(hex)).toHaveLength(50)
    expect(base36ToHex(hexToBase36(hex))).toBe(hex)
    expect(hexToBase36('0'.repeat(64))).toBe('0'.repeat(50))
    expect(hexToBase36('f'.repeat(64))).toHaveLength(50)
  })
  it('parses snapshot refs in every form', () => {
    const id = 'ab'.repeat(32)
    const b36 = hexToBase36(id)
    expect(parseSnapshotRef(id)).toBe(id)
    expect(parseSnapshotRef(`v${b36}`)).toBe(id)
    expect(parseSnapshotRef(`https://v${b36}.nsite.lol/`)).toBe(id)
  })
})

describe('aggregate hash', () => {
  it('ignores order and follows the "<hash> <path>\\n" sorted-lines rule', () => {
    const a = new Map([['/index.html', 'aa'], ['/a.js', 'bb']])
    const b = new Map([['/a.js', 'bb'], ['/index.html', 'aa']])
    expect(aggregateHash(a)).toBe(aggregateHash(b))
    expect(aggregateHash(a)).toBe(sha256Hex('aa /index.html\nbb /a.js\n'))
  })
})

describe('content types', () => {
  it('rejects HTML served as text/plain and accepts either JS type', () => {
    expect(contentTypeOk('/index.html', 'text/plain')).toBe(false)
    expect(contentTypeOk('/index.html', 'text/html; charset=utf-8')).toBe(true)
    expect(contentTypeOk('/a.js', 'application/javascript')).toBe(true)
    expect(contentTypeOk('/anodb/sql-wasm.wasm', 'application/octet-stream')).toBe(false)
    expect(contentTypeOk('/logo.png', 'application/octet-stream')).toBe(true)
  })
  it('globs', () => {
    expect(globToRegExp('*.map').test('/assets/a.js.map')).toBe(true)
    expect(globToRegExp('/assets/**').test('/assets/x/y.js')).toBe(true)
    expect(globToRegExp('/assets/*.js').test('/assets/x/y.js')).toBe(false)
  })
})

describe('collect', () => {
  let dir: string
  beforeEach(async () => {
    dir = await tmp()
    await mkdir(join(dir, 'dist/assets'), { recursive: true })
    await mkdir(join(dir, 'dist/.git'), { recursive: true })
    await writeFile(join(dir, 'dist/index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>')
    await writeFile(join(dir, 'dist/assets/app.js'), 'console.log(1)')
    await writeFile(join(dir, 'dist/assets/app.js.map'), '{}')
    await writeFile(join(dir, 'dist/.git/config'), 'secret')
    await writeFile(join(dir, 'dist/.env'), 'SECRET=1')
  })
  const cfg = { npub: 'npub1x', dir: 'dist' }

  it('injects the canonical URL, adds SPA fallback and route copies sharing one blob', async () => {
    const { files, spa } = await collect(dir, { ...cfg, routes: ['/chat', 'settings/'], exclude: ['*.map'] }, 'https://npub1x.nsite.lol/')
    expect(spa).toBe(true)
    const paths = files.map((f) => f.path)
    expect(paths).toEqual(['/404.html', '/assets/app.js', '/chat/index.html', '/index.html', '/settings/index.html'])
    const index = files.find((f) => f.path === '/index.html')!
    expect(new TextDecoder().decode(index.data)).toContain('<head><meta name="anofront:canonical" content="https://npub1x.nsite.lol/">')
    expect(new Set(files.filter((f) => f.type === 'text/html').map((f) => f.sha256)).size).toBe(1)
  })
  it('never publishes dotfiles', async () => {
    const { files } = await collect(dir, cfg, 'https://x/')
    expect(files.some((f) => f.path.includes('.git') || f.path.includes('.env'))).toBe(false)
  })
  it('spa:auto stays off for multi-page sites', async () => {
    await writeFile(join(dir, 'dist/about.html'), '<html><head></head></html>')
    const { files, spa } = await collect(dir, cfg, 'https://x/')
    expect(spa).toBe(false)
    expect(files.some((f) => f.path === '/404.html')).toBe(false)
  })
  it('re-injecting replaces the old tag', () => {
    const once = injectCanonical('<head></head>', 'https://a/')
    expect(injectCanonical(once, 'https://b/')).toBe('<head><meta name="anofront:canonical" content="https://b/"></head>')
  })
})

describe('keys', () => {
  let home: string
  beforeEach(async () => {
    home = await tmp()
    process.env.ANOFRONT_HOME = join(home, 'keys')
    delete process.env.ANOFRONT_NSEC
  })
  afterEach(() => {
    delete process.env.ANOFRONT_HOME
    delete process.env.ANOFRONT_NSEC
  })
  it('stores the key 0600 in a 0700 dir and loads it back', async () => {
    const k = newKey()
    const file = await saveKey(k)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, 'keys'))).mode & 0o777).toBe(0o700)
    expect((await loadKey(k.npub)).pubkey).toBe(k.pubkey)
    await expect(saveKey(k)).rejects.toThrow(/already stored/)
  })
  it('refuses a key file readable by others', async () => {
    const k = newKey()
    const file = await saveKey(k)
    const { chmod } = await import('node:fs/promises')
    await chmod(file, 0o644)
    await expect(loadKey(k.npub)).rejects.toThrow(/readable by other users/)
  })
  it('ANOFRONT_NSEC must match the site', async () => {
    process.env.ANOFRONT_NSEC = toNsec(newKey())
    await expect(loadKey(newKey().npub)).rejects.toThrow(/belongs to/)
  })
})

describe('config', () => {
  it('refuses a config that contains an nsec', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'anofront.json'), JSON.stringify({ npub: newKey().npub, dir: 'dist', note: toNsec(newKey()) }))
    await expect(readConfig(dir)).rejects.toThrow(/secret key/)
  })
})

describe('detect', () => {
  it('vite → dist, next without export → note', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '*' } }))
    expect(detect(dir)).toMatchObject({ framework: 'vite', dir: 'dist', build: 'npm run build' })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '*' } }))
    await writeFile(join(dir, 'next.config.ts'), 'export default {}')
    const d = detect(dir)
    expect(d.dir).toBe('out')
    expect(d.notes.join()).toMatch(/output: 'export'/)
    await writeFile(join(dir, 'next.config.ts'), "export default { output: 'export' }")
    expect(detect(dir).notes).toEqual([])
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toContain('next')
  })
})
