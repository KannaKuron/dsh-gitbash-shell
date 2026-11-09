/**
 * dsh-gitbash-shell — ownership receipt for the global PTC SDK patch rows.
 *
 * WHY THIS EXISTS (review P0)
 * The lift path must never delete a row the USER wrote. Matching on the
 * controlled field alone is not enough: a user who hand-wrote
 * `tool-executor-native: { disabled: true }` before ever toggling this switch
 * has a row that is byte-identical to ours, and "remove only rows whose value
 * is ours" would silently delete their file (and their comments, if they had
 * added any).
 *
 * So the writer keeps a RECEIPT next to the patch recording exactly which row
 * ids it wrote and the canonical fingerprint of each written row. Lift deletes
 * a row only when BOTH hold:
 *   1. the receipt names that id, and
 *   2. the row as it stands today still fingerprints to the recorded value.
 *
 * No receipt (fresh profile, or a user who never toggled the switch) means
 * nothing is owned and nothing is deleted. A row the user edited afterwards
 * fingerprints differently and is left alone — the switch can never take back
 * a hand edit.
 *
 * The receipt lives beside the patch (`.gitbash-global-ptc-ownership.json`),
 * is written through the same atomic writer, and is never hand-edited.
 *
 * @module dsh-gitbash-shell/global-ptc-ownership
 */

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Receipt filename, resolved next to the profile patch it describes. */
export const OWNERSHIP_FILENAME = '.gitbash-global-ptc-ownership.json'

/** Row ids this switch may own. */
export const OWNED_ROWS = ['tool-executor-native', 'tool-executor-ptc']

/**
 * Canonical fingerprint of one written row.
 *
 * Key order is normalised (sorted, recursively) so a re-serialisation of the
 * SAME row never looks like a user edit, while any added/removed/changed key
 * does. YAML comments are included separately: `toJSON()` drops them, but a
 * comment is user content and must make the row ineligible for lifting too.
 *
 * @param {unknown} row - plain data (not a yaml node).
 * @param {string[]} [comments] - ordered comment tokens from the yaml node.
 * @returns {string} sha256 hex
 */
export function rowFingerprint(row, comments = []) {
  return createHash('sha256').update(stableStringify({ row, comments })).digest('hex')
}

/**
 * Fingerprint a yaml AST row, including every comment/commentBefore attached
 * to the row, its pairs, keys and values. Formatting-only re-serialisation is
 * ignored; adding, moving or editing a comment is not.
 * @param {unknown} node - a yaml AST node (plain data is accepted too).
 * @returns {string} sha256 hex
 */
export function yamlRowFingerprint(node) {
  let plain = node
  if (node && typeof node === 'object' && typeof node.toJSON === 'function') {
    try { plain = node.toJSON() } catch { plain = undefined }
  }
  return rowFingerprint(plain, collectYamlComments(node))
}

/** Collect comment tokens without walking yaml's cyclic internal metadata. */
function collectYamlComments(node) {
  const comments = []
  const seen = new WeakSet()
  const visit = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (typeof value.commentBefore === 'string') comments.push(`before:${value.commentBefore}`)
    if (typeof value.comment === 'string') comments.push(`after:${value.comment}`)
    if (Array.isArray(value.items)) for (const item of value.items) visit(item)
    visit(value.key)
    visit(value.value)
  }
  visit(node)
  return comments
}

/** Deterministic JSON with sorted object keys. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

/** An empty receipt: nothing owned. */
export function emptyReceipt() {
  return { version: 1, rows: {} }
}

/**
 * Validate a parsed receipt. A malformed receipt is a hard error: guessing
 * ownership from a corrupt file is exactly how a user's rows get deleted.
 * @param {unknown} value
 * @returns {{version: 1, rows: Record<string, string>}}
 */
export function validateReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('invalid global PTC ownership receipt; refusing to guess ownership')
  }
  if (!value.rows || typeof value.rows !== 'object' || Array.isArray(value.rows)) {
    throw new Error('invalid global PTC ownership receipt rows; refusing to guess ownership')
  }
  for (const [id, fingerprint] of Object.entries(value.rows)) {
    if (!OWNED_ROWS.includes(id)) throw new Error(`unexpected owned row ${id} in the global PTC receipt`)
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error(`malformed fingerprint for ${id} in the global PTC receipt`)
    }
  }
  return value
}

/**
 * Build the receipt store for one profile patch.
 *
 * Serialised per file: two toggles landing together must not interleave a read
 * with a write (the same reason the patch writer takes the profile lock).
 *
 * @param {{readFile: (file: string) => Promise<string>, writeFileAtomic: (file: string, data: string) => Promise<void>}} io
 * @param {string} patchPath - the profile patch this receipt describes.
 * @returns {{file: string, read: () => Promise<{version: 1, rows: Record<string, string>}>, write: (value: {version: 1, rows: Record<string, string>}) => Promise<void>, run: <T>(task: () => Promise<T>) => Promise<T>}}
 */
export function globalPtcOwnership(io, patchPath) {
  const file = join(dirname(patchPath), OWNERSHIP_FILENAME)
  let serial = Promise.resolve()
  return {
    file,
    run(task) {
      const result = serial.then(task)
      serial = result.catch(() => {})
      return result
    },
    async read() {
      try {
        return validateReceipt(JSON.parse(await io.readFile(file)))
      } catch (error) {
        if (error?.code === 'ENOENT') return emptyReceipt()
        throw error
      }
    },
    async write(value) {
      validateReceipt(value)
      await io.writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
    },
  }
}
