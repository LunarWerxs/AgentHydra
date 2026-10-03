import { expect, test } from 'bun:test'
import { getProviderSettings, setProviderSettings } from '../src/provider-settings'

test('provider settings default on for installed surfaces and off for ChatGPT handoff', () => {
  expect(getProviderSettings()).toEqual({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    dshEnabled: true,
    chatGptHandoffEnabled: false,
    // The keepalive spends quota, so its default is the only one that matters for safety: OFF,
    // with a floor that leaves an account alone once its weekly cap is 85% gone
    // (CliMayte's stop line, owner 2026-10-01).
    keepaliveEnabled: false,
    keepaliveWeeklyFloorPct: 85,
    // Paid extra usage spends money, so CliMayte may only use it once the owner turns this on.
    allowExtraUsage: false,
  })
})

test('provider settings round-trip independently', () => {
  expect(
    setProviderSettings({
      codexDesktopEnabled: false,
      codexCliEnabled: true,
      chatGptHandoffEnabled: true,
    }),
  ).toEqual({
    codexDesktopEnabled: false,
    codexCliEnabled: true,
    dshEnabled: true,
    chatGptHandoffEnabled: true,
    keepaliveEnabled: false,
    keepaliveWeeklyFloorPct: 85,
    allowExtraUsage: false,
  })

  setProviderSettings({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    chatGptHandoffEnabled: false,
  })
})

test('the keepalive floor is clamped, so a typo cannot turn a safety rail into permission', () => {
  // It is a percentage AND a guard. Anything unparseable or out of range has to land somewhere
  // safe rather than somewhere permissive.
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: 150 }).keepaliveWeeklyFloorPct).toBe(100)
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: -5 }).keepaliveWeeklyFloorPct).toBe(0)
  expect(setProviderSettings({ keepaliveWeeklyFloorPct: Number.NaN }).keepaliveWeeklyFloorPct).toBe(
    85,
  )
  setProviderSettings({ keepaliveWeeklyFloorPct: 85, keepaliveEnabled: false })
})
