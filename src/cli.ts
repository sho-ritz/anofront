#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { nip19 } from 'nostr-tools'
import { join } from 'node:path'
import { CONFIG_FILE, DEFAULT_GATEWAY, readConfig, siteUrl, writeConfig, type Config } from './config.js'
import { deploy, DeployError, gatewaysOf, verifyAll } from './deploy.js'
import { detect } from './detect.js'
import { fromNsec, loadKey, newKey, saveKey, toNsec, type SiteKey } from './keys.js'
import { checkDomain, planPrune, prune, rollback, versions } from './manage.js'
import { pathsOf } from './manifest.js'
import { ask, confirm, interactive } from './prompt.js'
import type { GatewayReport } from './verify.js'

const HELP = `anofront — deploy a static frontend to Nostr (nsite). No server, no domain required.

Usage:
  anofront init [--import] [--gateway <host>]   set up anofront.json and the site key
  anofront deploy [--no-build]                  build, upload, publish, verify
  anofront verify                               check gateways serve exactly what was signed
  anofront url                                  print the site URL
  anofront versions                             list published versions (snapshots)
  anofront rollback <snapshot>                  make an earlier version live again
  anofront prune --keep <n> [--yes]             delete files only older versions use
  anofront key export | key import              back up / restore the site key
  anofront domain                               check an optional custom domain (CNAME)

The site key is stored in ~/.config/anofront/keys/ (never in the project). In CI set ANOFRONT_NSEC.`

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const cwd = process.cwd()
const log = (s: string) => console.log(s)
const pubkeyOf = (cfg: Config) => nip19.decode(cfg.npub as `npub1${string}`).data

async function backupKey(k: SiteKey): Promise<void> {
  const nsec = toNsec(k)
  log('\nThis is the site key. Whoever holds it can replace the site; if you lose it, this URL can never be updated again.')
  log('Save it in a password manager now. It is shown only here (and by `anofront key export`).\n')
  log(`  ${nsec}\n`)
  for (;;) {
    const tail = await ask('Type the last 8 characters to confirm you saved it: ')
    if (tail === nsec.slice(-8)) return
    log('That does not match. Check what you saved.')
  }
}

async function init(): Promise<void> {
  if (existsSync(join(cwd, CONFIG_FILE))) throw new Error(`${CONFIG_FILE} already exists`)
  const d = detect(cwd)
  let key: SiteKey
  if (process.env.ANOFRONT_NSEC) {
    key = fromNsec(process.env.ANOFRONT_NSEC)
    log(`Using the key from ANOFRONT_NSEC (${key.npub}); it is not stored.`)
  } else {
    if (!interactive()) throw new Error('init needs a terminal to show and confirm the key backup. In CI, set ANOFRONT_NSEC.')
    if (flag('--import')) {
      key = fromNsec(await ask('Site nsec: ', { hidden: true }))
    } else {
      key = newKey()
      await backupKey(key)
    }
    log(`Key saved to ${await saveKey(key)}`)
  }
  const cfg: Config = { npub: key.npub, dir: d.dir, build: d.build, gateway: opt('--gateway') ?? DEFAULT_GATEWAY }
  await writeConfig(cwd, cfg)
  log(`\nCreated ${CONFIG_FILE} (${d.framework}: dir "${d.dir}"${d.build ? `, build "${d.build}"` : ''}).`)
  d.notes.forEach((n) => log(`note: ${n}`))
  log(`\nYour site will be at:\n  ${siteUrl(cfg, cfg.gateway!)}\n\nNext: anofront deploy`)
}

function printReports(reports: GatewayReport[], canonical: string): boolean {
  let canonicalOk = false
  for (const r of reports) {
    const tag = r.gateway === canonical ? 'canonical' : 'mirror'
    const mark = r.status === 'ok' ? '✓' : r.status === 'stale' ? '…' : '✗'
    log(`  ${mark} ${tag.padEnd(9)} ${r.url}  ${r.status}`)
    if (r.unknown.length) log(`      ✗ content matches no published version (possible tampering): ${r.unknown.slice(0, 5).join(', ')}`)
    if (r.missing.length) log(`      not served: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? ', …' : ''}`)
    if (r.badType.length) log(`      wrong Content-Type: ${r.badType.slice(0, 5).join(', ')}`)
    if (r.stale.length) log(`      older version still cached: ${r.stale.length} file(s) — gateways cache for up to an hour`)
    if (r.gateway === canonical) canonicalOk = r.status !== 'failed'
  }
  const tampered = reports.some((r) => r.unknown.length > 0)
  return canonicalOk && !tampered
}

