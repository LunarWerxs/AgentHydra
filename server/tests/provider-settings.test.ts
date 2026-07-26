import { expect, test } from 'bun:test'
import { getProviderSettings, setProviderSettings } from '../src/provider-settings'

test('provider settings default on for installed surfaces and off for ChatGPT handoff', () => {
  expect(getProviderSettings()).toEqual({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    chatGptHandoffEnabled: false,
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
    chatGptHandoffEnabled: true,
  })

  setProviderSettings({
    codexDesktopEnabled: true,
    codexCliEnabled: true,
    chatGptHandoffEnabled: false,
  })
})
