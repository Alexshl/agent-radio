import { describe, expect, it } from 'vitest'
import { openDb } from './db/client'
import { SecretStore, decryptString, encryptString } from './lib/secrets'
import { addUser, login, setup } from './test-utils'

describe('secret encryption', () => {
  it('round-trips and uses a fresh IV every time', async () => {
    const a = await encryptString('app-secret', 'sk-test-123', 'tts.azure.key')
    const b = await encryptString('app-secret', 'sk-test-123', 'tts.azure.key')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toContain('sk-test')
    expect(await decryptString('app-secret', a, 'tts.azure.key')).toBe('sk-test-123')
  })

  it('does not decrypt with another secret or under another name (AAD)', async () => {
    const s = await encryptString('app-secret', 'value', 'tts.azure.key')
    await expect(decryptString('other-secret', s, 'tts.azure.key')).rejects.toThrow()
    await expect(decryptString('app-secret', s, 'tts.openai.key')).rejects.toThrow()
  })

  it('SecretStore keeps ciphertext in the table and overwrites', async () => {
    const db = openDb(':memory:')
    const store = new SecretStore(db, () => 'k')
    expect(await store.get('x')).toBeNull()
    await store.put('x', 'plain-text-value')
    await store.put('y', 'other')
    const raw = db.$client.prepare('select * from secrets where name = ?').get('x') as { ciphertext: string }
    expect(JSON.stringify(raw)).not.toContain('plain-text-value')
    expect(await store.get('x')).toBe('plain-text-value')
    await store.put('x', 'second')
    expect(await store.get('x')).toBe('second')
    expect(store.has('x')).toBe(true)
    store.delete('x')
    expect(store.has('x')).toBe(false)
  })

  it('a provider key set through the admin API is encrypted at rest and never returned', async () => {
    const t = setup()
    await addUser(t, 'admin@x.io', 'admin')
    const cookie = await login(t, 'admin@x.io')
    const res = await t.req('/api/admin/tts/providers/azure', {
      method: 'PUT',
      cookie,
      json: { key: 'AZURE-SECRET-KEY-1234', region: 'westeurope' },
    })
    expect(res.status).toBe(200)
    const dump = JSON.stringify(t.db.$client.prepare('select * from secrets').all())
    expect(dump).not.toContain('AZURE-SECRET-KEY-1234')
    const state = await (await t.req('/api/admin/tts', { cookie })).text()
    expect(state).not.toContain('AZURE-SECRET-KEY-1234')
    expect(JSON.parse(state).providers.find((p: { id: string }) => p.id === 'azure').configured).toBe(true)
    expect((await t.req('/api/admin/tts/providers/azure', { method: 'DELETE', cookie })).status).toBe(200)
    expect(
      JSON.parse(await (await t.req('/api/admin/tts', { cookie })).text()).providers.find((p: { id: string }) => p.id === 'azure')
        .configured,
    ).toBe(false)
  })
})
