<script setup lang="ts">
// Carry CLI logins between the owner's PCs (server/src/core/cli-login-move.ts; owner, 2026-10-01).
// Out: pick the logins, keep the passphrase made here, and the server writes one encrypted file to
// Downloads. This PC stays signed in unless "Also sign this PC out" is ticked (owner, the same day:
// "I sometimes need both to stay logged in"). In: choose that file on the other PC and type the
// passphrase. The passphrase is made in this page and sent once; the server never sends it back,
// so it is shown here until the dialog closes.
import { ArrowRightLeft, Check, Copy, FileDown, RefreshCw, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import InstanceNumber from '@/components/InstanceNumber.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  type CliInstance,
  type CliLoginMoveResult,
  moveCliLoginsIn,
  moveCliLoginsOut,
} from '@/lib/api'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{
  mode: 'out' | 'in'
  instances: CliInstance[]
  /** Out: the logins ticked when it opens (the row it was opened from). */
  preselect: string[]
}>()
const emit = defineEmits<{ done: [] }>()

const { t } = useI18n()

/** The server's MIN_PASSPHRASE. */
const MIN = 12
/** 32 letters and digits with the look-alikes (0/O, 1/I) left out: 24 of them is 120 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function makePassphrase(): string {
  const chars = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => ALPHABET[b % 32])
  return [0, 4, 8, 12, 16, 20].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

const passphrase = ref('')
/** Out: sign this PC out of the logins too (a move). Off by default: a copy keeps both signed in. */
const signOut = ref(false)
const picked = ref<Set<string>>(new Set())
const working = ref(false)
const result = ref<CliLoginMoveResult | null>(null)
const bundle = ref<unknown>(null)
const bundleInfo = ref<{
  from: string
  createdAt: string
  logins: Array<{ num: number | null; name: string; plan: string | null }>
} | null>(null)
const fileError = ref<string | null>(null)

/** The logins that can go: signed in here. One with a session running is listed, not pickable. */
const movable = computed(() => props.instances.filter((i) => i.loggedIn))
const busy = (i: CliInstance) => (i.liveSessions ?? 0) > 0

watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    result.value = null
    bundle.value = null
    bundleInfo.value = null
    fileError.value = null
    passphrase.value = props.mode === 'out' ? makePassphrase() : ''
    signOut.value = false
    picked.value = new Set(
      props.preselect.filter((id) => movable.value.some((i) => i.id === id && !busy(i))),
    )
  },
  { immediate: true },
)

function toggle(id: string) {
  const next = new Set(picked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picked.value = next
}

// The toast waits for the write: `navigator.clipboard` is undefined outside a secure context, and a
// "copied" over an empty clipboard is worse than none (CopyResetDate.vue).
async function copy(text: string, done: string) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard in this context')
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error(t('cliInstances.copyFailed'))
  }
}

async function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  bundle.value = null
  bundleInfo.value = null
  fileError.value = null
  result.value = null
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    if (parsed?.format !== 'agenthydra-cli-logins' || !Array.isArray(parsed.logins))
      throw new Error('not a bundle')
    bundle.value = parsed
    bundleInfo.value = {
      from: String(parsed.from ?? '?'),
      createdAt: String(parsed.createdAt ?? ''),
      logins: parsed.logins,
    }
  } catch {
    fileError.value = t('cliInstances.moveInBadFile')
  }
}

const done = computed(() => !!result.value?.ok)
const canSubmit = computed(
  () =>
    !working.value &&
    !done.value &&
    passphrase.value.length >= MIN &&
    (props.mode === 'out' ? picked.value.size > 0 : !!bundle.value),
)

