# anofront

**Deploy a static frontend to Nostr. No server to run, no domain to buy.**

```sh
npx @anofront/cli init     # creates anofront.json and a site key
npx @anofront/cli deploy   # build → upload → publish → verify
```

```
Live:
  https://npub1….nsite.lol/
```

anofront publishes your build output as an [nsite](https://github.com/nostr-protocol/nips/blob/master/5A.md)
(NIP-5A): the files go to [Blossom](https://github.com/hzrd149/blossom) servers, a signed manifest
(path → sha256) goes to Nostr relays, and public gateways serve it as a normal HTTPS website at
`https://<npub>.<gateway>/`. You need no account, no VPS and no custom domain.

It is the frontend half of [anoDB](https://github.com/sho-ritz/anodb): the app code is hosted
through anofront and the app data syncs through anoDB, both over Nostr.

## What `deploy` does

Each step runs only if the one before it worked:

1. **Build** with the detected command (`npm run build`, …). Skip it with `--no-build`.
2. **Upload** every file to Blossom servers until 3 of them hold all of it (at least 2 are
   required). A server counts only if it serves each file back with the right `Content-Type`.
   Some servers serve HTML as `text/plain`, which would make the gateway send a download.
   Files that are already there are not uploaded again.
3. **Publish** the manifest (kind 15128). At least 3 relays must accept it.
4. **Publish** the relay list (10002) and server list (10063), also to the lookup relays that
   gateways use to find your site.
5. **Snapshot** this version (kind 5128) so you can roll back.
6. **Verify** by fetching every path from the canonical gateway and the mirrors, then comparing
   each hash with what you signed.

## SPA routing

NIP-5A has no SPA fallback, so a URL like `/chat/42` would return 404. When the build has a
single HTML file, anofront also publishes `index.html` as `/404.html`, so the app loads on any
path. Routes listed in `"routes"` get their own `index.html` copy and answer 200. The copies
have the same hash, so they cost no extra upload.

## Configuration (`anofront.json`)

```jsonc
{
  "npub": "npub1…",             // the site's public key (the secret key is never stored here)
  "dir": "dist",                // build output
  "build": "npm run build",     // "" to disable
  "gateway": "nsite.lol",       // canonical URL: https://<npub>.nsite.lol/
  "mirrors": ["nsite.run", "nsite.cloud"],
  "routes": ["/chat", "/settings"],
  "spa": "auto",                // true | false | "auto" (single HTML file)
  "exclude": ["*.map"],
  "servers": ["https://…"],     // instead of the built-in candidates
  "relays": ["wss://…"],
  "title": "My app",
  "domain": "www.example.com"   // optional, see below
}
```

Dotfiles (except `/.well-known/`), `node_modules` and `anofront.json` are never published.

## The site key

The site URL is the site's public key, so the key is the site.

- `init` generates a **dedicated key** per site, separate from your personal Nostr key.
- It shows the nsec once and **won't continue until you type its last 8 characters**, as proof
  that you saved it. If you lose the key, the URL can never be updated again.
- The key is stored at `~/.config/anofront/keys/<npub>.nsec`, mode 0600 in a 0700 folder. It is
  never stored in the project, and `anofront.json` is refused if it contains an nsec.
- In CI, set `ANOFRONT_NSEC`. It must belong to the `npub` in `anofront.json`.
- `anofront key export` shows the key again; `anofront key import` restores it on a new machine.

## Commands

| command | |
|---|---|
| `init [--import] [--gateway <host>]` | detect the framework, create the key and `anofront.json` |
| `deploy [--no-build]` | build, upload, publish, verify. Exit code 1 if the canonical gateway fails verification |
| `verify` | check that the gateways serve exactly what you signed; run it from a CI cron to monitor |
| `url` | print the site URL |
| `versions` | list snapshots with their `https://v<id>.<gateway>/` URLs |
| `rollback <snapshot>` | make an earlier version live again (only if its files still exist) |
| `prune --keep <n>` | delete files used only by versions older than the newest *n* (asks first) |
| `domain` | check an optional custom domain |

Old files are **never deleted automatically**. Gateways cache pages for up to an hour, so
visitors may still load old chunks after an update.

## Trust model: read this

- **Relays and Blossom servers are untrusted.** Every file is addressed by its hash and listed in
  a manifest you signed.
- **The gateway is trusted for code delivery.** A browser receives its first response from the
  gateway and cannot check it against your signature on its own. A malicious gateway could serve
  different JavaScript. For an anoDB app, that would mean access to the device keys and the
  decrypted data. anofront cannot prevent this in a plain browser. It does three things:
  - `deploy` and `verify` fetch every file through several independent gateways and fail when
    the bytes match no version you published. Gateway cache staleness is reported separately.
  - Pick a canonical gateway you trust, and monitor it with `anofront verify` on a schedule.
  - nsite.cloud is not the default canonical gateway: it caches `/` for a year as `immutable`,
    so returning visitors would not get updates.

## Gateways, origins and anoDB

Each gateway URL is a different browser origin. Data that anoDB stores in the browser (the
local database and device keys) belongs to one origin. Opening the same app on a mirror gives
an empty, separate device, which has to be paired to join.

- Share the **canonical** URL. Mirrors are for verification and emergencies.
- anofront adds `<meta name="anofront:canonical" content="https://<npub>.<gateway>/">` to every
  HTML file, so the app can warn when it runs on another origin.
- If the canonical gateway shuts down, switch `"gateway"` and have users pair their devices again
  on the new URL.

## Custom domain (optional)

The site already works without a domain. To try one:

```
www.example.com.  CNAME  <npub>.nsite.lol.
```

Then run `anofront domain`. It checks DNS, HTTPS and whether the same page is served. A CNAME
only routes traffic: the gateway must also issue a TLS certificate for your domain, and as of
2026-11 we have not confirmed a public gateway that does. A custom domain is also a new origin
(see above).

## Requirements and limits

- Node.js 22+
- Static output only. SSR, API routes and middleware don't run (Next.js needs `output: 'export'`).
- Free public servers make no promise about how long they keep your files. anofront spreads
  each file across several servers, but that is not a retention guarantee.

## Status

v0.1, tested against mock relays, Blossom servers and gateways. Not yet run against the public
network. MIT.
