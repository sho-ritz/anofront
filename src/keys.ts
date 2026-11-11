import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

/**
 * Site keys live outside every project, one file per npub, readable only by the user
 * (directory 0700, file 0600). In CI the key comes from ANOFRONT_NSEC instead.
 */
export const keyDir = () => process.env.ANOFRONT_HOME ?? join(homedir(), '.config', 'anofront', 'keys')
const keyFile = (npub: string) => join(keyDir(), `${npub}.nsec`)

export interface SiteKey {
  sk: Uint8Array
  pubkey: string
  npub: string
}

export function fromNsec(nsec: string): SiteKey {
  const d = nip19.decode(nsec.trim())
  if (d.type !== 'nsec') throw new Error('not an nsec')
  const pubkey = getPublicKey(d.data)
  return { sk: d.data, pubkey, npub: nip19.npubEncode(pubkey) }
}

export function newKey(): SiteKey {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  return { sk, pubkey, npub: nip19.npubEncode(pubkey) }
}

export const toNsec = (k: SiteKey) => nip19.nsecEncode(k.sk)

export async function saveKey(k: SiteKey): Promise<string> {
  const dir = keyDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dir, 0o700)
  const file = keyFile(k.npub)
  await writeFile(file, toNsec(k) + '\n', { mode: 0o600, flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EEXIST') throw new Error(`a key for ${k.npub} is already stored at ${file}`)
    throw e
  })
  return file
}

export async function loadKey(npub: string): Promise<SiteKey> {
  const env = process.env.ANOFRONT_NSEC
  if (env) {
    const k = fromNsec(env)
    if (k.npub !== npub) throw new Error(`ANOFRONT_NSEC belongs to ${k.npub}, but this site is ${npub}`)
    return k
  }
  const file = keyFile(npub)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new Error(`No key for ${npub}. Expected ${file}, or set ANOFRONT_NSEC (CI). Restore it with \`anofront key import\`.`)
  }
  if (process.platform !== 'win32') {
    const mode = (await stat(file)).mode & 0o777
    if (mode & 0o077) throw new Error(`${file} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${file}"`)
  }
  const k = fromNsec(raw)
  if (k.npub !== npub) throw new Error(`${file} holds the key for ${k.npub}, not ${npub}`)
  return k
}
