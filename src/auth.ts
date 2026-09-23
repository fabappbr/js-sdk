import type { Requester } from "./http.js";
import type { TokenStorage } from "./storage.js";
import type { AppUser, Row } from "./types.js";

/** Called whenever the signed-in user changes — a login, a logout, a profile edit. */
export type AuthListener = (user: AppUser | null) => void;

export type SignupInput = {
  email: string;
  name?: string;
  password: string;
  passwordConfirmation?: string;
  /** Extra fields written to the user profile at signup (avatar, phone, anything the schema declares). */
  profile?: Row;
};

/**
 * Every auth operation, as plain functions.
 *
 * These used to exist only inside the React `useAuth` hook, which meant a script, a server route or a non-React
 * frontend had no way to sign anyone in. The hook now wraps this object instead of owning the calls, so both
 * surfaces stay one implementation.
 */
export type Auth = {
  /** The last user this client saw. It does NOT fetch — call `me()` to ask the server. */
  readonly user: AppUser | null;
  /** Whether a token is held at all. Cheap and synchronous; it does not prove the token is still valid. */
  hasToken(): boolean;
  /** Subscribe to user changes. Returns the unsubscribe function. */
  subscribe(listener: AuthListener): () => void;

  me(): Promise<AppUser>;
  login(email: string, password: string): Promise<AppUser>;
  signup(input: SignupInput): Promise<AppUser>;
  /** Ends the session on the server and clears the client. `everywhere` drops all of that person's devices. */
  logout(everywhere?: boolean): void;

  updateProfile(patch: { name?: string; [k: string]: unknown }): Promise<AppUser>;
  changePassword(newPassword: string, current?: string): Promise<AppUser>;
  forgotPassword(email: string, resetUrl?: string): Promise<void>;
  resetPassword(token: string, password: string, confirm?: string): Promise<AppUser>;
  verifyEmail(token: string): Promise<AppUser>;
  resendVerification(verifyUrl?: string): Promise<void>;
  acceptInvite(token: string, name: string, password: string): Promise<AppUser>;

  /**
   * Sign-in by a 6-digit code sent to the EMAIL — no password. Only works when the app owner turned it on
   * (`publicConfig().emailCodeLogin`). `sendEmailCode` always resolves the same way whether or not the address has an
   * account; with sign-up closed, only existing accounts actually receive a code.
   */
  sendEmailCode(email: string): Promise<void>;
  loginWithEmailCode(email: string, code: string): Promise<AppUser>;

  /** SMS sign-in and recovery. Only works when the app owner has connected an SMS provider. */
  sendPhoneCode(phone: string, purpose?: "login" | "reset"): Promise<void>;
  loginWithPhone(phone: string, code: string): Promise<AppUser>;
  resetPasswordSms(phone: string, code: string, newPassword: string): Promise<AppUser>;
  linkPhone(phone: string): Promise<void>;
  verifyPhoneLink(phone: string, code: string): Promise<AppUser>;

  /** The provider consent URL. Send the browser there; the provider returns to `redirectUri`. */
  oauthStartUrl(provider: string, redirectUri?: string): string;
  /**
   * Reads a token the provider left in the URL fragment, stores it and loads the user. Returns null when there is no
   * session to establish. Browser only.
   */
  completeOAuth(): Promise<AppUser | null>;

  /** Adopt a token obtained elsewhere — a server handoff, a test fixture, a service token. */
  setToken(token: string | undefined): void;
  getToken(): string | undefined;
};

/** Strips the token out of the address bar without adding a history entry. */
function scrubUrl(): void {
  window.history.replaceState({}, "", window.location.pathname + window.location.search);
}

/** Reads a `key` out of the URL fragment. The fragment is never sent to a server, so it stays out of logs. */
function fromFragment(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    return new URLSearchParams(hash).get(key);
  } catch {
    return null;
  }
}

