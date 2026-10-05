# Internationalization (i18n)

The DevWebUI web client is localized with [vue-i18n](https://vue-i18n.intlify.dev/)
(Composition API mode). **English is the source language**; every other locale is
translated from it.

## Layout

```
src/i18n/
├── index.ts            # the i18n instance + setLocale() helper
├── locales/
│   ├── index.ts        # LOCALES registry (codes + translation status)
│   ├── en.ts           # English - the base catalog (source of truth)
│   └── <code>.ts       # one file per added language
└── README.md           # this file
```

## Using strings in a component

```ts
import { useI18n } from "vue-i18n";
const { t } = useI18n({ useScope: "global" });
t("filters.title");                      // "Sort & filter"
t("header.notificationsCount", { count }); // "Notifications (3)"
```

For phrases that wrap markup (e.g. an emphasized number or a link), use the
`<i18n-t>` component with named slots instead of splitting the sentence - this
keeps word order translatable:

```vue
<i18n-t keypath="header.active" tag="span" scope="global">
  <template #running><strong>{{ running }}</strong></template>
  <template #total>{{ total }}</template>
</i18n-t>
```

## Adding a language (machine-draft → reviewed)

1. Add the code to the `LocaleCode` union and a row to `LOCALES` in
   [`locales/index.ts`](./locales/index.ts). For an un-reviewed auto-translation set
   `status: "machine-draft"` so the UI can show a "needs review" hint
   (`isMachineDraft(code)`).
2. Copy `en.ts` to `<code>.ts`, keep the **exact same key shape**, and translate the
   values. Leave every `{named}` placeholder untouched.
3. Register the file in [`index.ts`](./index.ts) (`messages: { en, <code> }`).
4. Once a human has proofread it, flip its `status` to `"reviewed"`.

### Machine-translation drafts

Auto-translated files are committed as ordinary `<code>.ts` catalogs with their
registry `status` set to `"machine-draft"`. That flag is the single switch the UI
reads to decide whether to warn that copy is unverified - there's no separate
"draft" file format to maintain. A reviewer translates nothing by hand; they read,
fix, and flip the status to `"reviewed"`.

## Scope of localization

Per project decision, i18n covers the **web UI only**. The daemon/CLI and log output
are left in English for now.
