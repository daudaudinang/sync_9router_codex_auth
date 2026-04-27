#!/usr/bin/env node

import path from "node:path";
import { LocalDbAdapter, getDefaultDataDir } from "../src/services/codex-sync/local/db-adapter.js";
import { backfillCodexIdentityRecords } from "../src/services/codex-sync/core/identity-backfill.js";

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));

  const valueOf = (flagName) => {
    const index = args.findIndex((arg) => arg === flagName);
    if (index === -1) return null;
    return args[index + 1] || null;
  };

  return {
    write: flags.has("--write"),
    json: flags.has("--json"),
    dbPath: valueOf("--db-path"),
    dataDir: valueOf("--data-dir"),
  };
}

function defaultDbPathFromDataDir(dataDir) {
  return path.join(dataDir, "db.json");
}

function printResult(payload, json) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`dataDir: ${payload.dataDir}`);
  console.log(`dbPath: ${payload.dbPath}`);
  console.log(`write: ${payload.write}`);
  console.log(`scanned: ${payload.summary.scanned}`);
  console.log(`patched: ${payload.summary.patched}`);
  console.log(`unchanged: ${payload.summary.unchanged}`);
  console.log(`skipped: ${payload.summary.skipped}`);
  console.log(`reasons: ${JSON.stringify(payload.summary.reasons)}`);

  if (payload.summary.patchedRecords.length > 0) {
    console.log("patchedRecords:");
    for (const item of payload.summary.patchedRecords) {
      console.log(
        `- ${item.id} | ${item.email} | ${item.accountId} | revision=${item.inventoryRevision}`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir || process.env.DATA_DIR || getDefaultDataDir();
  const dbPath = args.dbPath || defaultDbPathFromDataDir(dataDir);
  const adapter = new LocalDbAdapter({ dataDir, dbPath });
  const now = new Date().toISOString();

  if (args.write) {
    let resultSummary = null;
    await adapter.writeDb((db) => {
      const providerConnections = Array.isArray(db.providerConnections) ? db.providerConnections : [];
      const result = backfillCodexIdentityRecords(providerConnections, now);
      db.providerConnections = result.records;
      resultSummary = result.summary;
      return db;
    });

    printResult(
      {
        dataDir,
        dbPath,
        write: true,
        summary: resultSummary,
      },
      args.json,
    );
    return;
  }

  const db = await adapter.readDb();
  const providerConnections = Array.isArray(db.providerConnections) ? db.providerConnections : [];
  const result = backfillCodexIdentityRecords(providerConnections, now);

  printResult(
    {
      dataDir,
      dbPath,
      write: false,
      summary: result.summary,
    },
    args.json,
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "error",
        error: error?.message || String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
