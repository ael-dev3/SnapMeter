export type MiniAppSafeAreaInsets = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

/** Host identity is presentation-only; server-verified identity is separate. */
export type MiniAppPresentationContext = Readonly<{
  fid: number;
  clientFid: number;
  safeAreaInsets: MiniAppSafeAreaInsets;
}>;

export type MiniAppSdk = Readonly<{
  isInMiniApp: () => Promise<boolean>;
  context: Promise<unknown>;
  actions: Readonly<{
    ready: (options: { disableNativeGestures: true }) => Promise<void>;
  }>;
  quickAuth?: Readonly<{
    fetch: typeof fetch;
  }>;
}>;

export type MiniAppSdkLoader = () => Promise<unknown>;

type MiniAppHost = Readonly<{
  context: Promise<unknown>;
  ready: (options: { disableNativeGestures: true }) => Promise<void>;
  signIn: (options: { nonce: string; acceptAuthAddress: true }) => Promise<unknown>;
}>;

type QuickAuthLightClient = Readonly<{
  generateNonce: () => Promise<{ nonce: string }>;
  verifySiwf: (options: {
    domain: string;
    message: string;
    signature: string;
  }) => Promise<{ token: string }>;
}>;

export type MiniAppBrowserRuntime = Readonly<{
  search: () => string;
  viewport: () => Readonly<{ width: number; height: number }>;
  document: Document;
  getMountedShell: () => Element | null;
  waitForAnimationFrame: () => Promise<void>;
}>;

const SAFE_AREA_PROPERTIES = [
  "--fc-safe-area-inset-top",
  "--fc-safe-area-inset-right",
  "--fc-safe-area-inset-bottom",
  "--fc-safe-area-inset-left"
] as const;
const FRAME_FALLBACK_MILLISECONDS = 160;
const MINI_APP_DETECTION_MILLISECONDS = 1_000;
const TOKEN_REFRESH_SKEW_SECONDS = 15;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function positiveAxis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function clampInset(value: unknown, axis: number): number {
  const untrusted = typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
  const maximum = Math.min(160, positiveAxis(axis) * 0.25);
  return Math.round(Math.min(maximum, Math.max(0, untrusted)) * 1_000) / 1_000;
}

/** Accept exactly one literal query entry; encoded or duplicate hints are inert. */
export function hasExactMiniAppHint(search: string): boolean {
  if (typeof search !== "string" || !search.startsWith("?")) return false;
  const matches = search
    .slice(1)
    .split("&")
    .filter((segment) => segment === "miniApp=true");
  if (matches.length !== 1) return false;
  const values = new URLSearchParams(search).getAll("miniApp");
  return values.length === 1 && values[0] === "true";
}

export function readMiniAppSdk(value: unknown): MiniAppSdk | null {
  if (!isRecord(value) || !isRecord(value.actions)) return null;
  if (
    typeof value.isInMiniApp !== "function"
    || typeof value.actions.ready !== "function"
  ) {
    return null;
  }
  return value as unknown as MiniAppSdk;
}

export function sanitizeMiniAppContext(
  value: unknown,
  viewport: Readonly<{ width: number; height: number }>
): MiniAppPresentationContext | null {
  try {
    if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.client)) {
      return null;
    }
    const fid = positiveFid(value.user.fid);
    const clientFid = positiveFid(value.client.clientFid);
    if (fid === null || clientFid === null) return null;

    const rawInsets = isRecord(value.client.safeAreaInsets)
      ? value.client.safeAreaInsets
      : {};
    return Object.freeze({
      fid,
      clientFid,
      safeAreaInsets: Object.freeze({
        top: clampInset(rawInsets.top, viewport.height),
        right: clampInset(rawInsets.right, viewport.width),
        bottom: clampInset(rawInsets.bottom, viewport.height),
        left: clampInset(rawInsets.left, viewport.width)
      })
    });
  } catch {
    return null;
  }
}

export function installMiniAppSafeAreaVariables(
  document: Document,
  insets: MiniAppSafeAreaInsets
): () => void {
  const root = document.documentElement;
  const previous = SAFE_AREA_PROPERTIES.map((property) => ({
    property,
    value: root.style.getPropertyValue(property),
    priority: root.style.getPropertyPriority(property)
  }));
  root.style.setProperty(SAFE_AREA_PROPERTIES[0], `${insets.top}px`);
  root.style.setProperty(SAFE_AREA_PROPERTIES[1], `${insets.right}px`);
  root.style.setProperty(SAFE_AREA_PROPERTIES[2], `${insets.bottom}px`);
  root.style.setProperty(SAFE_AREA_PROPERTIES[3], `${insets.left}px`);
  return () => {
    for (const value of previous) {
      if (value.value) root.style.setProperty(value.property, value.value, value.priority);
      else root.style.removeProperty(value.property);
    }
  };
}

