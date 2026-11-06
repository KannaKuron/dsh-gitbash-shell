import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const profiles = new Map()
const transient = new WeakMap()
const MODES = new Set(['minimal', 'standard', 'ptc', 'cordis'])
function validate(value) {
  if (value?.version !== 1 || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) throw new Error('invalid dsh-ops ownership journal; refusing to guess ownership')
  for (const [mode, field] of Object.entries(value.fields)) {
    if (!MODES.has(mode) || !field || typeof field.hadOverride !== 'boolean'
      || (field.hadOverride && typeof field.value !== 'boolean')) throw new Error('invalid dsh-ops ownership entry')
  }
  return value
}
/** A separate receipt, never a hand-edit of the profile configuration. */
export function opsOwnership(editor) {
  const documentPath = editor.documentPath
  const filename = typeof documentPath === 'string' && documentPath ? join(dirname(documentPath), '.gitbash-ops-ownership.json') : undefined
  const cache = filename ? profiles : transient
  const key = filename ?? editor
  if (cache.has(key)) return cache.get(key)
  let memory = { version: 1, fields: {} }
  let serial = Promise.resolve()
  const store = {
    run(task) {
      const result = serial.then(task)
      serial = result.catch(() => {})
      return result
    },
    async read() {
      if (!filename) return structuredClone(memory)
      try { return validate(JSON.parse(await readFile(filename, 'utf8'))) }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, fields: {} }; throw error }
    },
    async write(value) {
      validate(value)
      if (!filename) { memory = structuredClone(value); return }
      const temp = `${filename}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await rename(temp, filename)
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    },
  }
  cache.set(key, store)
  return store
}
