import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Event } from 'nostr-tools'
import { verifyEvent } from 'nostr-tools'
import { WebSocketServer } from 'ws'
import { sha256Hex } from '../src/util.js'

const port = (s: Server | WebSocketServer) => (s.address() as AddressInfo).port

export interface MockRelay {
  url: string
  events: Event[]
  reject: boolean
  close: () => Promise<void>
}

const matches = (ev: Event, f: { kinds?: number[]; authors?: string[]; ids?: string[] }) =>
  (!f.kinds || f.kinds.includes(ev.kind)) && (!f.authors || f.authors.includes(ev.pubkey)) && (!f.ids || f.ids.includes(ev.id))

export async function mockRelay(): Promise<MockRelay> {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const relay: MockRelay = {
    url: `ws://127.0.0.1:${port(wss)}`,
    events: [],
    reject: false,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()) }),
  }
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as unknown[]
      if (msg[0] === 'EVENT') {
        const ev = msg[1] as Event
        if (relay.reject || !verifyEvent(ev)) return ws.send(JSON.stringify(['OK', ev.id, false, 'blocked: test']))
        const replaceable = (ev.kind >= 10000 && ev.kind < 20000) || ev.kind === 0 || ev.kind === 3
        if (replaceable) relay.events = relay.events.filter((e) => !(e.kind === ev.kind && e.pubkey === ev.pubkey))
        relay.events.push(ev)
        ws.send(JSON.stringify(['OK', ev.id, true, '']))
      } else if (msg[0] === 'REQ') {
        const [, sub, filter] = msg as [string, string, Parameters<typeof matches>[1]]
        for (const ev of relay.events.filter((e) => matches(e, filter))) ws.send(JSON.stringify(['EVENT', sub, ev]))
        ws.send(JSON.stringify(['EOSE', sub]))
      }
    })
  })
  return relay
}

export interface MockBlossom {
  url: string
  blobs: Map<string, { data: Buffer; type: string }>
  /** Force a Content-Type on GET/HEAD (simulates servers that serve HTML as text/plain). */
  forceType?: string
  rejectUploads: boolean
  uploads: number
  deletes: string[]
  close: () => Promise<void>
}

export async function mockBlossom(): Promise<MockBlossom> {
  const b: MockBlossom = { url: '', blobs: new Map(), rejectUploads: false, uploads: 0, deletes: [], close: async () => {} }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const path = (req.url ?? '/').split('?')[0]!.slice(1)
    if (req.method === 'PUT' && path === 'upload') {
      if (b.rejectUploads || !String(req.headers.authorization ?? '').startsWith('Nostr ')) {
        res.writeHead(401, { 'x-reason': 'uploads disabled' }).end()
        return
      }
      const sha = sha256Hex(body)
      if (req.headers['x-sha-256'] !== sha) return res.writeHead(400).end()
      b.blobs.set(sha, { data: body, type: String(req.headers['content-type'] ?? 'application/octet-stream') })
      b.uploads++
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sha256: sha, size: body.length }))
      return
    }
    const sha = path.split('.')[0]!
    if (req.method === 'DELETE') {
      b.deletes.push(sha)
      b.blobs.delete(sha)
      return res.writeHead(200).end()
    }
    const blob = b.blobs.get(sha)
    if (!blob) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': b.forceType ?? blob.type, 'content-length': blob.data.length })
    res.end(req.method === 'HEAD' ? undefined : blob.data)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  b.url = `http://127.0.0.1:${port(server)}`
  b.close = () => new Promise((r) => server.close(() => r()))
  return b
}

export interface MockGateway {
  origin: string
  /** Replace a path's bytes (simulates a malicious gateway). */
  tamper: Map<string, string>
  /** Content-Type to send instead of the stored one (simulates a gateway that gets it wrong). */
  forceType?: string
  /** Serve this manifest instead of the newest (simulates cache). */
  pinned?: Event
  close: () => Promise<void>
}

/** A NIP-5A host: newest kind 15128 from the relay, blobs from the listed servers, /404.html fallback. */
export async function mockGateway(relay: MockRelay, servers: MockBlossom[]): Promise<MockGateway> {
  const g: MockGateway = { origin: '', tamper: new Map(), close: async () => {} }
  const server = createServer((req, res) => {
    const site = g.pinned ?? relay.events.filter((e) => e.kind === 15128).sort((a, b) => b.created_at - a.created_at)[0]
    if (!site) return res.writeHead(404).end('no site')
    const paths = new Map(site.tags.filter((t) => t[0] === 'path').map((t) => [t[1]!, t[2]!]))
    let p = (req.url ?? '/').split('?')[0]!
    if (p.endsWith('/')) p += 'index.html'
    let status = 200
    let sha = paths.get(p)
    if (!sha) {
      sha = paths.get('/404.html')
      status = 404
    }
    if (!sha) return res.writeHead(404).end('not found')
    if (g.tamper.has(p)) return res.writeHead(200, { 'content-type': 'text/html' }).end(g.tamper.get(p))
    const blob = servers.map((s) => s.blobs.get(sha!)).find(Boolean)
    if (!blob) return res.writeHead(502).end()
    res.writeHead(status, { 'content-type': g.forceType ?? blob.type }).end(blob.data)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  g.origin = `http://127.0.0.1:${port(server)}`
  g.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  return g
}
