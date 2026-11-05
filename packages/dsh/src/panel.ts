import { buildOverview } from "@mentat/panel";
import type { MentatService } from "./service";

export interface PanelRequest {
  method?: string;
}

export interface PanelResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export interface PanelRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: PanelRequest, res: PanelResponse) => void | Promise<void>;
}

export interface PanelContext {
  mentat: MentatService;
  webServer: { register(route: PanelRoute): () => void };
  effect?(setup: () => (() => void) | void): () => void;
}

export const name = "mentat-panel";
export const inject = ["webServer", "mentat"];

function sendJson(res: PanelResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(value));
}

function sendHtml(res: PanelResponse, body: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

/** A small server-rendered panel at /mentat; it reads the same projection as mentat_overview. */
export function renderPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>Mentat</title>
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; background: #0b0e14; color: #d7dce5; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #8b93a1; font-size: 13px; }
  .bar { display: flex; gap: 8px; margin: 18px 0; }
  button { background: #1c2330; color: #d7dce5; border: 1px solid #2c3646; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  section { margin-top: 24px; }
  h2 { font-size: 14px; color: #9aa4b2; text-transform: uppercase; letter-spacing: .06em; }
  .row { border: 1px solid #222b38; border-radius: 8px; padding: 10px 12px; margin: 8px 0; background: #111722; }
  .row strong { font-weight: 600; }
  .tag { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 999px; background: #1e2a3d; color: #9fc3ff; margin-left: 6px; }
  .empty { color: #6f7886; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Mentat</h1>
  <div class="muted" id="stamp">loading…</div>
  <div class="bar">
    <button id="refresh">Refresh</button>
    <button id="poll">Poll source</button>
  </div>
  <section><h2>Needs a person</h2><div id="needs"></div></section>
  <section><h2>Open</h2><div id="open"></div></section>
  <section><h2>Assignments</h2><div id="assignments"></div></section>
  <section><h2>Decisions</h2><div id="decisions" class="muted"></div></section>
</main>
<script>
async function refresh() {
  const response = await fetch('/mentat/overview');
  const overview = await response.json();
  document.getElementById('stamp').textContent = overview.generatedAt;
  const needs = document.getElementById('needs');
  needs.replaceChildren();
  if (overview.needsPerson.length === 0) needs.innerHTML = '<div class="empty">Nothing needs a person.</div>';
  for (const ticket of overview.needsPerson) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<strong></strong><span class="tag"></span><div class="muted"></div>';
    row.querySelector('strong').textContent = ticket.id;
    row.querySelector('.tag').textContent = ticket.stage;
    row.querySelector('.muted').textContent = ticket.question || ticket.latestReport || '';
    needs.appendChild(row);
  }
  const open = document.getElementById('open');
  open.replaceChildren();
  if (overview.open.length === 0) open.innerHTML = '<div class="empty">No open Tickets.</div>';
  for (const ticket of overview.open) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<strong></strong><span class="tag"></span>';
    row.querySelector('strong').textContent = ticket.id;
    row.querySelector('.tag').textContent = ticket.stage;
    open.appendChild(row);
  }
  const assignments = document.getElementById('assignments');
  assignments.replaceChildren();
  if (overview.assignments.length === 0) assignments.innerHTML = '<div class="empty">No Assignments.</div>';
  for (const assignment of overview.assignments) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<strong></strong><span class="tag"></span>';
    row.querySelector('strong').textContent = assignment.worker;
    row.querySelector('.tag').textContent = assignment.state;
    assignments.appendChild(row);
  }
  const decisions = document.getElementById('decisions');
  decisions.textContent = Object.entries(overview.decisions).map(([k, v]) => k + '=' + v).join('  ');
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('poll').addEventListener('click', async () => {
  await fetch('/mentat/poll', { method: 'POST' });
  await refresh();
});
refresh();
</script>
</body>
</html>`;
}

export function apply(ctx: PanelContext): void {
  const dispose = ctx.webServer.register({
    kind: "exact",
    path: "/mentat",
    handler: (_req, res) => sendHtml(res, renderPanelHtml()),
  });
  const disposeOverview = ctx.webServer.register({
    kind: "exact",
    path: "/mentat/overview",
    handler: (_req, res) =>
      sendJson(
        res,
        buildOverview(ctx.mentat.repos, {
          evolution: ctx.mentat.packs.list().map((candidate) => ({
            id: candidate.id,
            status: candidate.status,
            version: candidate.pack.version,
            digest: candidate.pack.digest,
            ...(candidate.reason ? { reason: candidate.reason } : {}),
          })),
        }),
      ),
  });
  const disposePoll = ctx.webServer.register({
    kind: "exact",
    path: "/mentat/poll",
    handler: async (req, res) => {
      if (req.method !== "POST") return sendJson(res, { error: "POST required" }, 405);
      const polled = ctx.mentat.poller ? await ctx.mentat.poller.tick() : 0;
      return sendJson(res, { polled });
    },
  });
  if (ctx.effect) {
    ctx.effect(() => () => {
      dispose();
      disposeOverview();
      disposePoll();
    });
  }
}