export function createAuth(req: Requester, storage: TokenStorage): Auth {
  let current: AppUser | null = null;
  const listeners = new Set<AuthListener>();

  const emit = (user: AppUser | null): AppUser | null => {
    current = user;
    for (const listener of listeners) {
      // One bad subscriber must not stop the others, and must not make `logout()` throw. A screen that crashes
      // inside its own listener would otherwise leave every other screen holding the previous user.
      try { listener(user); } catch { /* the subscriber's problem, not the session's */ }
    }
    return user;
  };

  /** Every endpoint that both authenticates and returns a session behaves the same: store, then load the user. */
  const enter = async (path: string, body: unknown): Promise<AppUser> => {
    const { access_token, refresh_token } =
      await req<{ access_token: string; refresh_token?: string }>("POST", path, body);
    storage.set(access_token);
    // Absent in the flows that come back through a redirect (OAuth/SSO): there the refresh would sit in the URL,
    // in the history and in the Referer. Those keep the session token, which is revocable on the server.
    storage.setRefresh?.(refresh_token);
    return emit(await req<AppUser>("GET", "/auth/me")) as AppUser;
  };

  const auth: Auth = {
    get user() { return current; },
    hasToken: () => !!storage.get(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    me: async () => emit(await req<AppUser>("GET", "/auth/me")) as AppUser,
    login: (email, password) => enter("/auth/login", { email, password }),
    signup: (input) => enter("/auth/signup", {
      email: input.email,
      name: input.name,
      password: input.password,
      password_confirmation: input.passwordConfirmation,
      profile: input.profile,
    }),
    /**
     * Ends the session ON THE SERVER, and not only on the client.
     *
     * ⚠️ IT USED TO BE JUST DELETING THE TOKEN: it stayed valid until it expired, so whoever held a copy (a
     * shared computer, a log) was still inside the app after the click on "sign out". The local state is
     * cleared FIRST and the server is told without waiting — signing out cannot depend on the network.
     *
     * `everywhere` drops all of that person's sessions, not only this one.
     */
    logout(everywhere = false) {
      const refresh = storage.getRefresh?.();
      const hadToken = !!storage.get();
      storage.set(undefined);
      storage.setRefresh?.(undefined);
      emit(null);
      if (hadToken) {
        void req("POST", "/auth/logout", everywhere ? { everywhere: true } : { refresh_token: refresh })
          .catch(() => { /* signing out is local; the network cannot prevent it */ });
      }
    },

    async updateProfile(patch) {
      const { name, ...profile } = patch;
      return emit(await req<AppUser>("PATCH", "/auth/me", { name, profile })) as AppUser;
    },
    async changePassword(newPassword, current_password) {
      await req<{ ok: boolean }>("POST", "/auth/change-password", { new_password: newPassword, current_password });
      return emit(await req<AppUser>("GET", "/auth/me")) as AppUser;
    },
    forgotPassword: (email, resetUrl) => req<void>("POST", "/auth/forgot-password", { email, reset_url: resetUrl }),
    resetPassword: (token, password, confirm) =>
      enter("/auth/reset-password", { token, password, password_confirmation: confirm }),
    verifyEmail: async (token) => emit(await req<AppUser>("POST", "/auth/verify-email", { token })) as AppUser,
    resendVerification: (verifyUrl) => req<void>("POST", "/auth/resend-verification", { verify_url: verifyUrl }),
    acceptInvite: (token, name, password) => enter("/auth/accept-invite", { token, name, password }),

    sendEmailCode: (email) => req<void>("POST", "/auth/email/send-code", { email }),
    loginWithEmailCode: (email, code) => enter("/auth/email/verify", { email, code }),

    sendPhoneCode: (phone, purpose = "login") => req<void>("POST", "/auth/phone/send-code", { phone, purpose }),
    loginWithPhone: (phone, code) => enter("/auth/phone/verify", { phone, code, purpose: "login" }),
    resetPasswordSms: (phone, code, newPassword) =>
      enter("/auth/phone/reset", { phone, code, new_password: newPassword }),
    linkPhone: (phone) => req<void>("POST", "/auth/phone/link", { phone }),
    verifyPhoneLink: async (phone, code) =>
      emit(await req<AppUser>("POST", "/auth/phone/link/verify", { phone, code })) as AppUser,

    oauthStartUrl(provider, redirectUri) {
      const back = redirectUri ?? (typeof window !== "undefined"
        ? window.location.origin + window.location.pathname
        : "");
      return req.url(`/auth/oauth/${encodeURIComponent(provider)}/start?redirect=${encodeURIComponent(back)}`);
    },
    async completeOAuth() {
      const token = fromFragment("fab_oauth_token");
      if (token) {
        storage.set(token);
        try { scrubUrl(); } catch { /* a locked-down history is not a reason to lose the session */ }
      }
      // Answer with "the session that exists now", not "I found a token": the token may have been consumed at boot
      // by an earlier call, and `if (await completeOAuth()) navigate("/")` must still redirect after a login that
      // did succeed.
      if (!storage.get()) return null;
      return emit(await req<AppUser>("GET", "/auth/me").catch(() => null));
    },

    setToken(token) {
      storage.set(token);
      if (!token) emit(null);
    },
    getToken: () => storage.get(),
  };
  return auth;
}