async function submit() {
  if (!canSubmit.value) return
  working.value = true
  try {
    const r =
      props.mode === 'out'
        ? await moveCliLoginsOut([...picked.value], passphrase.value, signOut.value)
        : await moveCliLoginsIn(bundle.value, passphrase.value)
    result.value = r
    if (r.ok) toast.success(r.message)
    else toast.error(r.message)
    emit('done')
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('cliInstances.moveFailed'))
  } finally {
    working.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <component :is="mode === 'out' ? ArrowRightLeft : FileDown" class="size-4" />
          {{ mode === 'out' ? $t('cliInstances.moveOutTitle') : $t('cliInstances.moveInTitle') }}
        </DialogTitle>
        <DialogDescription>
          {{ mode === 'out' ? $t('cliInstances.moveOutBody') : $t('cliInstances.moveInBody') }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3 text-sm">
        <!-- Out: which logins go. -->
        <template v-if="mode === 'out'">
          <p v-if="movable.length === 0" class="text-muted-foreground">
            {{ $t('cliInstances.moveOutNone') }}
          </p>
          <fieldset v-else class="flex flex-col gap-1">
            <legend class="mb-1 text-xs font-medium text-muted-foreground">
              {{ $t('cliInstances.moveOutPick') }}
            </legend>
            <div class="flex max-h-48 flex-col gap-1 overflow-y-auto pe-1">
              <label
                v-for="inst in movable"
                :key="inst.id"
                class="flex items-center gap-2 rounded-md px-1 py-0.5"
                :class="busy(inst) || done ? 'opacity-50' : 'cursor-pointer hover:bg-muted/50'"
              >
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  :checked="picked.has(inst.id)"
                  :disabled="busy(inst) || done || working"
                  @change="toggle(inst.id)"
                />
                <InstanceNumber :num="inst.num" />
                <span class="truncate">{{ inst.name }}</span>
                <span v-if="busy(inst)" class="ms-auto shrink-0 text-xs text-muted-foreground">
                  {{ $t('cliInstances.moveOutBusy') }}
                </span>
              </label>
            </div>
          </fieldset>
        </template>

        <!-- In: the file, and what it says is inside before the passphrase opens it. -->
        <template v-else>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-muted-foreground">{{ $t('cliInstances.moveInFile') }}</span>
            <input
              type="file"
              accept=".ahlogins,application/json"
              class="text-xs file:me-2 file:rounded-md file:border file:border-input file:bg-background file:px-2 file:py-1 file:text-xs"
              :disabled="working || done"
              @change="onFile"
            />
          </label>
          <p v-if="fileError" class="text-xs text-destructive">{{ fileError }}</p>
          <div v-if="bundleInfo" class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">
              {{
                $t('cliInstances.moveInFrom', {
                  from: bundleInfo.from,
                  date: bundleInfo.createdAt ? new Date(bundleInfo.createdAt).toLocaleString() : '?',
                })
              }}
            </span>
            <span v-for="(l, i) in bundleInfo.logins" :key="i" class="flex items-center gap-2">
              <InstanceNumber :num="l.num ?? 0" />
              <span class="truncate">{{ l.name }}</span>
            </span>
          </div>
        </template>

        <!-- The passphrase: made here for a move out, typed in for an import. -->
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted-foreground">{{ $t('cliInstances.passphraseLabel') }}</span>
          <div class="flex items-center gap-1">
            <Input
              v-model="passphrase"
              class="mono"
              autocomplete="off"
              spellcheck="false"
              :readonly="working || done"
            />
            <template v-if="mode === 'out'">
              <Button
                variant="outline"
                size="icon"
                :aria-label="$t('cliInstances.passphraseCopy')"
                :title="$t('cliInstances.passphraseCopy')"
                @click="copy(passphrase, $t('cliInstances.passphraseCopied'))"
              >
                <Copy />
              </Button>
              <Button
                variant="outline"
                size="icon"
                :disabled="working || done"
                :aria-label="$t('cliInstances.passphraseNew')"
                :title="$t('cliInstances.passphraseNew')"
                @click="passphrase = makePassphrase()"
              >
                <RefreshCw />
              </Button>
            </template>
          </div>
          <span class="text-xs text-muted-foreground">
            {{
              passphrase.length > 0 && passphrase.length < MIN
                ? $t('cliInstances.passphraseShort', { min: MIN })
                : mode === 'out'
                  ? $t('cliInstances.passphraseHint')
                  : ''
            }}
          </span>
        </label>

        <label v-if="mode === 'out'" class="flex cursor-pointer items-center gap-2 text-xs">
          <input
            v-model="signOut"
            type="checkbox"
            class="size-4 accent-primary"
            :disabled="working || done"
          />
          {{ $t('cliInstances.moveSignOut') }}
        </label>

        <!-- What happened, login by login. -->
        <div v-if="result" class="flex flex-col gap-1 rounded-md border p-2 text-xs">
          <div v-if="result.file" class="flex items-center gap-1">
            <span class="mono truncate" :title="result.file">{{ result.file }}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="$t('cliInstances.moveFileCopy')"
              :title="$t('cliInstances.moveFileCopy')"
              @click="copy(result.file, $t('cliInstances.moveFileCopied'))"
            >
              <Copy />
            </Button>
          </div>
          <span v-for="row in result.rows" :key="row.id" class="flex items-start gap-1.5">
            <component
              :is="row.ok ? Check : X"
              class="mt-0.5 size-3.5 shrink-0"
              :class="row.ok ? 'text-success' : 'text-destructive'"
            />
            <InstanceNumber :num="row.num ?? 0" />
            <span>{{ row.message }}</span>
          </span>
          <span v-if="!result.rows.length">{{ result.message }}</span>
        </div>
      </div>

      <DialogFooter class="mt-2">
        <Button variant="ghost" :disabled="working" @click="open = false">
          {{ result ? $t('cliInstances.moveClose') : $t('cliInstances.moveCancel') }}
        </Button>
        <Button v-if="!done" :disabled="!canSubmit" @click="submit">
          <component
            :is="mode === 'out' ? ArrowRightLeft : FileDown"
            :class="working ? 'animate-pulse' : ''"
          />
          {{
            working
              ? mode === 'out'
                ? $t('cliInstances.moveOutWorking')
                : $t('cliInstances.moveInWorking')
              : mode === 'out'
                ? $t('cliInstances.moveOutSubmit', picked.size)
                : $t('cliInstances.moveInSubmit')
          }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
