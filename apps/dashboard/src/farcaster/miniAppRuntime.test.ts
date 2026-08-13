// @vitest-environment jsdom
// Adapted from ael-dev3/Warpkeep at commit
// 96e49cdb60b2fc8483e63f9df58447e5acbc6b92 (Apache-2.0).
// Modified for SnapMeter; see THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultMiniAppSdkLoader,
  hasExactMiniAppHint,
  installMiniAppSafeAreaVariables,
  sanitizeMiniAppContext
} from "./miniAppRuntime";

describe("Mini App runtime boundary", () => {
  afterEach(() => {
    for (const property of ["top", "right", "bottom", "left"]) {
      document.documentElement.style.removeProperty(`--fc-safe-area-inset-${property}`);
    }
  });

  it("accepts exactly one literal miniApp=true query entry", () => {
    expect(hasExactMiniAppHint("?miniApp=true")).toBe(true);
    expect(hasExactMiniAppHint("?demo=1&miniApp=true")).toBe(true);
    expect(hasExactMiniAppHint("?miniApp=false")).toBe(false);
    expect(hasExactMiniAppHint("?miniApp=True")).toBe(false);
    expect(hasExactMiniAppHint("?miniApp=%74rue")).toBe(false);
    expect(hasExactMiniAppHint("?miniApp=true&miniApp=true")).toBe(false);
    expect(hasExactMiniAppHint("?miniApp=true&miniApp=false")).toBe(false);
  });

  it("keeps only bounded presentation FIDs and safe-area values", () => {
    expect(sanitizeMiniAppContext({
      user: { fid: 44, username: "untrusted-host-name" },
      client: {
        clientFid: 9_152,
        safeAreaInsets: { top: 999, right: -3, bottom: 24.4567, left: 8 }
      },
      authorization: "must-not-cross"
    }, { width: 320, height: 640 })).toEqual({
      fid: 44,
      clientFid: 9_152,
      safeAreaInsets: { top: 160, right: 0, bottom: 24.457, left: 8 }
    });

    expect(sanitizeMiniAppContext({
      user: { fid: "44" },
      client: { clientFid: 9_152 }
    }, { width: 320, height: 640 })).toBeNull();
  });

  it("installs and removes only the sanitized CSS variables", () => {
    document.documentElement.style.setProperty("--fc-safe-area-inset-left", "1px");
    const remove = installMiniAppSafeAreaVariables(document, {
      top: 12,
      right: 7,
      bottom: 18,
      left: 3
    });
    expect(document.head.querySelector("[data-snapmeter-miniapp-safe-area]")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--fc-safe-area-inset-top")).toBe("12px");
    expect(document.documentElement.style.getPropertyValue("--fc-safe-area-inset-bottom")).toBe("18px");
    expect(document.documentElement.style.getPropertyValue("--fc-safe-area-inset-left")).toBe("3px");
    remove();
    expect(document.documentElement.style.getPropertyValue("--fc-safe-area-inset-top")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--fc-safe-area-inset-left")).toBe("1px");
  });

  it("loads the narrow host bridge without requiring wallet capabilities", async () => {
    const sdk = await defaultMiniAppSdkLoader();
    expect(sdk).toMatchObject({
      isInMiniApp: expect.any(Function),
      actions: { ready: expect.any(Function) },
      quickAuth: { fetch: expect.any(Function) }
    });
    await expect((sdk as { isInMiniApp: () => Promise<boolean> }).isInMiniApp()).resolves.toBe(false);
  });
});
