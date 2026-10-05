import { toast } from "vue-sonner";
import { useI18n } from "vue-i18n";

/**
 * try/catch/toast wrapper for fire-and-forget async actions. Call this in a
 * component's setup with the i18n fallback-message key for that component,
 * then invoke the returned function around an API call.
 */
export function useRunAction(fallbackKey: string) {
  const { t } = useI18n({ useScope: "global" });

  return async function runAction(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(fallbackKey));
    }
  };
}
