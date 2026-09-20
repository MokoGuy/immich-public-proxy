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
