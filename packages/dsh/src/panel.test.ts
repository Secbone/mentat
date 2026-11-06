import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apply,
  type PanelRequest,
  type PanelResponse,
  type PanelRoute,
  renderPanelHtml,
} from "./panel";
import { createMentatService } from "./service";

function response() {
  let body = "";
  const headers: Record<string, string> = {};
  const res: PanelResponse = {
    statusCode: 0,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(value) {
      body = value ?? "";
    },
  };
  return { res, headers, text: () => body };
}

function panel() {
  const routes = new Map<string, PanelRoute>();
  const service = createMentatService({
    dir: mkdtempSync(join(tmpdir(), "mentat-panel-")),
    source: {
      id: "fake",
      label: "Fake",
      async poll() {
        return [];
      },
    },
  });
  apply({
    mentat: service,
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });
  return { routes, service };
}

describe("Mentat panel", () => {
  it("renders the page and overview JSON", async () => {
    const { routes } = panel();
    expect(renderPanelHtml()).toContain("Needs a person");
    const page = response();
    await routes.get("/mentat")?.handler({} as PanelRequest, page.res);
    expect(page.text()).toContain("Mentat");

    const overview = response();
    await routes.get("/mentat/overview")?.handler({} as PanelRequest, overview.res);
    expect(overview.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(overview.text())).toMatchObject({
      counts: { tickets: 0, needsPerson: 0 },
      channel: { stable: { id: "worker-default", version: 1 } },
    });
  });

  it("polls the source through the panel route", async () => {
    const { routes, service } = panel();
    await service.poller?.tick();
    const overview = response();
    await routes.get("/mentat/overview")?.handler({} as PanelRequest, overview.res);
    expect(JSON.parse(overview.text())).toMatchObject({
      source: { lastPollCount: 0, consecutiveFailures: 0 },
    });

    const result = response();
    await routes.get("/mentat/poll")?.handler({ method: "POST" } as PanelRequest, result.res);
    expect(JSON.parse(result.text())).toEqual({ polled: 0 });

    const refused = response();
    await routes.get("/mentat/poll")?.handler({ method: "GET" } as PanelRequest, refused.res);
    expect(refused.res.statusCode).toBe(405);
  });
});
