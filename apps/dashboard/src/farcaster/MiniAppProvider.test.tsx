// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MiniAppProvider, useMiniAppHost } from "./MiniAppProvider";
import type {
  MiniAppBrowserRuntime,
  MiniAppSdk
} from "./miniAppRuntime";

function makeShell(): HTMLDivElement {
  const shell = document.createElement("div");
  shell.dataset.miniAppTestShell = "true";
  document.body.appendChild(shell);
  return shell;
}

function runtimeFor(
  shell: Element,
  search = "?miniApp=true"
): MiniAppBrowserRuntime {
  return Object.freeze({
    search: () => search,
    viewport: () => ({ width: 390, height: 844 }),
    document,
    getMountedShell: () => shell,
    waitForAnimationFrame: vi.fn(async () => {})
  });
}

function HostState(): React.JSX.Element {
  const host = useMiniAppHost();
  return (
    <output data-testid="miniapp-state">
      {host.state} · {host.verifiedFid ?? "anonymous"}
    </output>
  );
}

afterEach(() => {
  document.querySelectorAll("[data-mini-app-test-shell]").forEach((node) => {
    node.remove();
  });
  for (const property of ["top", "right", "bottom", "left"]) {
    document.documentElement.style.removeProperty(`--fc-safe-area-inset-${property}`);
  }
});

describe("MiniAppProvider", () => {
  it("does not load the SDK without the exact Mini App hint", () => {
    const shell = makeShell();
    const sdkLoader = vi.fn();
    render(
      <MiniAppProvider
        runtime={runtimeFor(shell, "?miniApp=false")}
        sdkLoader={sdkLoader}
      >
        <p>Dashboard remains available</p>
      </MiniAppProvider>,
      { container: shell }
    );

    expect(screen.getByText("Dashboard remains available")).toBeVisible();
    expect(sdkLoader).not.toHaveBeenCalled();
  });

  it("signals ready once under StrictMode and exposes only the server-verified FID", async () => {
    const shell = makeShell();
    const ready = vi.fn(async () => {});
    const quickAuthFetch = vi.fn(async () => new Response(
      JSON.stringify({
        schemaVersion: 1,
        authenticated: true,
        fid: 777,
        username: "ignored-server-field"
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
    ));
    const sdk: MiniAppSdk = {
      isInMiniApp: vi.fn(async () => true),
      context: Promise.resolve({
        user: { fid: 111, username: "untrusted-host-name" },
        client: {
          clientFid: 9_152,
          safeAreaInsets: { top: 20, right: 4, bottom: 16, left: 4 }
        }
      }),
      actions: { ready },
      quickAuth: { fetch: quickAuthFetch }
    };
    const sdkLoader = vi.fn(async () => sdk);

    render(
      <StrictMode>
        <MiniAppProvider
          deadlineMilliseconds={500}
          runtime={runtimeFor(shell)}
          sdkLoader={sdkLoader}
        >
          <p>Dashboard remains available</p>
          <HostState />
        </MiniAppProvider>
      </StrictMode>,
      { container: shell }
    );

    expect(screen.getByText("Dashboard remains available")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId("miniapp-state")).toHaveTextContent("miniapp · 777");
    });
    expect(screen.queryByText(/FID 777/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/FID 111/i)).not.toBeInTheDocument();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith({ disableNativeGestures: true });
    expect(quickAuthFetch).toHaveBeenCalledTimes(1);
    expect(quickAuthFetch).toHaveBeenCalledWith(
      "/api/v1/farcaster/me",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
    );
    expect(document.documentElement.style.getPropertyValue(
      "--fc-safe-area-inset-top"
    )).toBe("20px");
  });

  it("falls back to public web without gating the dashboard", async () => {
    const shell = makeShell();
    const ready = vi.fn(async () => {});
    const quickAuthFetch = vi.fn();
    const sdk: MiniAppSdk = {
      isInMiniApp: vi.fn(async () => false),
      context: Promise.resolve({}),
      actions: { ready },
      quickAuth: { fetch: quickAuthFetch }
    };

    render(
      <MiniAppProvider
        deadlineMilliseconds={500}
        runtime={runtimeFor(shell)}
        sdkLoader={async () => sdk}
      >
        <p>Dashboard remains available</p>
        <HostState />
      </MiniAppProvider>,
      { container: shell }
    );

    expect(screen.getByText("Dashboard remains available")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId("miniapp-state")).toHaveTextContent("regular-web");
    });
    expect(ready).not.toHaveBeenCalled();
    expect(quickAuthFetch).not.toHaveBeenCalled();
  });
});
