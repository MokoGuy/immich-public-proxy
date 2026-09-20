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
export E2E_IPP_URL=https://share.example.com
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

## Reverse proxies and early rejections

The upload route answers before the body has finished arriving whenever it
refuses one — that is what a size cap is for. On a direct connection this is
clean: an oversize upload returns `413` every time.

Through a reverse proxy it is not always clean. The proxy can be left holding
a pooled connection with an unconsumed request body on it, and a later upload
on that connection comes back as a **502 that never reached IPP at all** (it
leaves no log line here). Measured against Traefik 3.6: roughly one request in
six, immediately after an oversize rejection.

Draining the body before responding, and piping the request through an
intermediate stream, were both implemented and measured — both made it
strictly worse. The route sets `Connection: close` on every rejection, which
is the correct signal, and the remainder is the proxy hop's behaviour.

What this does **not** affect: an oversize upload is never stored either way.
The failure mode is a confusing status code, not a bypassed limit.

## What this does not do

- **No quota beyond the per-file cap.** Anyone holding the link can keep
  adding files until the disk fills. Use link expiry and revocation in Immich.
- **No content moderation.** Uploads land directly in the album.
- **The share key is the credential.** For a password-protected link the
  visitor additionally needs the password, which IPP exchanges for an Immich
  `immich_shared_link_token` cookie via `authHeaders()`. For an unprotected
  link the key alone is enough, and it travels in URLs, browser history and
  messages — treat it as a capability you hand out, not an identity.
- **No per-visitor identity or attribution.** Every upload arrives as the
  share owner; you cannot tell which friend sent what.
