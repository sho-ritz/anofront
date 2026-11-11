# Decisions

Agreed 2026-11-11 while reviewing the deployment policy ("Nostr site hosting: frontend deployment policy").

| # | Decision | Why |
|---|---|---|
| 1 | A small TypeScript/Node CLI of our own instead of wrapping nsyte | NIP-5A publishing is only "upload blobs + sign one event". Writing it ourselves lets us build in SPA handling, anoDB support, verification and strict security defaults, and lets `anodb` call it later. |
| 2 | **No custom domain required.** The site URL is `https://<npub>.<gateway>/` | Requirement. A custom domain is optional and only checked (`anofront domain`), never assumed: no public gateway was confirmed to issue TLS for custom domains. |
| 3 | A dedicated site key per site, root site (kind 15128) | A leaked key compromises one site, not the person's identity. A root site gives a readable npub URL; named sites (35128) use base36 labels. |
| 4 | The key is stored outside the project: `~/.config/anofront/keys/<npub>.nsec` (0600, folder 0700). CI uses `ANOFRONT_NSEC`. | The OS keychain was the first choice, but macOS `security` cannot take the secret from stdin non-interactively, and putting it on argv would expose it to other processes. A config file that contains an nsec is refused. |
| 5 | A backup is mandatory at generation: show the nsec once, then require its last 8 characters | Losing the key means the URL can never be updated again, and anoDB users would have to move to a new origin and pair again. |
| 6 | SPA: `index.html` → `/404.html` when the build has a single HTML file, plus `routes` copies | NIP-5A has no SPA fallback. The copies share a hash, so no extra upload. |
| 7 | Candidate servers and relays are measured, not trusted: ≥2 Blossom servers (stop at 3) that accept and serve back every file, and ≥3 relay acks. Content-Type is checked on the **gateway** response, not on Blossom | Server policies change. We first required the right Content-Type from Blossom too, but nsite-gateway sets it from the path, and Blossom servers (primal included) store JS as `text/plain`. With that check no server passed. |
| 8 | Steps are gated in order: blobs → manifest → 10002/10063 (also to the lookup relays) → snapshot → verify | Never point a manifest at files that are not there. Gateways find sites through the lookup relays. |
| 9 | Integrity: verify through the canonical gateway and the mirrors after every deploy, offer `verify` for cron monitoring, and document that the gateway is trusted for code | A plain browser cannot verify the gateway's first response. A Service Worker check can be defeated by a malicious gateway, so we don't pretend it protects. Bytes that match no published version are reported as possible tampering, and older versions as cache staleness. |
| 10 | One canonical gateway (default nsite.lol) plus mirrors. `<meta name="anofront:canonical">` is injected into HTML | Each gateway is a separate origin, and anoDB data lives per origin. nsite.cloud caches `/` for a year as immutable, so it is not used as canonical. |
| 11 | Changed-files-only upload, a 5128 snapshot per deploy, `rollback`; never delete automatically, only via `prune --keep N` | Gateways cache for about an hour, so old `index.html` files keep loading old chunks. |
| 12 | Name: anofront, npm `@anofront/cli` | Sits next to anoDB. |

## Verified facts (2026-11-11)

- nsite.lol, nsite.run and nsite.cloud served a real kind 15128 site at `<npub>.<host>` with
  hashes matching the manifest. Cache headers: nsite.lol `max-age=3600`, nsite.run `no-cache`,
  nsite.cloud `max-age=31536000, immutable`.
- nsite-gateway resolves sites through the lookup relays (purplepag.es, user.kindpag.es), reading
  10002 and 10063, and serves `/404.html` (status 404) for unknown paths.
- base36 is the 32-byte big-endian integer, `0-9a-z`, left-padded to 50 characters.

## First public deploy (2026-11-12, anodb-family-list)

- Blossom: blossom.primal.net, blossom.yakihonne.com and blossom.ditto.pub accepted all 44 files.
  Rejected: cdn.hzrd149.com and blossom.f7z.io (allow-list), cdn.nostrcheck.me (no HTML or
  `.txt`), blossom.band and blossom.nostr.build (CSS "does not match content"),
  cdn.satellite.earth (paid), cdn.sovbit.host (down).
- primal rejected base64url in the `Authorization: Nostr` header ("invalid base64"). Standard
  base64 works everywhere we tried.
- Relays: 5 of 7 accepted the manifest (relay.nsite.lol, relay.primal.net, relay.snort.social,
  offchain.pub, relay.nostr.net). nos.lol never answered OK, and relay.damus.io would not connect
  from here.
- Gateways: nsite.lol and nsite.cloud served all 48 paths with matching hashes. **nsite.run
  returned another site's HTML for `/favicon.ico`**: its CDN caches across subdomains. `verify`
  reported it as "matches no published version", so it is no longer a default mirror. This is
  exactly the failure class verification exists for.
- The app worked end to end from the gateway: sql.js WASM from `/anodb/`, IndexedDB, invite
  links, sync and roles.

## Open
- anoDB: read `anofront:canonical` and warn when running on a non-canonical origin.
- `anodb deploy` → anofront.
