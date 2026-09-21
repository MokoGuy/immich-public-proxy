#!/usr/bin/env node

import 'dotenv/config'
import express from 'express'
import cookieSession from 'cookie-session'
import {
  accessible,
  enforceMinimumImmichVersion,
  fetchAssetDetail,
  getKeyTypeFromShare,
  getShareByKey,
  handleShareRequest,
  invalidateShare,
  isId,
  isKey
} from './immich'
import { buildAssetMetadata } from './gallery/metadata'
import crypto from 'crypto'
import { assetBuffer } from './stream/asset'
import { downloadAssets } from './stream/download'
import { checkDuplicate, uploadAsset } from './stream/upload'
import dayjs from 'dayjs'
import { NextFunction, Request, Response } from 'express-serve-static-core'
import { Asset, AssetType, ImageSize, KeyType, SharedLink } from './types'
import { boundSlot } from './upload-slot'
import { recordCheck, recordUpload, slotOpened, startUploadReporting } from './upload-log'
import { getConfigOption, getNumericConfigOption } from './config/access'
import { loadConfig } from './config/loader'
import { addResponseHeaders, asyncHandler, errorHandler } from './http'
import { canDownload, uploadRefusal } from './share'
import { toString } from './utils/text'
import { decrypt, encrypt } from './encrypt'
import { respondToInvalidRequest } from './invalidRequestHandler'
import { ASSET_VERSION } from './version'
import { h } from 'preact'
import { renderPage } from './view/render'
import { Home } from './view/home'

// Extend the Request type with a `password` property
declare module 'express-serve-static-core' {
  interface Request {
    password?: string;
  }
}

// Read config.json (or the inline CONFIG env var) and apply backward-compat
// migrations. Must run before any code that calls getConfigOption.
loadConfig()

const app = express()
app.use(cookieSession({
  name: 'session',
  httpOnly: true,
  sameSite: 'lax',
  secret: crypto.randomBytes(32).toString('base64url')
}))
// For parsing the password unlock form and POSTed JSON payloads
app.use(express.json())
// For parsing the selective-download form POST (form-encoded body)
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
// Cache-busted, immutable static assets under a per-release version segment.
const inProduction = process.env.NODE_ENV === 'production'
app.use('/share/static/' + ASSET_VERSION, express.static('public', {
  immutable: inProduction,
  maxAge: inProduction ? '365d' : 0,
  setHeaders: addResponseHeaders
}))
// Serve static assets from the 'public' folder as /share/static
app.use('/share/static', express.static('public', { setHeaders: addResponseHeaders }))
// Serve the same assets on /, to allow for /robots.txt and /favicon.ico
app.use(express.static('public', { setHeaders: addResponseHeaders }))
// Remove the X-Powered-By ExpressJS header
app.disable('x-powered-by')

/**
 * Middleware to decode the encrypted data stored in the session cookie
 */
const decodeCookie = (req: Request, _res: Response, next: NextFunction) => {
  const shareKey = req.params.key
  const session = req.session?.[shareKey]
  if (shareKey && session?.iv && session?.cr) {
    try {
      const payload = JSON.parse(decrypt({
        iv: toString(session.iv),
        cr: toString(session.cr)
      }))
      if (payload?.expires && dayjs(payload.expires) > dayjs()) {
        req.password = payload.password
      }
    } catch (e) { }
  }
  next()
}

/*
 * Shared route guards. Several routes need the same "resolve a share, reject
 * invalid / password-protected ones, optionally find the requested asset"
 * preamble. These return a discriminated result so each route keeps control of
 * its own response (e.g. the photo route redirects on password where the meta
 * and download routes return 401), while the validation order and the
 * `valid`/`link`/`passwordRequired` checks live in one place.
 */
type ShareResolution =
  | { ok: true, link: SharedLink }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

type SharedAssetResolution =
  | { ok: true, link: SharedLink, asset: Asset }
  | { ok: false, status: number, reason: string, passwordRequired?: boolean }

