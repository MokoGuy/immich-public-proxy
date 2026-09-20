# Guest upload (fork feature)

> This page documents a feature that exists only in the `feat/guest-upload`
> fork. It is **not** part of upstream immich-public-proxy, which is read-only
> by design — see the upstream [feature request policy](https://github.com/alangrainger/immich-public-proxy#feature-requests).

Lets visitors add photos and videos to a shared album from the gallery page,
with no Immich account.

## Two gates, both required

| Gate | Where | Default |
|---|---|---|
| `ipp.upload.enabled` | IPP `config.json` | `false` |
| "Allow uploads" on the link | Immich share settings | off |

A stock deployment of this fork behaves exactly like upstream until the
operator flips `ipp.upload.enabled`. Immich independently enforces the
per-link flag: a shared-link key for a link without `allowUpload` is rejected
at `POST /assets` with 401, so IPP's check is a UI gate plus defence in depth,
never the only thing standing between a visitor and a write.

Uploads are restricted to **album** shares. That is a restriction of this
fork, not of Immich — Immich will attach an upload to an individual share's
asset list too. An individual share is a hand-picked set of photos, where
letting a visitor append to it is rarely what the owner meant.

## Options

```json
{
  "ipp": {
    "upload": {
      "enabled": false,
      "maxFileSizeMb": 200,
      "maxConcurrent": 2
    }
  }
}
```

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Instance-wide opt-in. |
| `maxFileSizeMb` | `200` | Per-file ceiling, counted while streaming — a chunked request carries no `Content-Length`, so the declared size is only a cheap pre-check. |
| `maxConcurrent` | `2` | Uploads relayed to Immich at once, across all visitors. |

## How it works

The visitor's browser sends **one request per file**, with the raw file as the
body and its metadata in headers (`X-IPP-Filename`, `X-IPP-Created-At`). IPP
constructs the multipart request Immich receives, so every field is
server-generated.

That matters: `AssetMediaCreateDto` accepts sidecar data, visibility,
favourite state and live-photo linkage alongside the bytes. Relaying a
visitor's own multipart body would hand an anonymous uploader control over all
of them. Constructing multipart is trivial; parsing it would need a real
dependency, and this design avoids it entirely.

Bytes are never staged in memory or on disk — the request streams straight
through to Immich, mirroring how `stream/asset.ts` streams downloads out.

## Caching

An upload-enabled gallery is served `Cache-Control: no-store`, and a
successful upload drops IPP's memoised share (120 s TTL). Without both, a
visitor would reload into a stale page that does not contain the photo they
just added.

## Testing against a real Immich

The unit suite stubs `fetch`, so it cannot notice when Immich changes the
upload DTO, the shared-link permission map or the timeline enumeration. An
opt-in end-to-end suite exercises a deployed IPP against a live Immich:

```bash
export E2E_IMMICH_URL=https://immich.example.com
export E2E_IMMICH_API_KEY=...        # may create/delete albums, links, assets
export E2E_IPP_URL=http://ipp-host:3000   # direct, NOT via a reverse proxy
export E2E_UPLOAD_MAX_MB=2           # optional; must match the instance's
                                     # ipp.upload.maxFileSizeMb, and be <= 8,
                                     # or the size tests are skipped
npm run test:e2e
```

The target IPP needs `ipp.upload.enabled: true`. Without the three required
variables the whole suite is skipped, so `npm test` on a laptop never tries to
reach a server — and `npm test` excludes these files entirely regardless.

Fixtures are named `zz-ipp-e2e-*` and torn down in `afterAll`, assets
force-deleted so nothing is left in the trash. Any teardown failure is printed
rather than swallowed.

A third layer drives the gallery in a real browser, which is the only way to
exercise the file input, the drop zone and the status region:

```bash
npx playwright install chromium   # once
npm run test:browser
```

It earns its keep: the first thing it caught was a multi-file selection
uploading only its first file. Every request on the wire looked correct — the
page was quietly dropping the rest, because clearing `input.value` empties the
live `FileList` the upload loop was still iterating.

## What the route refuses

A red-team pass against the deployed fork produced two hardenings:

| Input | Before | Now |
|---|---|---|
| ZIP bytes announced as `image/png` | stored | `400` |
| Empty body | `502` | `400` |

The first is worth spelling out: **Immich decides an asset's type from the
filename extension and does not look at the bytes**, so `payload.png` is
accepted and stored whatever it contains — you only find out when thumbnail
generation fails. That is tolerable for an authenticated client; on an
anonymous public route it means anyone holding the link can park arbitrary
content in the owner's library. So the route checks the first 16 bytes against
the declared type. The rule is one-sided on purpose: a known signature that
disagrees is refused, an unrecognised type is passed through rather than
rejecting formats the table has not heard of.

Probes that already behaved correctly and are now covered by tests: CRLF and
quote injection through `X-IPP-Filename` (flattened, cannot open a second
multipart part), path traversal (reduced to a basename), a bogus session
cookie (ignored), a `?key=` query parameter alongside the path key (the path
wins), `/s/<canonical-key>` (404), oversized headers (431), and rejection
responses that carry an empty body and leak no Immich detail.

## Reverse proxies: a deployment note

Refusing an upload means answering before the body has arrived — that is what
a size cap is. The connection then carries an unread request remainder, so the
route sends `Connection: close`, which is the correct signal.

Some reverse proxies still mishandle it. Measured against Traefik 3.6: after
an oversize rejection, roughly one in six later uploads on that pooled
connection comes back as a **502 that never reaches IPP** — it leaves no log
line here, because the request never arrives.

This is not something the route bends itself around. Draining the body before
responding, and piping the request through an intermediate stream, were both
implemented and measured: the first produced universal 502s, the second hung
on `100 Continue`. Both were reverted. On a direct connection the answer is
`413` every time.

Consequences for you:

- **Test against IPP directly.** Point `E2E_IPP_URL` at the container, not at
  the proxy, or the suite measures the proxy's connection pool instead of this
  feature.
- **In production**, a visitor who picks an oversized file may occasionally
  see a gateway error rather than "file too large". Annoying, not dangerous:
  the upload is refused and never stored either way. Lowering
  `ipp.upload.maxFileSizeMb` below what your proxy already rejects at the edge
  avoids the situation entirely.

## What this does not do

- **No quota beyond the per-file cap.** Anyone holding the link can keep
  adding files until the disk fills. Use link expiry and revocation in Immich.
- **No content moderation.** Uploads land directly in the album, and appear in
  the owner's main timeline (`visibility: timeline`), not somewhere quarantined.
- **No per-format validation beyond the signature check.** The bytes are
  confirmed to match the declared type (see below), but a genuine image is
  still a genuine image from a stranger.
- **The share key is the credential.** For a password-protected link the
  visitor additionally needs the password, which IPP exchanges for an Immich
  `immich_shared_link_token` cookie via `authHeaders()`. For an unprotected
  link the key alone is enough, and it travels in URLs, browser history and
  messages — treat it as a capability you hand out, not an identity.
- **No per-visitor identity or attribution.** Every upload arrives as the
  share owner; you cannot tell which friend sent what.
