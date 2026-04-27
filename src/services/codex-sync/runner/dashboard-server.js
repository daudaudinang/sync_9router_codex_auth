import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML_PATH = path.join(__dirname, "dashboard.html");

let cachedHtml = null;
function getDashboardHtml() {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(DASHBOARD_HTML_PATH, "utf-8");
  }
  return cachedHtml;
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function htmlResponse(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function redactAccounts(db) {
  const providerConnections = Array.isArray(db?.providerConnections) ? db.providerConnections : [];
  const records = providerConnections
    .filter((r) => r?.provider === "codex" && r?.authType === "oauth")
    .map((r) => ({
      email: r.email || null,
      accountId: r.providerSpecificData?.accountId || null,
      inventoryKey: r.providerSpecificData?.inventoryKey || r.inventoryKey || null,
      inventoryRevision: r.providerSpecificData?.inventoryRevision ?? null,
      inventorySyncUpdatedAt: r.providerSpecificData?.inventorySyncUpdatedAt || null,
      testStatus: r.testStatus || null,
      isActive: r.isActive ?? true,
      hasAccessToken: Boolean(r.accessToken),
      hasRefreshToken: Boolean(r.refreshToken),
    }));

  return { total: records.length, records };
}

export function createDashboardServer({ stateStore, dbAdapter, config, buildStatusFn, sendCommandFn }) {
  const port = config.dashboard?.port || 3001;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    try {
      // Dashboard HTML
      if (pathname === "/" && req.method === "GET") {
        htmlResponse(res, getDashboardHtml());
        return;
      }

      // Status API
      if (pathname === "/api/status" && req.method === "GET") {
        const status = buildStatusFn();
        jsonResponse(res, 200, status);
        return;
      }

      // Accounts API (redacted)
      if (pathname === "/api/accounts" && req.method === "GET") {
        const db = await dbAdapter.readDb();
        const data = redactAccounts(db);
        jsonResponse(res, 200, data);
        return;
      }

      // Sync-now API
      if (pathname === "/api/sync-now" && req.method === "POST") {
        const dryRun = url.searchParams.get("dryRun") === "true";
        const requestId = randomUUID();

        if (dryRun) {
          stateStore.update((state) => ({
            ...state,
            queue: {
              ...state.queue,
              dryRunNextRun: true,
            },
          }));
        }

        const result = await sendCommandFn({
          requestId,
          command: "sync-now",
          dryRun,
        });

        jsonResponse(res, 200, result);
        return;
      }

      // 404
      jsonResponse(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error?.message || String(error);
      process.stderr.write(`[dashboard] Error: ${message}\n`);
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    process.stderr.write(`[dashboard] Dashboard running at http://0.0.0.0:${port}\n`);
  });

  server.on("error", (err) => {
    process.stderr.write(`[dashboard] Server error: ${err.message}\n`);
  });

  return server;
}