async function resolveShare (req: Request, keyType: KeyType): Promise<ShareResolution> {
  if (!isKey(req.params.key)) {
    return { ok: false, status: 404, reason: 'Invalid key for ' + req.path }
  }
  // The password is provided from the encrypted session cookie (if set) by
  // decodeCookie. Validating the share here prevents direct URL access from
  // bypassing password protection.
  const share = await getShareByKey(req.params.key, req.password, keyType)
  if (!share?.valid || !share.link) {
    return { ok: false, status: 404, reason: 'Invalid share link' }
  }
  if (share.passwordRequired) {
    return { ok: false, status: 401, reason: 'Password required', passwordRequired: true }
  }
  return { ok: true, link: share.link }
}

async function resolveSharedAsset (req: Request, keyType: KeyType): Promise<SharedAssetResolution> {
  if (!isId(req.params.id)) {
    return { ok: false, status: 404, reason: 'Invalid ID for ' + req.path }
  }
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) return resolved
  // Confirm the asset belongs to this share (defence in depth - Immich also
  // enforces this via the share key).
  const asset = resolved.link.assets.find(a => a.id === req.params.id)
  if (!asset) {
    return { ok: false, status: 404, reason: 'Asset not found in share' }
  }
  return { ok: true, link: resolved.link, asset }
}

/*
 * Two kinds of failure, answered differently on purpose.
 *
 * An unresolvable share - bad key, wrong password - stays generic, so probing
 * for valid links learns nothing. But once a share HAS resolved, the visitor
 * demonstrably holds a working link and can see the gallery; telling them why
 * their upload was refused leaks nothing they could not already observe, and
 * "Upload failed" is a miserable way to discover that the album filled up
 * while you were picking photos.
 *
 * The body is a machine-readable reason; the client turns it into a sentence
 * naming the file. Immich's own error text is never relayed - it can carry
 * user-controlled values.
 */
function refuseUpload (res: Response, status: number, reason: string, extra: Record<string, unknown> = {}): void {
  if (!res.headersSent) res.setHeader('Connection', 'close')
  res.status(status).json({ reason, ...extra })
}

/**
 * Fail an upload, signalling that the connection must not be reused.
 *
 * Every rejection here can land while the visitor is still sending: the gate
 * checks answer before reading a byte, and the size cap fires part-way
 * through. The unread remainder then sits on the socket, so the connection is
 * no longer safe to keep alive and we say so.
 *
 * Operators putting a reverse proxy in front should read the deployment note
 * in docs/config/upload.md: some proxies mishandle an early response on a
 * pooled connection. That is a property of the hop, not something this route
 * bends itself around - draining the body first and piping through an
 * intermediate stream were both tried and measured strictly worse.
 */
function failUpload (res: Response, status: number, reason: string): void {
  if (!res.headersSent) res.setHeader('Connection', 'close')
  respondToInvalidRequest(res, status, reason)
}

/**
 * Accept an ISO 8601 timestamp from the client, rejecting anything unparseable
 * or implausibly far in the future (a bad clock should not file a holiday
 * photo under the year 3000). Returns a normalised ISO string, or undefined.
 */
function parseCreatedAt (raw: unknown): string | undefined {
  const value = toString(raw)
  if (!value) return undefined
  const parsed = dayjs(value)
  if (!parsed.isValid()) return undefined
  if (parsed.isAfter(dayjs().add(1, 'day'))) return undefined
  return parsed.toISOString()
}

/*
 * [ROUTE] Healthcheck
 * The path matches for /share/healthcheck, and also the legacy /healthcheck
 */
app.get(/^(|\/share)\/healthcheck$/, asyncHandler(async (_req, res) => {
  if (await accessible()) {
    res.send('ok')
  } else {
    res.status(503).send()
  }
}))

