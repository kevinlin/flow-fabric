import Database from 'better-sqlite3';

export type InstanceStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'incident'
  | 'aborted';

export interface InstanceRow {
  id: string;
  name: string;
  source: string;
  status: InstanceStatus;
  engineState: string | null;
  workspace: string;
  dryRun: boolean;
  stubOverrides: string | null;
}

export interface EventRow {
  seq: number;
  type: string;
  elementId: string | null;
  detail: string | null;
  ts: number;
}

export interface UserTaskRow {
  id: number;
  instanceId: string;
  nodeId: string;
  formSchema: string;
  status: 'pending' | 'submitted';
  submittedVars: string | null;
}

export interface IncidentRow {
  id: number;
  instanceId: string;
  nodeId: string;
  reason: string;
  status: 'open' | 'resolved';
  resolution: string | null;
}

const INSTANCE_COLUMNS = `id, name, source, status, engine_state AS engineState,
  workspace_path AS workspace, dry_run AS dryRun, stub_overrides AS stubOverrides`;

const USER_TASK_COLUMNS = `id, instance_id AS instanceId, node_id AS nodeId,
  form_schema AS formSchema, status, submitted_vars AS submittedVars`;

const INCIDENT_COLUMNS = `id, instance_id AS instanceId, node_id AS nodeId,
  reason, status, resolution`;

type RawInstanceRow = Omit<InstanceRow, 'dryRun'> & { dryRun: number };

function coerceInstance(row: RawInstanceRow): InstanceRow {
  return { ...row, dryRun: !!row.dryRun };
}

export class InstanceStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        engine_state TEXT,
        workspace_path TEXT NOT NULL DEFAULT '',
        dry_run INTEGER NOT NULL DEFAULT 0,
        stub_overrides TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        type TEXT NOT NULL,
        element_id TEXT,
        detail TEXT,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        node_id TEXT NOT NULL,
        form_schema TEXT NOT NULL,
        status TEXT NOT NULL,
        submitted_vars TEXT,
        created_at INTEGER NOT NULL,
        submitted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        node_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `);
  }

  createInstance(
    id: string,
    name: string,
    source: string,
    opts: {
      workspace?: string;
      dryRun?: boolean;
      stubOverrides?: Record<string, Record<string, unknown>>;
    } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instances
           (id, name, source, status, engine_state, workspace_path, dry_run, stub_overrides, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        source,
        opts.workspace ?? '',
        opts.dryRun ? 1 : 0,
        opts.stubOverrides ? JSON.stringify(opts.stubOverrides) : null,
        now,
        now,
      );
  }

  saveEngineState(id: string, stateJson: string): void {
    this.db
      .prepare(`UPDATE instances SET engine_state = ?, updated_at = ? WHERE id = ?`)
      .run(stateJson, Date.now(), id);
  }

  setStatus(id: string, status: InstanceStatus): void {
    this.db
      .prepare(`UPDATE instances SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  appendEvent(instanceId: string, type: string, elementId?: string, detail?: string): void {
    this.db
      .prepare(`INSERT INTO events (instance_id, type, element_id, detail, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(instanceId, type, elementId ?? null, detail ?? null, Date.now());
  }

  getInstance(id: string): InstanceRow | undefined {
    const row = this.db
      .prepare(`SELECT ${INSTANCE_COLUMNS} FROM instances WHERE id = ?`)
      .get(id) as RawInstanceRow | undefined;
    return row ? coerceInstance(row) : undefined;
  }

  listNonTerminal(): InstanceRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${INSTANCE_COLUMNS} FROM instances WHERE status IN ('running', 'stopped', 'incident')`,
        )
        .all() as RawInstanceRow[]
    ).map(coerceInstance);
  }

  listEvents(instanceId: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT seq, type, element_id AS elementId, detail, ts
         FROM events WHERE instance_id = ? ORDER BY seq`,
      )
      .all(instanceId) as EventRow[];
  }

  createUserTask(instanceId: string, nodeId: string, formSchema: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO user_tasks (instance_id, node_id, form_schema, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(instanceId, nodeId, formSchema, Date.now());
    return Number(result.lastInsertRowid);
  }

  findPendingUserTask(instanceId: string, nodeId: string): UserTaskRow | undefined {
    return this.db
      .prepare(
        `SELECT ${USER_TASK_COLUMNS} FROM user_tasks
         WHERE instance_id = ? AND node_id = ? AND status = 'pending'`,
      )
      .get(instanceId, nodeId) as UserTaskRow | undefined;
  }

  listPendingUserTasks(): UserTaskRow[] {
    return this.db
      .prepare(`SELECT ${USER_TASK_COLUMNS} FROM user_tasks WHERE status = 'pending' ORDER BY id`)
      .all() as UserTaskRow[];
  }

  getUserTask(id: number): UserTaskRow | undefined {
    return this.db
      .prepare(`SELECT ${USER_TASK_COLUMNS} FROM user_tasks WHERE id = ?`)
      .get(id) as UserTaskRow | undefined;
  }

  submitUserTask(id: number, vars: Record<string, unknown>): void {
    this.db
      .prepare(
        `UPDATE user_tasks SET status = 'submitted', submitted_vars = ?, submitted_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(vars), Date.now(), id);
  }

  createIncident(instanceId: string, nodeId: string, reason: string): number {
    const result = this.db
      .prepare(
        `INSERT INTO incidents (instance_id, node_id, reason, status, created_at)
         VALUES (?, ?, ?, 'open', ?)`,
      )
      .run(instanceId, nodeId, reason, Date.now());
    return Number(result.lastInsertRowid);
  }

  findOpenIncident(instanceId: string, nodeId: string): IncidentRow | undefined {
    return this.db
      .prepare(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents
         WHERE instance_id = ? AND node_id = ? AND status = 'open'`,
      )
      .get(instanceId, nodeId) as IncidentRow | undefined;
  }

  listOpenIncidents(): IncidentRow[] {
    return this.db
      .prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE status = 'open' ORDER BY id`)
      .all() as IncidentRow[];
  }

  getIncident(id: number): IncidentRow | undefined {
    return this.db
      .prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`)
      .get(id) as IncidentRow | undefined;
  }

  resolveIncident(id: number, resolution: string): void {
    this.db
      .prepare(
        `UPDATE incidents SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(resolution, Date.now(), id);
  }

  close(): void {
    this.db.close();
  }
}
