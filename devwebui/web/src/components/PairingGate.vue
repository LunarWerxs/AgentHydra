<script setup lang="ts">
// Shown INSTEAD of the app when the daemon enforces local auth (DEVWEBUI_REQUIRE_AUTH=1) and this
// browser holds no paired key yet. The browser cannot read the daemon's cookie file, so it asks
// for a pairing request and the owner copies the 6-digit code from a trusted channel (the daemon
// console or `devwebui pairing codes`). A correct code returns this browser's key, which api.ts
// keeps in localStorage; reloading then mounts the real app with every request sending it.
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { requestPairing, verifyPairing } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const { t } = useI18n({ useScope: "global" });

const requestId = ref<string | null>(null);
const code = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const start = () =>
  run(async () => {
    const label = `${navigator.platform || "browser"} - ${new Date().toLocaleString()}`;
    requestId.value = (await requestPairing(label)).requestId;
    code.value = "";
  });

const verify = () =>
  run(async () => {
    if (!requestId.value) return;
    await verifyPairing(requestId.value, code.value.trim());
    window.location.reload();
  });
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center p-4">
    <Card class="w-full max-w-105">
      <CardHeader>
        <CardTitle>{{ t("pairing.title") }}</CardTitle>
        <CardDescription>{{ t("pairing.body") }}</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-col gap-3">
          <Button v-if="!requestId" :disabled="busy" @click="start">{{ t("pairing.request") }}</Button>
          <form v-else class="flex flex-col gap-3" @submit.prevent="verify">
            <p class="text-sm text-muted-foreground" v-html="t('pairing.whereIsCode')" />
            <Input
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              :placeholder="t('pairing.codePlaceholder')"
              :aria-label="t('pairing.codePlaceholder')"
            />
            <div class="flex gap-2">
              <Button type="submit" :disabled="busy || code.trim().length !== 6">{{ t("pairing.verify") }}</Button>
              <Button type="button" variant="outline" :disabled="busy" @click="start">
                {{ t("pairing.newCode") }}
              </Button>
            </div>
          </form>
          <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
