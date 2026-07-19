import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';

export type InstanceStatus =
  | 'running'
  | 'completed'
  | 'terminated'
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
  definitionId: string | null;
  versionNo: number | null;
  createdAt: number;
  updatedAt: number;
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
  taskExecutionId: number | null;
}

export interface TaskExecutionRow {
  id: number;
  instanceId: string;
  nodeId: string;
  actor: 'agent' | 'code' | 'user';
  attempt: number;
  resolvedInputs: string;
  output: string | null;
  error: string | null;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt: number | null;
  tokenUsage: string | null;
  costUsd: number | null;
  transcriptPath: string | null;
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
  workspace_path AS workspace, dry_run AS dryRun, stub_overrides AS stubOverrides,
  definition_id AS definitionId, version_no AS versionNo,
  created_at AS createdAt, updated_at AS updatedAt`;

const USER_TASK_COLUMNS = `id, instance_id AS instanceId, node_id AS nodeId,
  form_schema AS formSchema, status, submitted_vars AS submittedVars,
  task_execution_id AS taskExecutionId`;

const TASK_EXECUTION_COLUMNS = `id, instance_id AS instanceId, node_id AS nodeId,
  actor, attempt, resolved_inputs AS resolvedInputs, output, error, status,
  started_at AS startedAt, ended_at AS endedAt, token_usage AS tokenUsage,
  cost_usd AS costUsd, transcript_path AS transcriptPath`;

const INCIDENT_COLUMNS = `id, instance_id AS instanceId, node_id AS nodeId,
  reason, status, resolution`;

type RawInstanceRow = Omit<InstanceRow, 'dryRun'> & { dryRun: number };

function coerceInstance(row: RawInstanceRow): InstanceRow {
  return { ...row, dryRun: !!row.dryRun };
}

export class InstanceStore {
  private db: Database.Database;
  private emitter = new EventEmitter();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.emitter.setMaxListeners(0); // one listener per SSE connection
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
        definition_id TEXT,
        version_no INTEGER,
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
        task_execution_id INTEGER,
        created_at INTEGER NOT NULL,
        submitted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL REFERENCES instances(id),
        node_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        resolved_inputs TEXT NOT NULL,
        output TEXT,
        error TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        token_usage TEXT,
        cost_usd REAL,
        transcript_path TEXT
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
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_workspace
        ON instances(workspace_path)
        WHERE status IN ('running', 'incident') AND workspace_path != '';
    `);
    // Migration guard: DBs created before M4 lack the definition linkage columns.
    const cols = this.db.prepare(`PRAGMA table_info(instances)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'definition_id')) {
      this.db.exec(`ALTER TABLE instances ADD COLUMN definition_id TEXT;
                    ALTER TABLE instances ADD COLUMN version_no INTEGER;`);
    }
  }

  createInstance(
    id: string,
    name: string,
    source: string,
    opts: {
      workspace?: string;
      dryRun?: boolean;
      stubOverrides?: Record<string, Record<string, unknown>>;
      definitionId?: string;
      versionNo?: number;
    } = {},
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO instances
           (id, name, source, status, engine_state, workspace_path, dry_run, stub_overrides,
            definition_id, version_no, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        source,
        opts.workspace ?? '',
        opts.dryRun ? 1 : 0,
        opts.stubOverrides ? JSON.stringify(opts.stubOverrides) : null,
        opts.definitionId ?? null,
        opts.versionNo ?? null,
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
    const ts = Date.now();
    const result = this.db
      .prepare(`INSERT INTO events (instance_id, type, element_id, detail, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(instanceId, type, elementId ?? null, detail ?? null, ts);
    this.emitter.emit('event', {
      instanceId,
      seq: Number(result.lastInsertRowid),
      type,
      elementId: elementId ?? null,
      detail: detail ?? null,
      ts,
    });
  }

  /** Subscribe to appended events (SSE fan-out). Returns an unsubscribe function. */
  onEvent(listener: (event: EventRow & { instanceId: string }) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
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

  listInstances(): InstanceRow[] {
    return (
      this.db
        .prepare(`SELECT ${INSTANCE_COLUMNS} FROM instances ORDER BY created_at`)
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

  createUserTask(
    instanceId: string,
    nodeId: string,
    formSchema: string,
    taskExecutionId?: number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO user_tasks (instance_id, node_id, form_schema, status, task_execution_id, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(instanceId, nodeId, formSchema, taskExecutionId ?? null, Date.now());
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

  startTaskExecution(
    instanceId: string,
    nodeId: string,
    actor: 'agent' | 'code' | 'user',
    attempt: number,
    inputs: Record<string, unknown>,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO task_executions (instance_id, node_id, actor, attempt, resolved_inputs, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(instanceId, nodeId, actor, attempt, JSON.stringify(inputs), Date.now());
    return Number(result.lastInsertRowid);
  }

  finishTaskExecution(
    id: number,
    result: {
      status: 'completed' | 'failed';
      output?: unknown;
      error?: string;
      tokenUsage?: unknown;
      costUsd?: number;
      transcriptPath?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE task_executions
         SET status = ?, output = ?, error = ?, token_usage = ?, cost_usd = ?, transcript_path = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.output === undefined ? null : JSON.stringify(result.output),
        result.error ?? null,
        result.tokenUsage === undefined ? null : JSON.stringify(result.tokenUsage),
        result.costUsd ?? null,
        result.transcriptPath ?? null,
        Date.now(),
        id,
      );
  }

  getTaskExecution(id: number): TaskExecutionRow | undefined {
    return this.db
      .prepare(`SELECT ${TASK_EXECUTION_COLUMNS} FROM task_executions WHERE id = ?`)
      .get(id) as TaskExecutionRow | undefined;
  }

  listTaskExecutions(instanceId: string): TaskExecutionRow[] {
    return this.db
      .prepare(`SELECT ${TASK_EXECUTION_COLUMNS} FROM task_executions WHERE instance_id = ? ORDER BY id`)
      .all(instanceId) as TaskExecutionRow[];
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

  metricsForDefinition(definitionId: string): DefinitionMetrics {
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM instances WHERE definition_id = ? GROUP BY status`)
      .all(definitionId) as Array<{ status: InstanceStatus; n: number }>;
    const count = (s: InstanceStatus) => byStatus.find((r) => r.status === s)?.n ?? 0;
    const completed = count('completed');
    const terminated = count('terminated');
    const aborted = count('aborted');
    const error = count('error');
    const total = byStatus.reduce((sum, r) => sum + r.n, 0);
    const finished = completed + terminated + aborted + error;

    const durationsMs = (
      this.db
        .prepare(
          `SELECT updated_at - created_at AS d FROM instances
           WHERE definition_id = ? AND status IN ('completed', 'terminated') ORDER BY created_at`,
        )
        .all(definitionId) as Array<{ d: number }>
    ).map((r) => r.d);

    const costPerRun = this.db
      .prepare(
        `SELECT i.id AS instanceId, COALESCE(SUM(te.cost_usd), 0) AS costUsd
         FROM instances i LEFT JOIN task_executions te ON te.instance_id = i.id
         WHERE i.definition_id = ? GROUP BY i.id ORDER BY i.created_at`,
      )
      .all(definitionId) as Array<{ instanceId: string; costUsd: number }>;

    const costPerTask = this.db
      .prepare(
        `SELECT te.node_id AS nodeId, COUNT(*) AS runs,
                COALESCE(SUM(te.cost_usd), 0) AS totalCostUsd,
                AVG(te.ended_at - te.started_at) AS avgDurationMs
         FROM task_executions te JOIN instances i ON i.id = te.instance_id
         WHERE i.definition_id = ? AND te.status = 'completed'
         GROUP BY te.node_id ORDER BY te.node_id`,
      )
      .all(definitionId) as DefinitionMetrics['costPerTask'];

    const inc = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(inc.status = 'open'), 0) AS open
         FROM incidents inc JOIN instances i ON i.id = inc.instance_id
         WHERE i.definition_id = ?`,
      )
      .get(definitionId) as { total: number; open: number };

    return {
      runs: { total, completed, terminated, aborted, error, active: total - finished },
      successRate: finished === 0 ? null : (completed + terminated) / finished,
      durationsMs,
      costPerRun,
      costPerTask,
      incidents: inc,
    };
  }

  close(): void {
    this.db.close();
  }
}

export interface DefinitionMetrics {
  runs: { total: number; completed: number; terminated: number; aborted: number; error: number; active: number };
  /** (completed+terminated) / all finished runs; null when nothing finished yet. */
  successRate: number | null;
  /** Wall-clock duration of each successfully finished run (completed/terminated). */
  durationsMs: number[];
  costPerRun: Array<{ instanceId: string; costUsd: number }>;
  costPerTask: Array<{ nodeId: string; runs: number; totalCostUsd: number; avgDurationMs: number | null }>;
  incidents: { total: number; open: number };
}
