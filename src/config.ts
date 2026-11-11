import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CONFIG_FILE = 'anofront.json'

/**
 * Candidate lists shipped with the tool. Nothing here is trusted: a Blossom server is used only
 * after it accepts and serves back every file, and a relay only counts once it acknowledges the
 * event. Checked 2026-11-12 by uploading HTML / JS / CSS / WASM / text with a throwaway key;
 * left out: cdn.hzrd149.com and blossom.f7z.io (allow-lists), cdn.nostrcheck.me (rejects HTML),
 * blossom.band and blossom.nostr.build (reject CSS), cdn.satellite.earth (paid), cdn.sovbit.host (down).
 */
export const CANDIDATE_SERVERS = [
  'https://blossom.primal.net',
  'https://blossom.yakihonne.com',
  'https://blossom.ditto.pub',
  'https://nostr.download',
  'https://files.sovbit.host',
]
/** Checked 2026-11-12 with a kind 15128 event; nostr.wine needs sign-up, offchain.pub a web of trust, user.kindpag.es only takes lists. */
export const CANDIDATE_RELAYS = [
  'wss://relay.nsite.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.nostr.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
]
/** Where gateways look up a pubkey's relay list (10002) and server list (10063). */
export const LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es']
/**
 * Gateways that served a root site (kind 15128) at `<npub>.<host>` with matching hashes. The first is
 * the default canonical one; nsite.cloud is not offered as canonical because it caches `/` for a
 * year as immutable, so returning visitors would not see updates.
 */
export const DEFAULT_GATEWAY = 'nsite.lol'
/**
 * nsite.run is not a default mirror: on 2026-11-12 its CDN returned another site's HTML for our
 * /favicon.ico (cached across subdomains). Add it to "mirrors" yourself to monitor it.
 */
export const DEFAULT_MIRRORS = ['nsite.cloud']

export interface Config {
  /** The site's public key (npub). The secret key is never stored in the project. */
  npub: string
  /** Build output directory. */
  dir: string
  /** Build command, run by `deploy` unless --no-build. Empty string disables it. */
  build?: string
  /** Canonical gateway host. The site's URL is https://<npub>.<gateway>/. */
  gateway?: string
  /** Other gateways, checked by `verify` and printed as mirrors. */
  mirrors?: string[]
  /** Blossom servers to use instead of the candidate list. */
  servers?: string[]
  /** Relays to use instead of the candidate list. */
  relays?: string[]
  /** 'auto' (default): on when the build has a single HTML file. Publishes index.html as /404.html. */
  spa?: 'auto' | boolean
  /** Client-side routes that should answer 200: each gets a copy of index.html (no extra upload). */
  routes?: string[]
  /** Glob patterns to leave out. Dotfiles are always left out except /.well-known/. */
  exclude?: string[]
  title?: string
  description?: string
  /** Optional custom domain (CNAME). Never required. */
  domain?: string
}

export const siteUrl = (cfg: Pick<Config, 'npub'>, gateway: string) => `https://${cfg.npub}.${gateway}/`

export async function readConfig(cwd: string): Promise<Config> {
  let raw: string
  try {
    raw = await readFile(join(cwd, CONFIG_FILE), 'utf8')
  } catch {
    throw new Error(`${CONFIG_FILE} not found. Run \`anofront init\` first.`)
  }
  const cfg = JSON.parse(raw) as Config
  if (!cfg.npub?.startsWith('npub1')) throw new Error(`${CONFIG_FILE}: "npub" is missing or invalid`)
  if (!cfg.dir) throw new Error(`${CONFIG_FILE}: "dir" is missing`)
  if (/nsec1/.test(raw)) throw new Error(`${CONFIG_FILE} contains a secret key (nsec). Remove it: the key must not live in the project.`)
  return cfg
}

export async function writeConfig(cwd: string, cfg: Config): Promise<void> {
  await writeFile(join(cwd, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n')
}
