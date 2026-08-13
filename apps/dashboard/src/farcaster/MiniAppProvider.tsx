// Adapted from ael-dev3/Warpkeep at commit
// 96e49cdb60b2fc8483e63f9df58447e5acbc6b92 (Apache-2.0).
// Modified for SnapMeter; see THIRD_PARTY_NOTICES.md.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

import {
  DEFAULT_MINI_APP_BROWSER_RUNTIME,
  defaultMiniAppSdkLoader,
  hasExactMiniAppHint,
  installMiniAppSafeAreaVariables,
  readMiniAppSdk,
  sanitizeMiniAppContext,
  type MiniAppBrowserRuntime,
  type MiniAppSdk,
  type MiniAppSdkLoader
} from "./miniAppRuntime";

export type MiniAppHostState = "regular-web" | "detecting" | "miniapp";

export type MiniAppHostValue = Readonly<{
  state: MiniAppHostState;
  isMiniApp: boolean;
  /** This FID has been verified by SnapMeter's server, not copied from host context. */
  verifiedFid: number | null;
}>;

export type MiniAppProviderProps = Readonly<{
  children: ReactNode;
  sdkLoader?: MiniAppSdkLoader;
  runtime?: MiniAppBrowserRuntime;
  /** Test seam; production keeps host operations bounded to four seconds. */
  deadlineMilliseconds?: number;
}>;

const DEFAULT_HOST_DEADLINE_MILLISECONDS = 4_000;
const MAX_IDENTITY_RESPONSE_BYTES = 1_024;
const IDENTITY_PATH = "/api/v1/farcaster/me";

const REGULAR_WEB_VALUE: MiniAppHostValue = Object.freeze({
  state: "regular-web",
  isMiniApp: false,
  verifiedFid: null
});

const MiniAppHostContext = createContext<MiniAppHostValue>(REGULAR_WEB_VALUE);

class MiniAppDeadlineError extends Error {
  constructor() {
    super("Mini App host operation timed out.");
    this.name = "MiniAppDeadlineError";
  }
}

function normalizedDeadline(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.min(10_000, Math.max(50, Math.round(value!)))
    : DEFAULT_HOST_DEADLINE_MILLISECONDS;
}

function withDeadline<T>(operation: PromiseLike<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      callback();
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(new MiniAppDeadlineError()));
    }, milliseconds);
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

// React StrictMode replays effects. Sharing the SDK-bound attempt prevents a
// verified page mount from signaling readiness twice.
const READY_ATTEMPTS = new WeakMap<object, Promise<void>>();

function signalReadyOnce(sdk: MiniAppSdk, deadline: number): Promise<void> {
  const existing = READY_ATTEMPTS.get(sdk);
  if (existing) return existing;

  const actions = sdk.actions;
  const attempt = withDeadline(
    Promise.resolve().then(() => actions.ready.call(actions, {
      disableNativeGestures: true
    })),
    deadline
  );
  READY_ATTEMPTS.set(sdk, attempt);
  void attempt.catch(() => {
    if (READY_ATTEMPTS.get(sdk) === attempt) READY_ATTEMPTS.delete(sdk);
  });
  return attempt;
}

function positiveFid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

async function readVerifiedFid(response: Response): Promise<number | null> {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) return null;

  const advertisedLength = response.headers.get("content-length");
  if (
    advertisedLength !== null
    && (!/^\d+$/.test(advertisedLength)
      || Number(advertisedLength) > MAX_IDENTITY_RESPONSE_BYTES)
  ) {
    return null;
  }

  let source: string;
  try {
    source = await response.text();
  } catch {
    return null;
  }
  if (
    source.length === 0
    || new TextEncoder().encode(source).byteLength > MAX_IDENTITY_RESPONSE_BYTES
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.schemaVersion !== 1 || envelope.authenticated !== true) {
      return null;
    }
    return positiveFid(envelope.fid);
  } catch {
    return null;
  }
}