/*
 * [ROUTE] This is the main URL that someone would visit if they are opening a shared link
 */
app.get('/:shareType(share|s)/:key/:mode(download)?', decodeCookie, asyncHandler(async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)

  if (keyType === KeyType.slug && !getConfigOption('ipp.allowSlugLinks', true)) {
    // Slug type links are not allowed
    respondToInvalidRequest(res, 404, 'Slug links are disabled in config.json')
  } else {
    await handleShareRequest({
      req,
      key: req.params.key,
      keyType,
      mode: req.params.mode,
      password: req.password
    }, res)
  }
}))

/*
 * [ROUTE] Receive an unlock request from the password page
 * Stores a cookie with an encrypted payload which expires in 1 hour.
 * After that time, the visitor will need to provide the password again.
 *
 * The data is encrypted/decrypted on the server as a db-less way of
 * managing user session data. The data is provided to the server by the
 * user's browser in its encrypted state.
 */
app.post('/share/unlock', asyncHandler(async (req, res) => {
  if (req.session && req.body.key) {
    req.session[req.body.key] = encrypt(JSON.stringify({
      password: req.body.password,
      expires: dayjs().add(1, 'hour').format()
    }))
  }
  res.send()
}))

/*
 * [ROUTE] Selective download - POST a list of asset IDs, get a zip of just those.
 * The list arrives as a single "assets" form field containing a JSON array.
 * Validates each ID against share.assets so the request can't pull anything
 * outside the share.
 */
app.post('/:shareType(share|s)/:key/download', decodeCookie, asyncHandler(async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)
  let requestedIds: unknown
  try {
    requestedIds = JSON.parse(String(req.body?.assets ?? '[]'))
  } catch (e) {
    respondToInvalidRequest(res, 400, 'Malformed assets list')
    return
  }
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    respondToInvalidRequest(res, 400, 'No assets selected')
    return
  }

  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) {
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  if (!canDownload(resolved.link)) {
    respondToInvalidRequest(res, 403, 'Downloads disabled for this share')
    return
  }

  const requested = new Set(requestedIds.map(String))
  const validAssets = resolved.link.assets.filter(a => requested.has(a.id))
  if (validAssets.length === 0) {
    respondToInvalidRequest(res, 400, 'No valid assets in selection')
    return
  }

  await downloadAssets(res, resolved.link, validAssets)
}))

/*
 * [ROUTE] Ask whether the album's owner already holds this content.
 *
 * The visitor sends a SHA-1 in `X-IPP-Checksum` and nothing else; if Immich
 * recognises it, the file never has to leave the device. That matters most on
 * the large files - skipping a five-minute video upload, not a two-second
 * photo.
 *
 * Same gate as an upload, deliberately: this must not become a way to probe a
 * library through a link that cannot write to it. It is not new information
 * either way - an ordinary upload already reports `duplicate` - but it does
 * make probing cheap, which is why it stays behind the same door.
 */
