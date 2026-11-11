import type { Event, EventTemplate } from 'nostr-tools'
import type { SiteFile } from './files.js'
import { sha256Hex } from './util.js'

export const KIND_ROOT_SITE = 15128
export const KIND_SNAPSHOT = 5128
export const KIND_RELAY_LIST = 10002
export const KIND_SERVER_LIST = 10063

export type PathMap = Map<string, string>

/** NIP-5A aggregate: sha256 of the sorted "<hash> <path>\n" lines. */
export function aggregateHash(paths: PathMap): string {
  const lines = [...paths].map(([p, h]) => `${h} ${p}\n`).sort()
  return sha256Hex(lines.join(''))
}

export const pathsOf = (ev: Pick<Event, 'tags'>): PathMap =>
  new Map(ev.tags.filter((t) => t[0] === 'path' && t[1] && t[2]).map((t) => [t[1]!, t[2]!]))

export const serversOf = (ev: Pick<Event, 'tags'>) => ev.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => t[1]!)

export interface ManifestMeta {
  title?: string | undefined
  description?: string | undefined
}

function metaTags(meta: ManifestMeta): string[][] {
  const t: string[][] = []
  if (meta.title) t.push(['title', meta.title])
  if (meta.description) t.push(['description', meta.description])
  t.push(['client', 'anofront'])
  return t
}

export function rootSite(paths: PathMap, servers: string[], meta: ManifestMeta, createdAt: number): EventTemplate {
  return {
    kind: KIND_ROOT_SITE,
    created_at: createdAt,
    content: '',
    tags: [
      ...[...paths].sort(([a], [b]) => a.localeCompare(b)).map(([p, h]) => ['path', p, h]),
      ['x', aggregateHash(paths), 'aggregate'],
      ...servers.map((s) => ['server', s]),
      ...metaTags(meta),
    ],
  }
}

export const filesToPaths = (files: SiteFile[]): PathMap => new Map(files.map((f) => [f.path, f.sha256]))

/** kind 5128: a frozen copy of a published root site, addressable by its id (v<base36 id>.<gateway>). */
export function snapshotOf(site: Event): EventTemplate {
  return {
    kind: KIND_SNAPSHOT,
    created_at: site.created_at,
    content: '',
    tags: [['a', `${KIND_ROOT_SITE}:${site.pubkey}:`], ...site.tags.filter((t) => ['path', 'x', 'server', 'title', 'description'].includes(t[0]!))],
  }
}

export const relayList = (relays: string[], createdAt: number): EventTemplate => ({
  kind: KIND_RELAY_LIST,
  created_at: createdAt,
  content: '',
  tags: relays.map((r) => ['r', r]),
})

export const serverList = (servers: string[], createdAt: number): EventTemplate => ({
  kind: KIND_SERVER_LIST,
  created_at: createdAt,
  content: '',
  tags: servers.map((s) => ['server', s]),
})
