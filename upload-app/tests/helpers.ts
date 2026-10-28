import { AlbumType, KeyType, loadConfig, SharedLink } from '@ipp/core'

/** Load `config` as if it came from the `CONFIG` env var. */
export function setConfig (config: Record<string, unknown>) {
  process.env.CONFIG = JSON.stringify(config)
  loadConfig()
}

export function resetConfig () {
  delete process.env.CONFIG
  loadConfig()
}

export function share (overrides: Partial<SharedLink> = {}): SharedLink {
  return {
    id: 'ffffffff-0000-0000-0000-000000000001',
    key: 'share-key',
    keyType: KeyType.key,
    type: AlbumType.album,
    assets: [],
    // The default upload policy wants an expiry within 30 days
    expiresAt: inDays(7),
    allowUpload: true,
    album: { id: 'aaaaaaaa-0000-0000-0000-000000000002', albumName: 'Holiday 2025' },
    ...overrides
  }
}

/** An ISO timestamp `days` from now. */
export function inDays (days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}