app.post('/:shareType(share|s)/:key/check', decodeCookie, asyncHandler(async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)
  if (keyType === KeyType.slug && !getConfigOption('ipp.allowSlugLinks', true)) {
    failUpload(res, 404, 'Slug links are disabled in config.json')
    return
  }

  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) {
    recordCheck('unresolved-share')
    failUpload(res, resolved.status, resolved.reason)
    return
  }
  const refusal = uploadRefusal(resolved.link)
  if (refusal) {
    // Recorded HERE rather than inside uploadRefusal: the gate is also
    // consulted while rendering a gallery, so instrumenting it would report
    // an upload refusal every time anyone merely looks at a read-only share.
    recordCheck(refusal)
    refuseUpload(res, 403, refusal)
    return
  }

  // Base64 of 20 bytes: 27 characters plus '='. Anything else is not a SHA-1
  // and has no business reaching Immich.
  const checksum = toString(req.headers['x-ipp-checksum'])
  if (!/^[A-Za-z0-9+/]{27}=$/.test(checksum)) {
    recordCheck('bad-checksum')
    refuseUpload(res, 400, 'bad-checksum')
    return
  }

  if (uploadsInFlight >= UPLOAD_MAX_CONCURRENT) {
    recordCheck('busy')
    res.setHeader('Connection', 'close')
    res.status(503).set('Retry-After', '5').json({ reason: 'busy' })
    return
  }
  uploadsInFlight++
  const releaseSlot = slotOpened()

  const abort = new AbortController()
  const onClose = () => { if (!res.writableEnded) abort.abort() }
  res.on('close', onClose)
  const unbind = boundSlot(req.socket, abort, CHECK_IDLE_MS, CHECK_TOTAL_MS)

  try {
    const result = await checkDuplicate({
      key: req.params.key,
      keyType,
      password: req.password,
      checksum,
      signal: abort.signal
    })

    /*
     * Only answer for assets THIS share already shows.
     *
     * Immich looks a checksum up across the owner's entire library
     * (`getUploadAssetIdByChecksum(auth.user.id, ...)`), so an unrestricted
     * answer would tell a link holder whether the owner has a given file
     * anywhere - including files too large or of a type an upload would have
     * refused, and without them possessing the bytes at all. That is a
     * genuinely wider disclosure than an ordinary upload, which needs the
     * file and passes the size and media checks first.
     *
     * Confined to the share's own assets it tells the visitor nothing they
     * cannot already see by scrolling the gallery. The id stays out of the
     * response: knowing "yes" is the whole point, knowing which row is not.
     */
    if (!result.available) {
      recordCheck('unavailable')
      // Honest about not knowing. The client uploads either way, but an
      // operator watching responses can tell a working check that finds
      // nothing from one that has stopped working.
      res.json({ duplicate: false, checked: false })
      return
    }
    const inThisShare = !!result.id && resolved.link.assets.some(a => a.id === result.id)
    // One counter, not hit/miss: whether the owner holds a given file is the
    // library's business, and a hit/miss split would put that in the log.
    recordCheck('answered')
    res.json({ duplicate: inThisShare, checked: true })
  } finally {
    uploadsInFlight--
    releaseSlot()
    unbind()
    res.off('close', onClose)
  }
}))

/*
 * [ROUTE] Guest upload into a shared album.
 *
 * The visitor POSTs one file per request as a RAW body - not a form. Every
 * field Immich receives is generated by IPP (see stream/upload.ts), so an
 * uploader cannot reach the rest of `AssetMediaCreateDto`. Metadata that has
 * to come from the client travels in headers:
 *
 *   Content-Type          the file's own mime type
 *   X-IPP-Filename        original filename, sanitised before use
 *   X-IPP-Created-At      ISO 8601 capture time, validated below
 *
 * Authorisation mirrors the selective-download route exactly: resolve the
 * share from the SUBMITTED key (never `SharedLink.key`, which is always the
 * canonical key even for a /s/<slug> request), then check the gate. The
 * password, if any, comes from the encrypted session cookie via decodeCookie
 * and is turned into an Immich shared-link login cookie by authHeaders().
 */
const UPLOAD_MAX_CONCURRENT = Math.max(1, getNumericConfigOption('ipp.upload.maxConcurrent', 2))
/*
 * Admission control, NOT a queue. `createLimiter` (used by the download path)
 * parks excess callers indefinitely - fine for a handful of internal fetches,
 * wrong for an anonymous public write path: each parked request keeps its
 * socket, its buffered input and its closure alive, and a visitor who
 * disconnects while queued stays queued. Someone holding an upload link could
 * accumulate those until the proxy falls over, taking read-only visitors with
 * it. So we refuse over capacity immediately, before touching the body, and
 * tell the client to come back.
 */
let uploadsInFlight = 0

