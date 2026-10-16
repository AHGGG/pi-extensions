import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { type Destination, isObject, type Providers, validateDestination } from "./provider.js";

export type Mode = "immediate" | "after-inactivity";
export type Scope = "user" | "project";
export interface Settings {
  enabled: boolean;
  mode: Mode;
  inactivitySeconds: number;
  targetIds: string[];
  destinations: Record<string, Destination>;
}
export interface Snapshot {
  user: Record<string, unknown>;
  project: Record<string, unknown>;
  effective: Settings;
  diagnostics: string[];
}
export const MAX_INACTIVITY_SECONDS = 86_400;
export const MAX_DESTINATIONS = 32;
export const policyKeys = ["enabled", "mode", "inactivitySeconds", "targetIds"] as const;
export const defaults = (): Settings => ({
  enabled: false,
  mode: "immediate",
  inactivitySeconds: 30,
  targetIds: [],
  destinations: {},
});
export const validId = (id: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) && !["constructor", "prototype", "__proto__"].includes(id);
export const validSeconds = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_INACTIVITY_SECONDS;

function policy(document: Record<string, unknown>, diagnostics: string[]): Partial<Settings> {
  const result: Partial<Settings> = {};
  for (const key of policyKeys) {
    if (!Object.hasOwn(document, key)) continue;
    const value = document[key];
    if (key === "enabled" && typeof value === "boolean") result.enabled = value;
    else if (key === "mode" && (value === "immediate" || value === "after-inactivity")) result.mode = value;
    else if (key === "inactivitySeconds" && validSeconds(value)) result.inactivitySeconds = value;
    else if (
      key === "targetIds" &&
      Array.isArray(value) &&
      value.length <= MAX_DESTINATIONS &&
      value.every((id) => typeof id === "string" && validId(id)) &&
      new Set(value).size === value.length
    )
      result.targetIds = [...value];
    else diagnostics.push(`Invalid ${key} setting.`);
  }
  return result;
}

export function resolveSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>,
  providers: Providers,
  diagnostics: string[] = [],
): Snapshot {
  const effective = { ...defaults(), ...policy(user, diagnostics), ...policy(project, diagnostics) };
  if (Object.hasOwn(project, "destinations"))
    diagnostics.push("Project destinations are forbidden; use User settings.");
  if (user.destinations !== undefined) {
    if (!isObject(user.destinations) || Object.keys(user.destinations).length > MAX_DESTINATIONS)
      diagnostics.push("Invalid destinations setting.");
    else
      for (const [id, raw] of Object.entries(user.destinations)) {
        const destination = validId(id) ? validateDestination(raw, providers) : undefined;
        if (destination) effective.destinations[id] = destination;
        else diagnostics.push("Invalid destination or unsupported provider; edit User settings.");
      }
  }
  if (effective.targetIds.some((id) => !Object.hasOwn(effective.destinations, id)))
    diagnostics.push("Selected destination is missing or unsupported; update targetIds.");
  // Fail closed rather than sending with partial or invalid routing settings.
  if (diagnostics.length) effective.enabled = false;
  return { user, project, effective, diagnostics };
}

async function readDocument(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!isObject(value)) throw new Error("invalid");
    return value;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return {};
    throw new Error("Settings cannot be read as a JSON object. Repair the file before saving.");
  }
}