function defaultViewport(): Readonly<{ width: number; height: number }> {
  const root = document.documentElement;
  return Object.freeze({
    width: positiveAxis(window.innerWidth) || positiveAxis(root.clientWidth),
    height: positiveAxis(window.innerHeight) || positiveAxis(root.clientHeight)
  });
}

function waitForBoundedAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let frame = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      resolve();
    };
    const timeout = window.setTimeout(finish, FRAME_FALLBACK_MILLISECONDS);
    frame = window.requestAnimationFrame(finish);
  });
}

export const DEFAULT_MINI_APP_BROWSER_RUNTIME: MiniAppBrowserRuntime =
  Object.freeze({
    search: () => window.location.search,
    viewport: defaultViewport,
    document,
    getMountedShell: () => document.getElementById("root"),
    waitForAnimationFrame: waitForBoundedAnimationFrame
  });

function tokenExpiresAfter(token: string, nowSeconds: number): boolean {
  try {
    if (token.length > 8 * 1_024) return false;
    const segment = token.split(".")[1];
    if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload: unknown = JSON.parse(window.atob(padded));
    return isRecord(payload)
      && typeof payload.exp === "number"
      && Number.isSafeInteger(payload.exp)
      && payload.exp > nowSeconds + TOKEN_REFRESH_SKEW_SECONDS;
  } catch {
    return false;
  }
}

function createQuickAuthFetch(
  miniAppHost: MiniAppHost,
  quickAuthClient: QuickAuthLightClient
): typeof fetch {
  let currentToken: string | undefined;
  let pendingToken: Promise<string> | undefined;

  const getToken = async (): Promise<string> => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (currentToken && tokenExpiresAfter(currentToken, nowSeconds)) return currentToken;
    if (pendingToken) return pendingToken;

    pendingToken = (async () => {
      const { nonce } = await quickAuthClient.generateNonce();
      const response = await miniAppHost.signIn({ nonce, acceptAuthAddress: true });
      if (!isRecord(response) || !isRecord(response.result)) {
        throw new Error("Quick Auth was not approved.");
      }
      const message = response.result.message;
      const signature = response.result.signature;
      if (typeof message !== "string" || typeof signature !== "string") {
        throw new Error("Quick Auth returned an invalid response.");
      }
      const verified = await quickAuthClient.verifySiwf({
        // Fail closed against the actual loaded origin. A host-supplied SIWE
        // message for any other domain cannot mint a token for SnapMeter.
        domain: window.location.host,
        message,
        signature
      });
      if (!isRecord(verified) || typeof verified.token !== "string") {
        throw new Error("Quick Auth returned an invalid token.");
      }
      currentToken = verified.token;
      return verified.token;
    })().finally(() => {
      pendingToken = undefined;
    });
    return pendingToken;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

export const defaultMiniAppSdkLoader: MiniAppSdkLoader = async () => {
  // Import only the host bridge. The SDK root re-exports optional Solana
  // support, which would otherwise ship an unused wallet/RPC stack in this
  // read-only dashboard's browser bundle.
  const [{ miniAppHost }, { createLightClient }] = await Promise.all([
    import("@farcaster/miniapp-sdk/dist/miniAppHost.js"),
    import("@farcaster/quick-auth/light")
  ]);
  const host = miniAppHost as unknown as MiniAppHost;
  const context = host.context;
  const isInMiniApp = async (): Promise<boolean> => {
    const webView = (window as Window & { ReactNativeWebView?: unknown }).ReactNativeWebView;
    if (!webView && window === window.parent) return false;
    return await Promise.race([
      Promise.resolve(context).then(Boolean).catch(() => false),
      new Promise<false>((resolve) => window.setTimeout(
        () => resolve(false),
        MINI_APP_DETECTION_MILLISECONDS
      ))
    ]);
  };

  const quickAuthClient = createLightClient() as unknown as QuickAuthLightClient;
  return Object.freeze({
    isInMiniApp,
    context,
    actions: Object.freeze({
      ready: (options: { disableNativeGestures: true }) => host.ready(options)
    }),
    quickAuth: Object.freeze({ fetch: createQuickAuthFetch(host, quickAuthClient) })
  }) satisfies MiniAppSdk;
};