/*
 * Idle bound: silence longer than this means the visitor is gone, or Immich
 * has stopped answering for a single asset - both abnormal. A slow upload
 * keeps delivering bytes and never reaches it. Total bound: the backstop that
 * makes "a slot always comes back" unconditional.
 */
const UPLOAD_IDLE_MS = Math.max(10, getNumericConfigOption('ipp.upload.idleTimeoutSeconds', 120)) * 1000
const UPLOAD_TOTAL_MS = Math.max(60, getNumericConfigOption('ipp.upload.maxDurationSeconds', 1800)) * 1000
// The probe sends no bytes, so it has no reason to be slow.
const CHECK_IDLE_MS = 30_000
const CHECK_TOTAL_MS = 60_000

app.post('/:shareType(share|s)/:key/upload', decodeCookie, asyncHandler(async (req, res) => {
  const keyType = getKeyTypeFromShare(req.params.shareType)

  // Same guard the gallery route applies: with `ipp.allowSlugLinks` off, the
  // slug is not a credential at all - it must not authorise a write either.
  if (keyType === KeyType.slug && !getConfigOption('ipp.allowSlugLinks', true)) {
    failUpload(res, 404, 'Slug links are disabled in config.json')
    return
  }

  if (uploadsInFlight >= UPLOAD_MAX_CONCURRENT) {
    recordUpload('busy')
    res.setHeader('Connection', 'close')
    res.status(503).set('Retry-After', '5').json({ reason: 'busy' })
    return
  }
  /*
   * Reserve the slot HERE, with no await between the check and the increment.
   * The loop is single-threaded, so those two statements together are atomic;
   * anything asynchronous in between is not. Reserving later - after share
   * resolution, say - lets every concurrent caller read the same zero, pass
   * the check together and then all increment, which is no cap at all.
   */
  uploadsInFlight++
  const releaseSlot = slotOpened()

  // Register disconnect handling BEFORE the first await: the visitor can go
  // away during share resolution too. `res` close (rather than the request's
  // 'aborted') also covers a visitor who finished sending and then hung up
  // while Immich was still working - the same approach stream/asset.ts takes.
  const abort = new AbortController()
  const onClose = () => { if (!res.writableEnded) abort.abort() }
  res.on('close', onClose)
  if (res.destroyed) abort.abort()
  const unbind = boundSlot(req.socket, abort, UPLOAD_IDLE_MS, UPLOAD_TOTAL_MS)

  try {
    await handleUpload(req, res, keyType, abort)
  } finally {
    uploadsInFlight--
    releaseSlot()
    unbind()
    res.off('close', onClose)
  }
}))

