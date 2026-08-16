import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('installable DSH bundle', () => {
  it('declares one bundle patch and a web client', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['.']).toBe('./lib/index.js')
    // Hand-written strict descriptors are registered by the service itself;
    // exporting ./typert would make the automatic loader register the same
    // Remote package a second time.
    expect(manifest.exports['./typert']).toBeUndefined()
  })

  it('mounts one dual-face package-root row', () => {
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: mindspace-dsh-session-memory')
    expect(patch).not.toContain('mindspace-dsh-session-memory/memory')
    expect(patch).not.toContain('@deepseek-ai/dsh-session-memory-governance')
  })

  it('ships prebuilt artifacts without install-time execution', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(manifest.scripts.prepare).toBeUndefined()
    const client = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
    const typert = readFileSync(resolve(root, 'lib/typert.js'), 'utf8')
    expect(client).toContain('settings.sessionMemory')
    expect(client).toContain('$mount')
    expect(typert).toContain('package: "mindspace-dsh-session-memory"')
  })

  it('does not wait for its own Remote before mounting it', () => {
    const clientSource = readFileSync(resolve(root, 'src/client/index.ts'), 'utf8')
    expect(clientSource).toContain("export const inject = ['slots', 'locale', 'remote']")
    expect(clientSource).not.toMatch(/export const inject = \[[^\]]*remote\.sessionMemory/)
  })
})
