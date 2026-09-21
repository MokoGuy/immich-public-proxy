import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

/*
 * The footer is the AGPL section 13 offer, so what it says matters: it has to
 * identify the version actually running. These run the module fresh each time
 * because APP_VERSION / APP_BUILD_DATE are resolved once at import.
 */
async function labelFor (version?: string, built?: string) {
  const prevV = process.env.APP_VERSION
  const prevB = process.env.APP_BUILD_DATE
  if (version === undefined) delete process.env.APP_VERSION
  else process.env.APP_VERSION = version
  if (built === undefined) delete process.env.APP_BUILD_DATE
  else process.env.APP_BUILD_DATE = built

  // The module reads the env once at import, so the cache has to go.
  vi.resetModules()
  const mod = await import('../src/source')
  const out = { label: mod.sourceLabel(), url: mod.sourceUrl() }

  if (prevV === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = prevV
  if (prevB === undefined) delete process.env.APP_BUILD_DATE; else process.env.APP_BUILD_DATE = prevB
  return out
}

describe('footer source offer', () => {
  beforeEach(() => { delete process.env.CONFIG })
  afterEach(() => { delete process.env.CONFIG })

  it('names the product, the version and when it was built', async () => {
    const { label } = await labelFor('v3.3.1-upload.2', '2026-09-21T08:00:00Z')
    expect(label).toBe('IPP v3.3.1-upload.2 (2026-09-21)')
  })

  it('abbreviates a commit build, which is unreadable in full', async () => {
    const { label, url } = await labelFor('a'.repeat(40), '2026-09-21T08:00:00Z')
    expect(label).toBe('IPP aaaaaaa (2026-09-21)')
    // The href keeps the full ref: the label is for humans, the link is the
    // section 13 offer and has to resolve.
    expect(url).toContain('/tree/' + 'a'.repeat(40))
  })

  it('copes with no build date', async () => {
    const { label } = await labelFor('v1.2.3')
    expect(label).toBe('IPP v1.2.3')
  })

  it('ignores an unparseable build date rather than printing it raw', async () => {
    const { label } = await labelFor('v1.2.3', 'not-a-date')
    expect(label).toBe('IPP v1.2.3')
  })

  it('falls back to the repo root for a dev build, with no dangling ref', async () => {
    const { label, url } = await labelFor('dev', '2026-09-21T08:00:00Z')
    expect(label).toBe('IPP (2026-09-21)')
    expect(url).not.toContain('/tree/')
  })
})