async function handleUpload (req: Request, res: Response, keyType: KeyType, abort: AbortController): Promise<void> {
  const resolved = await resolveShare(req, keyType)
  if (!resolved.ok) {
    // 401 and 404 collapse into one label deliberately: a log that
    // distinguished them would say which keys exist.
    recordUpload('unresolved-share')
    failUpload(res, resolved.status, resolved.reason)
    return
  }
  const refusal = uploadRefusal(resolved.link)
  if (refusal) {
    recordUpload(refusal)
    // 403, not 404: the share resolved, so this is "you may not", not "no
    // such thing". `album-full` and `expired` in particular are states a
    // legitimate visitor reaches mid-session.
    refuseUpload(res, 403, refusal, {
      maxAssets: getNumericConfigOption('ipp.upload.maxAssets', 500)
    })
    return
  }

  const contentType = String(req.headers['content-type'] || '')
  if (!/^(image|video)\//.test(contentType)) {
    recordUpload('not-media')
    refuseUpload(res, 400, 'not-media')
    return
  }
  const createdAt = parseCreatedAt(req.headers['x-ipp-created-at'])
  if (!createdAt) {
    recordUpload('bad-date')
    refuseUpload(res, 400, 'bad-date')
    return
  }

  const maxBytes = Math.max(1, getNumericConfigOption('ipp.upload.maxFileSizeMb', 200)) * 1024 * 1024
  // Cheap pre-check; the authoritative limit is counted mid-stream in
  // stream/upload.ts, because a chunked request carries no Content-Length.
  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > maxBytes) {
    recordUpload('too-large')
    refuseUpload(res, 413, 'too-large', { maxBytes })
    return
  }

  const outcome = await uploadAsset({
    key: req.params.key,
    keyType,
    password: req.password,
    filename: toString(req.headers['x-ipp-filename']) || 'upload',
    contentType,
    createdAt,
    body: req,
    maxBytes,
    signal: abort.signal
  })

  if (!outcome.ok) {
    if (outcome.reason === 'aborted') {
      // The visitor vanished, or a slot bound fired. Either way no verdict
      // was reached, so this is not counted as a refusal.
      recordUpload('client-gone')
      if (!res.writableEnded) res.end()
      return
    }
    recordUpload(
      outcome.reason === 'rejected'
        ? 'upstream-rejected'
        : outcome.reason === 'error' ? 'invalid-response' : outcome.reason
    )
    // 'empty' and 'not-media' are the visitor's mistake, not Immich's: the
    // body never matched what the request claimed it was.
    const status = outcome.reason === 'too-large'
      ? 413
      : (outcome.reason === 'empty' || outcome.reason === 'not-media') ? 400 : 502
    refuseUpload(res, status, outcome.reason === 'rejected' || outcome.reason === 'error'
      ? 'upstream'
      : outcome.reason, { maxBytes })
    return
  }

  /*
   * The album just changed, so the memoised share must go - otherwise
   * `resolveSharedAsset` keeps rejecting the new id as "not in share" for up
   * to 120s and the visitor watches their own photo 404.
   *
   * BOTH identities have to be dropped. A /s/<slug> gallery warms the
   * `slug:<slug>` entry, but the thumbnail and metadata URLs it renders are
   * built from the canonical key and warm a separate `key:<canonical>` entry.
   * Invalidating only the one we were addressed by would refresh the page and
   * still 404 every new thumbnail on it.
   */
  invalidateShare(req.params.key, req.password, keyType)
  if (resolved.link.key && resolved.link.key !== req.params.key) {
    invalidateShare(resolved.link.key, req.password, KeyType.key)
  }

  // "created" means Immich accepted and stored it. It does not promise the
  // thumbnail is ready or that the visitor received this response.
  recordUpload(outcome.status === 'duplicate' ? 'duplicate' : 'created')
  /*
   * A photo whose file carries no capture date at all gets dated by whatever
   * the browser reported, which for a copy exported by a mobile picker is the
   * moment of the export - so the album shows it as taken today. Counted so
   * the owner can see it happening, and returned so the visitor is told
   * rather than left to discover it later.
   */
  if (outcome.dateSource === 'client') recordUpload('no-capture-date')
  res.json({ id: outcome.id, status: outcome.status, dateSource: outcome.dateSource })
}

/*
 * [ROUTE] Catch accidental POST requests to share URLs (e.g. from browser history
 * state issues) and force a clean GET redirect.
 * See https://github.com/alangrainger/immich-public-proxy/pull/205
 */
app.post('/:shareType(share|s)/:key/:mode(download)?', (req, res) => {
  res.redirect(303, req.originalUrl)
})

/*
 * [ROUTE] This is the direct link to a photo or video asset
 */
