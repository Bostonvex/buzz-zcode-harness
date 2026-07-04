/**
 * ZCode App tasks-index sync: let the App UI see ACP-created sessions.
 *
 * The ZCode App's session list reads from `~/.zcode/v2/tasks-index.sqlite`
 * (the `tasks` table), NOT from the CLI's `~/.zcode/cli/db/db.sqlite`. These
 * are independent stores — the App's Electron host maintains tasks-index; the
 * headless app-server (which we drive) writes only to cli/db. As a result,
 * every session created via ACP is invisible in the App's UI until the App
 * happens to reindex.
 *
 * This module bridges that gap by writing a tasks-index row directly after
 * session/create. The App picks it up on its next list refresh. INSERT OR
 * IGNORE avoids clobbering rows the App already manages.
 *
 * Best-effort side-channel: failures (locked DB, schema drift) are logged and
 * swallowed so they never break the session/create path.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { log, ZCODE_CREDS_PATH } from "./utils.js";

/**
 * Dynamically load `node:sqlite` (Node ≥ 22). On older Node the import fails;
 * callers degrade gracefully (tasks-index sync is best-effort). We cache the
 * loaded class so repeated calls don't re-import.
 */
let DatabaseSyncCtor:
  | ((
      path: string,
      options?: { timeout?: number },
    ) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => unknown;
      close: () => void;
    })
  | null
  | undefined;

async function loadSqlite() {
  if (DatabaseSyncCtor !== undefined) return DatabaseSyncCtor;
  try {
    // node:sqlite ships with Node ≥ 22. Cast through unknown so this compiles
    // even if @types/node lags behind the runtime module.
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: unknown;
    };
    DatabaseSyncCtor = mod.DatabaseSync as never;
  } catch {
    DatabaseSyncCtor = null; // Node < 22 or sqlite unavailable
  }
  return DatabaseSyncCtor;
}

/** tasks-index.sqlite sits next to config.json under ~/.zcode/v2/. */
const TASKS_INDEX_PATH = path.join(path.dirname(ZCODE_CREDS_PATH), "tasks-index.sqlite");

/** Read provider id + model id from config.json (display-only fields). */
function resolveProviderModel(): { providerId: string; modelRef: string } {
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as {
      provider?: Record<string, { enabled?: boolean; models?: Record<string, unknown> }>;
    };
    for (const [, p] of Object.entries(cfg.provider ?? {})) {
      if (p?.enabled) {
        const models = p.models ?? {};
        const modelId = Object.keys(models)[0] ?? "GLM-5.2";
        return { providerId: "glm", modelRef: modelId };
      }
    }
  } catch {
    // fall through to defaults
  }
  return { providerId: "glm", modelRef: "GLM-5.2" };
}

/**
 * Insert (or refresh) a row in tasks-index.sqlite so the App UI shows it.
 * Called after a successful session/create. Uses INSERT OR IGNORE so it never
 * overwrites a row the App is actively managing (e.g. user-renamed titles).
 *
 * Returns true if written, false on failure (logged, never thrown).
 */
export async function upsertSessionTask(opts: {
  workspaceKey: string;
  taskId: string;
  title: string;
  traceId?: string;
  model?: string;
  status?: string;
}): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH)) return false; // App never installed → no index.
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return false; // node:sqlite unavailable (Node < 22)
  const nowMs = Date.now();
  const { providerId, modelRef } = resolveProviderModel();
  const model = opts.model ?? modelRef;
  const status = opts.status ?? "completed";
  const meta = {
    taskId: opts.taskId,
    traceId: opts.traceId ?? opts.taskId,
    title: opts.title,
    titleOverridden: false,
    workspacePath: opts.workspaceKey,
    createdAt: nowMs,
    updatedAt: nowMs,
    mode: "build",
    model,
    provider: providerId,
    status,
    target: null,
  };
  let metaJson: string;
  try {
    metaJson = JSON.stringify(meta);
  } catch {
    return false;
  }
  try {
    const con = DatabaseSync(TASKS_INDEX_PATH, { timeout: 5000 });
    try {
      con.run(
        "INSERT OR IGNORE INTO tasks " +
          "(workspace_key, workspace_path, workspace_identity, task_id, " +
          " title, task_status, provider, mode, model, " +
          " created_at, updated_at, unread_at, pinned, archived, deleted, " +
          " title_overridden, meta_json, searchable_text) " +
          "VALUES (?, ?, NULL, ?, ?, ?, ?, 'build', ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?)",
        opts.workspaceKey,
        opts.workspaceKey,
        opts.taskId,
        opts.title,
        status,
        providerId,
        model,
        nowMs,
        nowMs,
        metaJson,
        opts.title,
      );
    } finally {
      con.close();
    }
    return true;
  } catch (e) {
    log(`tasks-index sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Update a session's title after the first turn. session/create leaves title
 * empty; once the first prompt completes, set a meaningful title. Respects
 * title_overridden: if the user already renamed in the App, their title wins.
 */
export async function updateSessionTitle(taskId: string, title: string): Promise<boolean> {
  if (!existsSync(TASKS_INDEX_PATH) || !title) return false;
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return false;
  const trimmed = title.trim().slice(0, 80);
  if (!trimmed) return false;
  try {
    const con = DatabaseSync(TASKS_INDEX_PATH, { timeout: 5000 });
    try {
      const row = con.get("SELECT title_overridden FROM tasks WHERE task_id=?", taskId) as
        { title_overridden: number } | undefined;
      if (!row) return false;
      if (row.title_overridden === 1) return true; // user overrode → respect it
      con.run(
        "UPDATE tasks SET title=?, updated_at=?, searchable_text=? WHERE task_id=? AND title_overridden=0",
        trimmed,
        Date.now(),
        trimmed,
        taskId,
      );
    } finally {
      con.close();
    }
    return true;
  } catch (e) {
    log(`tasks-index title update skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
