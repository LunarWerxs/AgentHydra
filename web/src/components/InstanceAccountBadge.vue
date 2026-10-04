<script setup lang="ts">
// The account cell's pill, one owner for every provider's rows (Claude, Codex, DeepSeek). It shows
// the EMAIL HANDLE, the same rule on every row so the column compares down the table; the full
// address (and the profile name, when it is not just the handle again) is the hover, and a click
// copies the full address. With no address it shows `fallback` ("(not logged in)") as a plain
// badge, because a button that copies nothing is worse than text; with neither, a dash.
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Badge, type BadgeVariants } from '@/components/ui/badge'
import { pii, piiName } from '@/composables/usePrivacy'

const props = defineProps<{
  email: string | null | undefined
  profile?: string | null
  fallback?: string | null
  variant?: BadgeVariants['variant']
}>()
const { t } = useI18n()

const address = () => props.email?.trim() || null
const handle = () => address()?.split('@')[0]?.trim() || null
// The handle has no '@', so pii() would pass it through; mask it as a name instead.
const shownHandle = () => {
  const h = handle()
  return h ? piiName(h) : h
}

function title(): string | undefined {
  const email = pii(address())
  if (!email) return undefined
  const profile = props.profile?.trim()
  const head =
    profile && profile !== handle()
      ? t('instances.accountTitleWithProfile', { email, profile: piiName(profile) })
      : email
  return `${head}\n${t('instances.accountCopyHint')}`
}

function copy() {
  const email = address()
  if (!email) return
  navigator.clipboard?.writeText(email).catch(() => {})
  toast.success(t('instances.toastEmailCopied', { email: pii(email) }))
}
</script>

<template>
  <Badge
    v-if="handle() || fallback"
    :as="address() ? 'button' : undefined"
    :type="address() ? 'button' : undefined"
    :variant="variant ?? 'ghost'"
    :title="title()"
    :aria-label="address() ? $t('instances.copyAccountEmailAria', { email: $pii(address()) }) : undefined"
    :interactive="!!address()"
    @click="copy"
  >
    {{ shownHandle() ?? fallback }}
  </Badge>
  <span v-else class="text-xs text-muted-foreground">—</span>
</template>
