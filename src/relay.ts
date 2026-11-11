import type { Event, Filter } from 'nostr-tools'
import { verifyEvent } from 'nostr-tools'

export interface PublishResult {
  relay: string
  ok: boolean
  message: string
}

const TIMEOUT = 10_000

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const t = setTimeout(() => {
      ws.close()
      reject(new Error('connect timeout'))
    }, TIMEOUT)
    ws.onopen = () => {
      clearTimeout(t)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(t)
      reject(new Error('connection failed'))
    }
  })
}

export async function publishOne(url: string, ev: Event): Promise<PublishResult> {
  let ws: WebSocket
  try {
    ws = await open(url)
  } catch (e) {
    return { relay: url, ok: false, message: (e as Error).message }
  }
  return new Promise((resolve) => {
    const done = (ok: boolean, message: string) => {
      clearTimeout(t)
      ws.close()
      resolve({ relay: url, ok, message })
    }
    const t = setTimeout(() => done(false, 'no OK within 10s'), TIMEOUT)
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(String(m.data)) as unknown[]
        if (d[0] === 'OK' && d[1] === ev.id) done(d[2] === true, String(d[3] ?? ''))
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => done(false, 'closed before OK')
    ws.send(JSON.stringify(['EVENT', ev]))
  })
}

export const publish = (relays: string[], ev: Event) => Promise.all(relays.map((r) => publishOne(r, ev)))

/** Fetches events matching `filter` from all relays, keeping only validly signed ones, deduplicated. */
export async function query(relays: string[], filter: Filter): Promise<Event[]> {
  const seen = new Map<string, Event>()
  await Promise.all(
    relays.map(async (url) => {
      let ws: WebSocket
      try {
        ws = await open(url)
      } catch {
        return
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t)
          ws.close()
          resolve()
        }
        const t = setTimeout(done, TIMEOUT)
        ws.onmessage = (m) => {
          try {
            const d = JSON.parse(String(m.data)) as unknown[]
            if (d[0] === 'EVENT' && d[1] === 'q') {
              const ev = d[2] as Event
              if (!seen.has(ev.id) && verifyEvent(ev)) seen.set(ev.id, ev)
            } else if ((d[0] === 'EOSE' || d[0] === 'CLOSED') && d[1] === 'q') done()
          } catch {
            // ignore
          }
        }
        ws.onclose = done
        ws.send(JSON.stringify(['REQ', 'q', filter]))
      })
    }),
  )
  return [...seen.values()]
}

/** Newest event (replaceable semantics: highest created_at, then lowest id). */
export const newest = (evs: Event[]) =>
  evs.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))[0]