async function fetchVerifiedFid(
  sdk: MiniAppSdk,
  signal: AbortSignal
): Promise<number | null> {
  const quickAuth = sdk.quickAuth;
  if (!quickAuth || typeof quickAuth.fetch !== "function") return null;
  try {
    const response = await quickAuth.fetch.call(quickAuth, IDENTITY_PATH, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal
    });
    return await readVerifiedFid(response);
  } catch {
    return null;
  }
}

export function MiniAppProvider({
  children,
  sdkLoader = defaultMiniAppSdkLoader,
  runtime = DEFAULT_MINI_APP_BROWSER_RUNTIME,
  deadlineMilliseconds
}: MiniAppProviderProps): React.JSX.Element {
  const hinted = hasExactMiniAppHint(runtime.search());
  const deadline = normalizedDeadline(deadlineMilliseconds);
  const [value, setValue] = useState<MiniAppHostValue>(
    hinted
      ? Object.freeze({ state: "detecting", isMiniApp: false, verifiedFid: null })
      : REGULAR_WEB_VALUE
  );

  useEffect(() => {
    if (!hinted) {
      setValue(REGULAR_WEB_VALUE);
      return;
    }

    let cancelled = false;
    let removeSafeAreaVariables: (() => void) | undefined;
    const authController = new AbortController();
    setValue(Object.freeze({
      state: "detecting",
      isMiniApp: false,
      verifiedFid: null
    }));

    const recoverToWeb = () => {
      if (cancelled) return;
      removeSafeAreaVariables?.();
      removeSafeAreaVariables = undefined;
      setValue(REGULAR_WEB_VALUE);
    };

    void (async () => {
      let sdk: MiniAppSdk;
      try {
        const candidate = readMiniAppSdk(await withDeadline(sdkLoader(), deadline));
        if (!candidate) {
          recoverToWeb();
          return;
        }
        sdk = candidate;
        const isMiniApp = await withDeadline(sdk.isInMiniApp(), deadline);
        if (cancelled) return;
        if (isMiniApp !== true) {
          recoverToWeb();
          return;
        }

        const context = sanitizeMiniAppContext(
          await withDeadline(sdk.context, deadline),
          runtime.viewport()
        );
        if (cancelled) return;
        if (!context) {
          recoverToWeb();
          return;
        }
        removeSafeAreaVariables = installMiniAppSafeAreaVariables(
          runtime.document,
          context.safeAreaInsets
        );

        const shell = runtime.getMountedShell();
        if (!shell?.isConnected || shell.childNodes.length === 0) {
          recoverToWeb();
          return;
        }
        await withDeadline(runtime.waitForAnimationFrame(), deadline);
        await withDeadline(runtime.waitForAnimationFrame(), deadline);
        if (
          cancelled
          || runtime.getMountedShell() !== shell
          || !shell.isConnected
          || shell.childNodes.length === 0
        ) {
          if (!cancelled) recoverToWeb();
          return;
        }

        await signalReadyOnce(sdk, deadline);
        if (cancelled) return;
        setValue(Object.freeze({
          state: "miniapp",
          isMiniApp: true,
          verifiedFid: null
        }));

        // Authentication enriches the already-visible dashboard; it never
        // gates metrics or trusts the presentation-only host FID above.
        void fetchVerifiedFid(sdk, authController.signal).then((verifiedFid) => {
          if (cancelled || verifiedFid === null) return;
          setValue(Object.freeze({
            state: "miniapp",
            isMiniApp: true,
            verifiedFid
          }));
        });
      } catch {
        recoverToWeb();
      }
    })();

    return () => {
      cancelled = true;
      authController.abort();
      removeSafeAreaVariables?.();
    };
  }, [deadline, hinted, runtime, sdkLoader]);

  const contextValue = useMemo(() => value, [value]);
  return (
    <MiniAppHostContext.Provider value={contextValue}>
      {children}
    </MiniAppHostContext.Provider>
  );
}

export function useMiniAppHost(): MiniAppHostValue {
  return useContext(MiniAppHostContext);
}
