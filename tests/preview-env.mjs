// Test-only evidence ownership. No production profile or installed Core writes.
// Operator-provided directories win; otherwise use unique host temporary scratch.
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const names = {
  DSH_NATIVE_OUTPUT_EVIDENCE_DIR: 'output',
  DSH_NATIVE_EVIDENCE_DIR: 'native',
  DSH_NATIVE_REVIEW_EVIDENCE_DIR: 'review',
  DSH_PATH_EVIDENCE_DIR: 'paths',
}
let scratch
for (const [name, child] of Object.entries(names)) {
  let directory = process.env[name]
  if (directory === undefined || directory === '') {
    scratch ??= mkdtempSync(join(tmpdir(), 'dsh-gitbash-preview-'))
    directory = join(scratch, child)
    mkdirSync(directory)
    process.env[name] = directory
  }
  if (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`${name} must select an existing absolute caller-owned evidence directory`)
  }
}
