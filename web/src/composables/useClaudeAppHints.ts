// --- what only the running Claude app serves (server/src/claude-app-usage.ts) --------------------
// Each is read from the app and kept, dated, while it is closed; the row carries an icon only for
// what is worth a glance (a banked reset, credit money, billing past the plan limits) and the usage
// chip's popover carries the rest.

import { useI18n } from 'vue-i18n'
import type { CMInstance, UsageSnapshot } from '@/lib/api'
import { flaggedCodeCredit, formatMoney, shortDate, usageCheckedAgo } from '@/lib/usage'

export function useClaudeAppHints(usageFor: (inst: CMInstance) => UsageSnapshot | undefined) {
  const { t } = useI18n()

  function appCheckedAgo(inst: CMInstance): string {
    const at = usageFor(inst)?.claudeApp?.checkedAt
    return at ? usageCheckedAgo(at) : '—'
  }

  function resetBankedHint(inst: CMInstance): string {
    const expires = shortDate(usageFor(inst)?.resetCreditsExpiresAt)
    return t('instances.resetBankedHint', { expires, checked: appCheckedAgo(inst) })
  }

  const codeCreditFor = (inst: CMInstance) => flaggedCodeCredit(usageFor(inst))

  function codeCreditLabel(inst: CMInstance): string {
    const credit = codeCreditFor(inst)
    if (credit?.state === 'unclaimed') return t('instances.codeCreditUnclaimed')
    if (credit?.state === 'locked') return t('instances.codeCreditLocked')
    return t('instances.codeCredit', {
      remaining: formatMoney(credit?.remainingUsd),
      limit: formatMoney(credit?.limitUsd),
    })
  }

  function codeCreditHint(inst: CMInstance): string {
    const credit = codeCreditFor(inst)
    const at = { expires: shortDate(credit?.expiresAt), checked: appCheckedAgo(inst) }
    if (credit?.state === 'unclaimed') return t('instances.codeCreditUnclaimedHint', at)
    if (credit?.state === 'locked')
      return t('instances.codeCreditLockedHint', { ...at, reason: credit.lockedReason ?? '—' })
    return t('instances.codeCreditHint', at)
  }

  /** Usage credits worth an icon: only when ON, because then the account bills past its limits. */
  const usageCreditsOnFor = (inst: CMInstance) => {
    const credits = usageFor(inst)?.claudeApp?.usageCredits
    return credits?.enabled ? credits : null
  }

  function usageCreditsHint(inst: CMInstance): string {
    const credits = usageCreditsOnFor(inst)
    if (!credits) return t('instances.extraUsageOnHint')
    const used = formatMoney(credits?.used, credits?.currency ?? null)
    const checked = appCheckedAgo(inst)
    return credits?.limit == null
      ? t('instances.usageCreditsOnHintUncapped', { used, checked })
      : t('instances.usageCreditsOnHint', {
          used,
          limit: formatMoney(credits.limit, credits.currency),
          checked,
        })
  }

  return {
    resetBankedHint,
    codeCreditFor,
    codeCreditLabel,
    codeCreditHint,
    usageCreditsHint,
  }
}
