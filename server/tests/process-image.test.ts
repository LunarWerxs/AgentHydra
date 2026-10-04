// server/tests/process-image.test.ts - the executable a running process was started from.
//
// The chat dossier tells a moved chat's two copies apart by the profile whose binary runs the
// engine. An image that cannot be read is "unknown", which quietly brings back the old
// mis-attribution, so what this pins is that a real process's image comes back whole.

import { describe, expect, test } from 'bun:test'
import { processImagePath } from '../src/core/process-image'

describe.skipIf(process.platform !== 'win32')('processImagePath', () => {
  test('names the executable a live process runs', () => {
    expect(processImagePath(process.pid)?.toLowerCase()).toBe(process.execPath.toLowerCase())
  })
})