async function main(): Promise<void> {
  const cmd = args[0]
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return log(HELP)
  if (cmd === 'init') return init()

  const cfg = await readConfig(cwd)
  const { canonical } = gatewaysOf(cfg)

  switch (cmd) {
    case 'url':
      return log(siteUrl(cfg, canonical))
    case 'deploy': {
      const key = await loadKey(cfg.npub)
      if (cfg.build && !flag('--no-build')) {
        log(`$ ${cfg.build}`)
        const r = spawnSync(cfg.build, { cwd, shell: true, stdio: 'inherit' })
        if (r.status !== 0) throw new Error('build failed; nothing was published')
      }
      const res = await deploy(cwd, cfg, key, { log })
      const good = printReports(res.reports, canonical)
      log(`\n${good ? 'Live' : 'Published, but verification failed'}:\n  ${res.url}`)
      if (res.snapshotUrl) log(`This version: ${res.snapshotUrl}`)
      if (!good) process.exitCode = 1
      return
    }
    case 'verify': {
      const { current, snapshots } = await versions(cfg, { pubkey: pubkeyOf(cfg) })
      if (!current) throw new Error('no published site found on the relays')
      const previous = new Set(snapshots.flatMap((s) => [...pathsOf(s).values()]))
      const paths = pathsOf(current)
      for (const h of paths.values()) previous.delete(h)
      const reports = await verifyAll(cfg, paths, previous, { verifyAttempts: 1 })
      if (!printReports(reports, canonical)) process.exitCode = 1
      return
    }
    case 'versions': {
      const { list } = await versions(cfg, { pubkey: pubkeyOf(cfg) })
      if (!list.length) return log('no snapshots found')
      for (const v of list) log(`${new Date(v.createdAt * 1000).toISOString()}  ${String(v.files).padStart(4)} files  ${v.url}`)
      return
    }
    case 'rollback': {
      const ref = args[1]
      if (!ref) throw new Error('usage: anofront rollback <snapshot id | v… label | version URL>')
      const key = await loadKey(cfg.npub)
      const { reports } = await rollback(cfg, key, ref, { log })
      if (!printReports(reports, canonical)) process.exitCode = 1
      return
    }
    case 'prune': {
      const keep = Number(opt('--keep'))
      if (!Number.isInteger(keep) || keep < 1) throw new Error('usage: anofront prune --keep <n>  (n ≥ 1)')
      const key = await loadKey(cfg.npub)
      const plan = await planPrune(cfg, key, keep)
      if (!plan.hashes.length) return log('nothing to delete')
      log(`Will delete ${plan.hashes.length} file(s) used only by versions older than the newest ${keep}, from ${plan.servers.length} server(s).`)
      log('Those versions will stop working, including their v… URLs. This cannot be undone.')
      if (!flag('--yes') && !(interactive() && (await confirm('Delete?')))) return log('cancelled')
      const r = await prune(plan, key)
      log(`deleted ${r.deleted}, failed ${r.failed}`)
      return
    }
    case 'key': {
      if (args[1] === 'export') {
        const key = await loadKey(cfg.npub)
        if (!interactive()) throw new Error('key export needs a terminal')
        if (!(await confirm('Show the secret key on screen?'))) return
        return log(toNsec(key))
      }
      if (args[1] === 'import') {
        if (!interactive()) throw new Error('key import needs a terminal')
        const key = fromNsec(await ask('Site nsec: ', { hidden: true }))
        if (key.npub !== cfg.npub) throw new Error(`that key is ${key.npub}, but this site is ${cfg.npub}`)
        return log(`Key saved to ${await saveKey(key)}`)
      }
      throw new Error('usage: anofront key export | key import')
    }
    case 'domain': {
      if (!cfg.domain) {
        const target = new URL(siteUrl(cfg, canonical)).hostname
        log('A custom domain is optional; the site already works at')
        log(`  ${siteUrl(cfg, canonical)}\n`)
        log('To try one, add "domain": "www.example.com" to anofront.json and create this DNS record:')
        log(`  www.example.com.  CNAME  ${target}.`)
        log('\nThe gateway must also issue a TLS certificate for your domain. Run `anofront domain` again to check.')
        return
      }
      const r = await checkDomain(cfg)
      log(`${r.domain} → ${r.target}`)
      log(`  DNS:   ${r.pointsAtGateway ? '✓ points at the gateway' : `✗ ${r.cname ? `CNAME is ${r.cname.join(', ')}` : 'no CNAME found'}`}`)
      log(`  HTTPS: ${r.https === 'ok' ? '✓' : `✗ ${r.httpsError ?? ''} (the gateway may not issue certificates for custom domains)`}`)
      log(`  Site:  ${r.servesSite ? '✓ serves the same page' : '✗ does not serve the site yet'}`)
      log('\nNote: a custom domain is a different origin. anoDB data saved under the gateway URL does not move to it automatically.')
      if (!(r.pointsAtGateway && r.https === 'ok' && r.servesSite)) process.exitCode = 1
      return
    }
    default:
      log(HELP)
      process.exitCode = 1
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof DeployError ? `✗ ${e.message}` : `error: ${(e as Error).message}`)
  process.exitCode = 1
})