/** Per-instance transactions plus Pi's process-wide path queue; no cross-process lock. */
export class SettingsStore {
  snapshot: Snapshot;
  private tail: Promise<unknown> = Promise.resolve();
  readonly projectPath: string | undefined;
  constructor(
    readonly userPath: string,
    projectPath: string | undefined,
    private readonly providers: Providers,
  ) {
    // A customized agent directory can coincide with the project's settings directory.
    // One physical path cannot be both credential storage and a project overlay.
    this.projectPath = projectPath && resolve(projectPath) !== resolve(userPath) ? projectPath : undefined;
    this.snapshot = resolveSettings({}, {}, providers);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Always lock User before Project across instances to avoid lock-order deadlocks.
    const task = this.tail.catch(() => {}).then(() => withFileMutationQueue(this.userPath, operation));
    this.tail = task.catch(() => {});
    return task;
  }
  validate(value: unknown): Destination | undefined {
    return validateDestination(value, this.providers);
  }
  async flush(): Promise<void> {
    await this.tail;
  }
  load(): Promise<Snapshot> {
    return this.enqueue(async () => {
      const diagnostics: string[] = [];
      const read = async (path: string | undefined, scope: Scope) => {
        if (!path) return {};
        try {
          return await (path === this.userPath
            ? readDocument(path)
            : withFileMutationQueue(path, () => readDocument(path)));
        } catch {
          diagnostics.push(`${scope} settings cannot be read. Repair the JSON file before saving.`);
          return {};
        }
      };
      const user = await read(this.userPath, "user");
      const project = await read(this.projectPath, "project");
      this.snapshot = resolveSettings(user, project, this.providers, diagnostics);
      return this.snapshot;
    });
  }
  change(
    scope: Scope,
    mutate: (
      document: Record<string, unknown>,
      project: Record<string, unknown>,
      user: Record<string, unknown>,
    ) => void,
    signal: AbortSignal,
  ): Promise<Snapshot> {
    return this.enqueue(async () => {
      const path = scope === "user" ? this.userPath : this.projectPath;
      if (!path) throw new Error("Project settings require a trusted project.");
      const operation = async () => {
        signal.throwIfAborted();
        const document = await readDocument(path);
        signal.throwIfAborted();
        const user = scope === "user" ? document : await readDocument(this.userPath);
        const projectPath = this.projectPath;
        const project =
          scope === "project"
            ? document
            : projectPath
              ? await withFileMutationQueue(projectPath, () => readDocument(projectPath))
              : {};
        signal.throwIfAborted();
        const previousEnabled = document.enabled;
        mutate(document, project, user);
        const next = resolveSettings(user, project, this.providers);
        if (next.effective.targetIds.some((id) => !Object.hasOwn(next.effective.destinations, id)))
          throw new Error("Selected destination is missing or unsupported. Repair targetIds before saving.");
        // Preserve unrecognized destinations on unrelated saves, but never enable invalid routing.
        if (next.diagnostics.length && document.enabled === true && previousEnabled !== true)
          throw new Error(
            "Settings contain invalid fields or destinations. Repair them before enabling notifications.",
          );
        const temporary = join(dirname(path), `.pi-notify-${randomUUID()}.tmp`);
        try {
          await fs.mkdir(dirname(path), { recursive: true });
          signal.throwIfAborted();
          await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
          signal.throwIfAborted();
          await fs.rename(temporary, path);
        } catch {
          throw new Error("Settings were not saved. Check file permissions and available disk space.");
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
        this.snapshot = next;
        return next;
      };
      return path === this.userPath ? operation() : withFileMutationQueue(path, operation);
    });
  }
}

export function savePolicy(
  store: SettingsStore,
  scope: Scope,
  key: (typeof policyKeys)[number],
  value: unknown,
  signal: AbortSignal,
) {
  const diagnostics: string[] = [];
  if (value !== undefined) policy({ [key]: value }, diagnostics);
  if (diagnostics.length) return Promise.reject(new Error("Invalid notification policy value."));
  return store.change(
    scope,
    (document) => {
      if (value === undefined) delete document[key];
      else document[key] = value;
    },
    signal,
  );
}

export function saveDestination(
  store: SettingsStore,
  id: string,
  destination: Destination | undefined,
  signal: AbortSignal,
) {
  if (!validId(id)) throw new Error("Invalid destination ID.");
  const normalized = destination ? store.validate(destination) : undefined;
  if (destination && !normalized) throw new Error("Invalid destination settings.");
  return store.change(
    "user",
    (document, project) => {
      const destinations = isObject(document.destinations) ? { ...document.destinations } : {};
      if (normalized) {
        // Validators return owned optional keys as undefined so JSON publication removes them.
        destinations[id] = { ...(isObject(destinations[id]) ? destinations[id] : {}), ...normalized };
        if (Object.keys(destinations).length > MAX_DESTINATIONS)
          throw new Error("At most 32 destinations are supported.");
      } else {
        if (Array.isArray(project.targetIds) && project.targetIds.includes(id))
          throw new Error("Remove this destination from Project selections first.");
        delete destinations[id];
        if (Array.isArray(document.targetIds))
          document.targetIds = document.targetIds.filter((target) => target !== id);
      }
      document.destinations = destinations;
    },
    signal,
  );
}