app.get('/share/:type(photo|video)/:key/:id/:size?', decodeCookie, asyncHandler(async (req, res) => {
  // Add the headers configured in config.json (most likely `cache-control`)
  addResponseHeaders(res)

  // Validate the size parameter
  if (req.params.size && !Object.values(ImageSize).includes(req.params.size as ImageSize)) {
    respondToInvalidRequest(res, 404, 'Invalid size parameter ' + req.path)
    return
  }

  // Resolve the share + asset (this is a `/share/...` route, always key auth).
  // The resolved asset gives assetBuffer access to originalMimeType and
  // originalFileName (needed for Content-Disposition and for requiresOriginal
  // to recognise videos/animated images and bypass the preview downgrade).
  const resolved = await resolveSharedAsset(req, KeyType.key)
  if (!resolved.ok) {
    // Password-protected: redirect to the share page so the visitor gets the
    // unlock prompt, rather than returning an error.
    if (resolved.passwordRequired) {
      res.redirect('/share/' + req.params.key)
      return
    }
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }
  const asset: Asset = {
    ...resolved.asset,
    type: req.params.type === 'video' ? AssetType.video : resolved.asset.type
  }

  const request = {
    req,
    key: req.params.key,
    range: req.headers.range || ''
  }
  await assetBuffer(request, res, asset, req.params.size, resolved.link, req.params.type === 'video')
}))

/*
 * [ROUTE] On-demand per-asset metadata for lazy album items.
 *
 * Album shares enumerate their assets from the timeline API, which yields
 * grid-only data (no exif / filename / description). When such an item opens
 * in the lightbox, the client fetches its detail from here. The id is
 * validated against the share's asset set (defence in depth - Immich also
 * enforces this via the share key) before we fetch `GET /assets/:id`.
 */
app.get('/:shareType(share|s)/meta/:key/:id', decodeCookie, asyncHandler(async (req, res) => {
  addResponseHeaders(res)

  const resolved = await resolveSharedAsset(req, getKeyTypeFromShare(req.params.shareType))
  if (!resolved.ok) {
    respondToInvalidRequest(res, resolved.status, resolved.reason)
    return
  }

  const detail = await fetchAssetDetail(resolved.asset)
  if (!detail) {
    respondToInvalidRequest(res, 404, 'Asset detail unavailable for ' + req.params.id)
    return
  }

  res.json(buildAssetMetadata(detail, resolved.link))
}))

/*
 * [ROUTE] Home page
 *
 * It was requested here to have *something* on the home page:
 * https://github.com/alangrainger/immich-public-proxy/discussions/19
 *
 * If you don't want to see this, set showHomePage as false in your config.json:
 * https://github.com/alangrainger/immich-public-proxy?tab=readme-ov-file#immich-public-proxy-options
 */
if (getConfigOption('ipp.showHomePage', true)) {
  app.get(/^\/(|share)\/*$/, (_req, res) => {
    addResponseHeaders(res)
    res.send(renderPage(h(Home, {})))
  })
}

/*
 * Send a 404 for all other routes
 */
app.get('*', (req, res) => {
  respondToInvalidRequest(res, 404, 'Invalid route ' + req.path)
})

/*
 * Terminal error middleware: any throw/rejection inside a route (routed here
 * by asyncHandler) is logged and answered per the 404 privacy policy, instead
 * of escaping to process level.
 */
app.use(errorHandler)

// Send the correct process error code for any uncaught exceptions
// so that Docker can gracefully restart the container
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
// Log-only: with asyncHandler routing request errors into errorHandler, a
// stray rejection from a background task (the version check, etc.) is not
// worth killing every in-flight request for.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  server.close()
  process.exit(0)
})

// Start the ExpressJS server
const port = Number(process.env.IPP_PORT) || 3000
const server = app.listen(port, () => {
  console.log(dayjs().format() + ' Server started on port ' + port)
  // Periodic summary of the guest-upload routes. Armed unconditionally: when
  // uploads are disabled the counters stay empty and it stays silent, but an
  // operator who turns them on gets visibility without a second switch.
  startUploadReporting(UPLOAD_MAX_CONCURRENT)
  // Bail out early if the Immich server is older than IPP supports, rather
  // than silently serving broken album shares. Unknown/unreachable is
  // tolerated (logs a warning and continues) - see enforceMinimumImmichVersion.
  enforceMinimumImmichVersion().catch(e => console.error('Immich version check failed:', e))
})
