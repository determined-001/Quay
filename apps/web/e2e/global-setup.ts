import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Deletes the local e2e SQLite file (and libSQL's -wal/-shm sidecars) before
 * the "local" project's webServer starts, so every run begins from an empty
 * database - a stale file from a previous run (or a previous test's data)
 * would otherwise leak between runs.
 */
export default async function globalSetup(): Promise<void> {
  const apiDir = resolve(here, "../../api");
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(resolve(apiDir, `e2e-test.db${suffix}`), { force: true });
  }
}
