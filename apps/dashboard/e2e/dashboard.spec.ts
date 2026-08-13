import { expect, test, type Page } from "@playwright/test";
import { createDemoSummary } from "../src/data/demo";

async function mockLive(page: Page, statuses: [string, string] = ["live", "derived"]): Promise<void> {
  const summary = createDemoSummary();
  summary.demo = false;
  summary.sources.snapchain.status = statuses[0] as typeof summary.sources.snapchain.status;
  summary.sources.hypersnap.status = statuses[1] as typeof summary.sources.hypersnap.status;
  await page.route("**/api/v1/summary", (route) => route.fulfill({ json: summary }));
  await page.routeWebSocket("**/api/v1/live", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", schemaVersion: 1, sequence: 1, data: summary }));
  });
}

test.describe("mobile portrait overview", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("uses equal top and bottom protocol regions with no horizontal overflow", async ({ page }) => {
    await page.goto("/?demo=1");
    const snap = await page.getByTestId("panel-snapchain").boundingBox();
    const hyper = await page.getByTestId("panel-hypersnap").boundingBox();
    expect(snap).not.toBeNull();
    expect(hyper).not.toBeNull();
    expect(snap!.y).toBe(0);
    expect(Math.abs(snap!.height - hyper!.height)).toBeLessThanOrEqual(1);
    expect(hyper!.y).toBeCloseTo(422, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("labels deterministic demo data and keeps its heartbeat honest", async ({ page }) => {
    await page.goto("/?demo=1");
    await expect(page.getByText("DEMO", { exact: true })).toBeVisible();
    await expect(page.getByText(/never a production fallback/i)).toBeVisible();
    await expect(page.getByTestId("heartbeat-snapchain")).toHaveAttribute("data-pulse-id", "0");
    await expect(page.getByTestId("panel-hypersnap")).toContainText("Derived");
  });

  test("exposes reduced-motion and keyboard chart equivalents", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/?demo=1");
    await expect(page.getByText("Motion reduced").first()).toBeVisible();
    const chart = page.getByTestId("comparison-chart").getByRole("img");
    await chart.focus();
    await chart.press("End");
    await expect(page.getByTestId("comparison-chart").locator(".chart-tooltip")).toHaveAttribute("data-visible", "true");
    await context.close();
  });

  test("shows stale and disconnected source states verbatim", async ({ page }) => {
    await mockLive(page, ["stale", "disconnected"]);
    await page.goto("/");
    await expect(page.getByTestId("panel-snapchain")).toHaveAttribute("data-status", "stale");
    await expect(page.getByTestId("panel-hypersnap")).toHaveAttribute("data-status", "disconnected");
  });

  test("animates only after a live WebSocket pulse and deduplicates it", async ({ page }) => {
    const summary = createDemoSummary();
    summary.demo = false;
    summary.sources.snapchain.status = "live";
    await page.route("**/api/v1/summary", (route) => route.fulfill({ json: summary }));
    await page.routeWebSocket("**/api/v1/live", (socket) => {
      socket.send(JSON.stringify({ type: "snapshot", schemaVersion: 1, sequence: 1, data: summary }));
      const pulse = {
        type: "pulse",
        schemaVersion: 1,
        sequence: 2,
        deliveryId: "00000000-0000-4000-8000-000000000001:pulse:0",
        data: {
          schemaVersion: 1,
          source: "snapchain",
          sourceMode: "verified",
          windowStartMs: 1000,
          windowEndMs: 1250,
          eventCount: 24,
          uniqueFids: 16,
          actionCounts: { cast: 24 },
          lastActionAtMs: 1200,
          maxEventId: "99",
          isReplay: false
        }
      };
      socket.send(JSON.stringify(pulse));
      socket.send(JSON.stringify(pulse));
    });
    await page.goto("/");
    await expect(page.getByTestId("heartbeat-snapchain")).toHaveAttribute("data-pulse-id", "1");
    await expect(page.getByTestId("heartbeat-snapchain")).toContainText("24 qualifying events");
  });

  test("retains a trustworthy snapshot and signals browser offline", async ({ page, context }) => {
    await mockLive(page);
    await page.goto("/");
    await expect(page.getByTestId("panel-snapchain")).toContainText("58,429");
    await context.setOffline(true);
    await expect(page.getByText(/Browser offline — showing the last trustworthy snapshot/i)).toBeVisible();
    await expect(page.getByTestId("panel-snapchain")).toContainText("58,429");
    await context.setOffline(false);
  });
});

test("switches to side-by-side protocol comparison on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?demo=1");
  const snap = await page.getByTestId("panel-snapchain").boundingBox();
  const hyper = await page.getByTestId("panel-hypersnap").boundingBox();
  expect(snap).not.toBeNull();
  expect(hyper).not.toBeNull();
  expect(snap!.x).toBe(0);
  expect(hyper!.x).toBeCloseTo(720, 0);
  expect(Math.abs(snap!.width - hyper!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(snap!.y - hyper!.y)).toBeLessThanOrEqual(1);
});
