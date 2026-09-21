# Guest upload (fork feature)

> This page documents a feature that exists only in the `feat/guest-upload`
> fork. It is **not** part of upstream immich-public-proxy, which is read-only
> by design — see the upstream [feature request policy](https://github.com/alangrainger/immich-public-proxy#feature-requests).

Lets visitors add photos and videos to a shared album from the gallery page,
with no Immich account.

## What a link must satisfy

Every condition below must hold. They are not redundant — each closes a
different way an upload link goes wrong once it is out of your hands.

| Condition | Where | Default |
|---|---|---|
| `ipp.upload.enabled` | IPP `config.json` | `false` |
| "Allow uploads" on the link | Immich share settings | off |
| Album share, not individual | — | always |
| Random key, not a slug | `ipp.upload.requireRandomKey` | `true` |
| Password set on the link | `ipp.upload.requirePassword` | `false` |
| Has an expiry, still in the future | `ipp.upload.requireExpiry` | `true` |
| Expiry within the horizon | `ipp.upload.maxExpiryDays` | `30` |
| Album below its ceiling | `ipp.upload.maxAssets` | `500` |

A share key is a **capability, not an identity**. It travels in URLs, browser
history, group chats and screenshots, and anyone holding it can write. These
conditions bound what that costs you when — not if — one ends up somewhere you
did not intend.

**Slugs are readable and therefore guessable** (`holiday-2026`); the generated
key is sixty-odd characters of entropy. Both are fine for reading, only one is
worth writing with. A slug link keeps serving its gallery — it just shows no
upload control.

**The ceiling is the only cumulative limit.** `maxFileSizeMb` bounds one file;
nothing else bounds how many. Without `maxAssets`, a leaked link is limited
only by your free disk. Counting the album's own assets keeps this stateless:
IPP stores nothing, and the count refreshes on every successful upload.

Set `maxExpiryDays` or `maxAssets` to `0` to disable that particular ceiling.

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
| `requireRandomKey` | `true` | Refuse `/s/<slug>` for writes. |
| `requirePassword` | `false` | Refuse links with no password. Off by default. |
| `requireExpiry` | `true` | Refuse links with no expiry, or already expired. |
| `maxExpiryDays` | `30` | Refuse links expiring further out than this. `0` disables. |
| `maxAssets` | `500` | Refuse once the album holds this many. `0` disables. |

### Choosing `maxFileSizeMb`

Measured against a real 54 000-photo library: photos sit at a 2.3 MB median,
5.7 MB at p95, 8.8 MB at p99 — **99.9 % under 25 MB**. Videos are a different
population entirely: 21 MB median, 210 MB at p95, up to multiple gigabytes.

So the number encodes a policy, not a technical limit:

- **25 MB** covers every photo including 48 MP RAW, and structurally excludes
  video (a clip that small is a few seconds of 1080p).
- **200 MB** — the default — covers photos plus the short clips people
  actually send. This is the right choice if you expect videos.
- Beyond that you are mostly widening the worst case for no practical gain.

Pair it with `maxAssets`: at 200 MB and a 500-asset ceiling, a leaked link
costs at most ~100 GB before it stops accepting anything, and expires by
itself within `maxExpiryDays`.

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

To be precise about what a visitor *does* control: the file bytes, the
filename (sanitised, and given an extension if it lacks one) and the capture
date (`X-IPP-Created-At`, validated and refused if it is more than a day in
the future). Everything else — `deviceAssetId`, `deviceId`, and the absence
of every other DTO field — is generated here.

Bytes are never staged in memory or on disk — the request streams straight
through to Immich, mirroring how `stream/asset.ts` streams downloads out.

## Caching

An upload-enabled gallery is served `Cache-Control: no-store`, and a
successful upload drops IPP's memoised share (120 s TTL). Without both, a
visitor would reload into a stale page that does not contain the photo they
just added.

Read-only galleries keep the configured `ipp.gallery.cacheTime` — **unless
they are password-protected**, which upstream already serves `no-store`, and
which this must never downgrade.

## Testing against a real Immich

The unit suite stubs `fetch`, so it cannot notice when Immich changes the
upload DTO, the shared-link permission map or the timeline enumeration. An
opt-in end-to-end suite exercises a deployed IPP against a live Immich:

```bash
export E2E_IMMICH_URL=https://immich.example.com
export E2E_IMMICH_API_KEY=...        # scoped key, see below
export E2E_IPP_URL=http://ipp-host:3000   # direct, NOT via a reverse proxy
export E2E_UPLOAD_MAX_MB=2           # must match the instance's configured
                                     # ipp.upload.maxFileSizeMb, and be <= 8.
                                     # Leave it out and THREE tests skip -
                                     # both oversize paths and the check that
                                     # an oversize upload is not filed anyway.
                                     # A green run without it is incomplete.
npm run test:e2e
```

### Running against a throwaway Immich

You do not need a personal instance. `test/immich-stack.yml` starts a pinned,
machine-learning-free Immich plus an IPP built from the checkout, and
`test/bootstrap.sh` takes it from empty to usable:

```bash
docker compose -f test/immich-stack.yml up -d --build --wait
eval "$(./test/bootstrap.sh)"        # exports the four variables below
cd app && npm run test:e2e && npm run test:browser
docker compose -f test/immich-stack.yml down -v
```

Measured on this stack: **8 seconds** from empty volumes to a bootstrapped
Immich with IPP attached, about **1.5 GB** resident and **3 GB** of images.
Dropping the ML container is most of that — the CUDA image alone is 4.5 GB,
and nothing here needs face detection or CLIP.

This is what CI uses, which is why CI needs no secrets at all.

The version is pinned deliberately. Running against "whatever is currently
installed" cannot tell you that Immich changed; running against a version you
bump on purpose can.

### Why an Immich API key, and how little it needs

Nothing in the upload path uses it. An upload is authorised by the share key
alone — that is the entire point of the feature, and the suite would be
worthless if it smuggled an API key into those requests.

The key exists to own the fixtures: create a throwaway album and its shared
links, read the album back to assert what landed, and delete all of it
afterwards. A share key cannot do any of that — it can upload into one album
and read that album, nothing more.

So it does **not** need to be an admin key. This exact set was verified
against Immich 3.2.2 by running the whole suite with a key holding only:

```
album.create  album.read  album.delete
sharedLink.create  sharedLink.delete
asset.read  asset.delete
```

Create it in Immich under **Account Settings → API Keys**, tick those seven,
and nothing else. It never touches photos outside the albums it creates.

The alternative — hand-made fixtures passed in as share keys — would need one
link per scenario (upload-enabled, read-only, slug, password-protected), and
would leave every uploaded test asset behind in your library, run after run.

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

## Upstream compatibility: what this depends on

Two dependencies worth knowing about, because they are the ones most likely
to break on an Immich upgrade:

- **Album enumeration goes through `/api/timeline/buckets` and
  `/api/timeline/bucket`.** Immich accepts shared-link authentication on both,
  but marks them **internal** — they are not stable public API. IPP uses them
  because Immich 3.0 removed album assets from `AlbumResponseDto`, and the
  Immich web client does the same thing. The e2e suite's own helper reads
  albums through `POST /api/search/metadata` instead, so a green helper does
  **not** prove the gallery path still works. The tests that load a gallery
  page and assert on its contents are what cover it.
- **`POST /api/search/metadata` with a flat `albumIds`** is deprecated since
  Immich 3.2.0 in favour of structured filters. Still accepted at 3.2.2; it
  will need adapting.

Running an ephemeral Immich pinned to one version would make these break
loudly and on purpose rather than silently in production — see below.

## What a visitor sees

The upload experience follows Immich's own upload panel
(`web/src/routes/UploadPanel.svelte`): a card floating above the page, one row
per file carrying a state icon and a progress bar, and a minimised badge with
the count. Someone who uses Immich should not have to learn a second idiom for
a link Immich gave them.

Two deliberate departures. Immich pins a ~324 px card bottom-right, which is
cramped on a 412 px phone — here it is a full-width sheet at the bottom below
600 px, where a thumb already is, and the floating card above that. And Immich
exposes an upload-concurrency control, which is an operator setting, not
something to put in front of an anonymous visitor.

Being `position: fixed` is load-bearing beyond looks: the panel never changes
the gallery's layout, so the virtualiser — which only recomputes on a width
change — has nothing to reconcile.

### Skipping what is already there

Before sending, the browser hashes the file and asks whether the owner
already holds those bytes. If so, nothing is transferred.

This matters most on the files it costs most to check: skipping a
five-minute video upload pays for a second of hashing many times over, while
on a 2 MB photo both are imperceptible.

The mechanism is Immich's `x-immich-checksum` header on the upload route.
Its `AssetUploadInterceptor` answers `duplicate` **before** the file
interceptor runs, so the body is never read — one round trip, no media bytes.
The dedicated endpoint for this, `POST /assets/bulk-upload-check`, is not an
option: unlike the upload route it carries no `sharedLink: true`, so a share
key gets `403`. Verified against Immich 3.2.2.

The digest is SHA-1 because that is what Immich compares. It is a **content
fingerprint for duplicate detection, not a security primitive** — SHA-1 is
unsuitable for the latter, and nothing here relies on it being.

Hashing uses the browser's own `crypto.subtle.digest`. That has no
incremental API, so the file is buffered whole: on a large video that is a
real allocation, and on a loaded phone it can fail. A hand-written streaming
digest would avoid it, and was written and tested — then removed. Maintaining
our own cryptographic primitive is not worth it for a duplicate check,
however well tested.

**Every failure falls through to an ordinary upload**: plain HTTP (WebCrypto
needs a secure context), a failed allocation, a check that errors. The
duplicate is still caught by Immich, just after the transfer — which is the
behaviour that existed before this. A broken check must never stop a file
being sent.

**The answer is confined to this share.** Immich looks a checksum up across
the owner's *entire library*, so an unrestricted answer would let a link
holder test whether the owner has any given file — including files too large
or of a type an upload would have refused, and **without possessing the bytes
at all**, which a catalogue of hashes makes cheap.

That is genuinely wider than what an ordinary upload discloses, so a positive
answer is only returned when the asset is already in the shared album — which
the visitor can see by scrolling the gallery. The response carries no asset
id: knowing "yes" is the point, knowing which row is not.

The cost of that restriction: a photo the owner holds elsewhere gets
re-uploaded. It would not have been added to the album anyway — Immich
deduplicates it without filing it — so the loss is bytes, not an outcome.

Checks share the upload concurrency budget and are cancelled when the visitor
disconnects.

### Progress

Transfer progress comes from `XMLHttpRequest`, because `fetch()` reports
nothing about how much of a request body has gone out. A `ReadableStream`
request body does not solve it either: it counts bytes consumed into the
browser's buffers rather than bytes on the wire, and stable iOS Safari does
not support it at all.

Each row shows `22% of 150 MB · 119 KB/s · 9s left`. The rate is a rolling
five-second estimate, so it tracks reality instead of averaging away a stalled
connection. On a phone sending a large video, a file counter alone cannot say
whether anything is moving.

The figures sit above the bar rather than inside it, as Immich writes them:
Immich's fill is a light accent on a dark track, so no single text colour
reads on both halves.

A **screen wake lock is requested** while uploads are in flight — the same
thing Immich's panel does — because both mobile platforms suspend a
backgrounded page and kill the upload.

Support is narrower than the rest of this feature: Safari iOS 16.4+, Chrome
Android 152+, secure context only. And the system **releases the lock
whenever the document becomes hidden**, so it is re-acquired on
`visibilitychange` — without that, glancing at another app returns you to an
upload with no lock, which is the usual way this API is got wrong.

It remains a request, not a guarantee: unsupported, denied, or released and
not regained. That is why the panel also says to keep the page open, and why
nothing here promises an upload survives being backgrounded.

### States

| State | Shown as |
|---|---|
| Waiting | Outline circle, "Waiting" |
| Sending | Spinner, bar, percentage / size / rate / ETA |
| Sent, not confirmed | Pulsing full bar, "Sent — waiting for the photo server…" |
| Added | Blue check |
| Already uploaded | Amber alert, "Already uploaded — skipped" |
| Failed | Red alert, the reason, and a retry button |
| Not attempted | Outline circle, "Not attempted" |

The bar never sits at a solid 100 %: between the last byte leaving the browser
and Immich accepting the asset there is a real wait, and calling that "added"
is a claim that gets found out on the next page load.

**Duplicates are not failures.** Immich deduplicates by checksum across the
owner's whole library — not per album — and does not file a duplicate into the
album, so the wording is "already uploaded", not "already in this album".

### When an upload fails

"Upload failed" is useless: retrying, picking a smaller file and asking the
album owner are three different next steps. So failures name the file and the
cause.

**Two kinds of failure, answered differently on purpose.** A share that does
not resolve — wrong key, missing password — gets the generic empty response,
so probing for valid links learns nothing. Once a share *has* resolved, the
visitor demonstrably holds a working link and can already see the gallery;
telling them why the upload was refused leaks nothing new.

| Situation | Status | Row reads |
|---|---|---|
| Unknown key | `404`, empty | (the gallery never loaded) |
| Uploads not enabled | `403 not-allowed` | This link no longer accepts uploads |
| Link expired | `403 expired` | This link has expired |
| Album at its ceiling | `403 album-full` | The album is full |
| Over the size cap | `413 too-large` | Larger than 200 MB |
| Not a photo or video | `400 not-media` | Not a photo or video |
| Empty file | `400 empty` | File is empty |
| Too many at once | `503 busy` | (held and retried after `Retry-After`) |
| Immich refused it | `502 upstream` | The photo server refused it |
| Stopped mid-transfer | — | Stopped — may have been added |

Size and emptiness are caught **in the browser, before a byte is sent**.
Uploading 300 MB over a phone connection and only then being told it was too
big is the kind of thing that makes people give up.

A refusal about the **link** rather than the file — expired, album full,
uploads disabled — marks the rest of the queue "not attempted" instead of
marching through it collecting the same refusal.

**Stopping is not rolling back.** An aborted upload may already have reached
Immich with only the response lost, so the row says "may have been added"
rather than guessing. Retrying is safe regardless: Immich deduplicates by
content.

### Accessibility

The bar updates many times a second; a live region echoing it would be
unusable. A separate visually-hidden `role="status"` node announces milestones
only — the file starting, roughly every 15 seconds during a long transfer, the
wait for confirmation, and the final summary.


## Licence obligation (AGPL-3.0 section 13)

Running a modified version that people reach over a network triggers section
13: those users must be offered the Corresponding Source, prominently, **for
the version actually running** — a public repository alone does not discharge
it.

Every page a visitor can land on therefore carries a `Source (<revision>)`
footer link. The revision comes from `APP_VERSION`, baked in at image build
time, so the link points at the exact commit serving the request. Set
`ipp.sourceUrl` if you fork this fork, so it offers your source rather than
someone else's.

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
- **No API key is involved in an upload.** The credential is the share key;
  a password-protected link additionally requires the password, which IPP
  exchanges for an Immich `immich_shared_link_token` cookie. For an
  unprotected link the key alone is enough, and it travels in URLs, browser
  history and messages — treat it as a capability you hand out, not an
  identity.
- **No per-visitor identity or attribution.** Every upload arrives as the
  share owner; you cannot tell which friend sent what.
