import type { Requester } from "./http.js";

/** The project's PUBLIC config — no credential in it, which is why an anonymous visitor may read it. */
export type PublicConfig = {
  vapidPublicKey?: string | null;
  phoneLogin?: boolean;
  /** Sign-in by a code sent to the email is on for this app. */
  emailCodeLogin?: boolean;
  payments?: { provider?: string; publishableKey?: string };
  [k: string]: unknown;
};

export type Push = {
  /** Web Push support in this browser. On iOS the app must be installed to the home screen first. */
  supported(): boolean;
  /** Asks permission, subscribes the service worker and registers the subscription. False means it did not enable. */
  enable(): Promise<boolean>;
  disable(): Promise<void>;
  /** Whether this device already holds a subscription. Resolves immediately when push was never enabled. */
  isEnabled(): Promise<boolean>;
  /**
   * Registers a NATIVE device token instead of a Web Push subscription. The transport is not cosmetic: iOS delivers
   * through Expo's service, Android goes straight to Firebase with the app owner's own service account, and `appId`
   * says whose Firebase — which only Android needs.
   */
  subscribeNative(token: string, kind?: "expo" | "fcm", appId?: string): Promise<void>;
};

function base64UrlToBuffer(value: string): ArrayBuffer {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

export function createPush(req: Requester, publicConfig: () => Promise<PublicConfig>): Push {
  const supported = () =>
    typeof navigator !== "undefined" && "serviceWorker" in navigator
    && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;

  return {
    supported,

    async enable() {
      if (!supported()) return false;
      // `publicConfig` now propagates a network failure instead of caching an empty answer forever, and "could not
      // ask" is the same outcome here as "there is no key": push is not available right now. The caller sees false
      // and can offer the button again later, which is exactly what it could not do before.
      const key = await publicConfig().then((c) => c.vapidPublicKey).catch(() => null);
      if (!key) return false;
      if ((await Notification.requestPermission()) !== "granted") return false;
      await navigator.serviceWorker.register("/sw.js").catch(() => {});   // idempotent, registered on demand
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription())
        || (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBuffer(String(key)),
        }));
      await req("POST", "/api/_push/subscribe", { ...subscription.toJSON(), ua: navigator.userAgent });
      return true;
    },

    async disable() {
      if (!supported()) return;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) return;
      // Server first. The other order leaves an orphaned row holding keys the browser has already invalidated.
      await req("POST", "/api/_push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    },

    async isEnabled() {
      if (!supported()) return false;
      // `getRegistration`, not `ready`: it resolves at once with undefined when no service worker was ever
      // registered, instead of hanging forever in an app that does not use push.
      const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      return !!(await registration?.pushManager.getSubscription().catch(() => null));
    },

    async subscribeNative(token, kind = "expo", appId) {
      await req("POST", "/api/_push/subscribe", {
        kind, token, app_id: appId, ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
      });
    },
  };
}
