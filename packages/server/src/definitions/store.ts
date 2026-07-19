import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { LintReport } from '@flowfabric/shared';

export interface DefinitionRow {
  id: string;
  name: string;
  createdAt: number;
}

export interface DefinitionVersionRow {
  definitionId: string;
  versionNo: number;
  xml: string;
  lintReport: LintReport | null;
  deployable: boolean;
  createdAt: number;
}

const VERSION_COLUMNS = `definition_id AS definitionId, version_no AS versionNo,
  xml, lint_report AS lintReport, deployable, created_at AS createdAt`;

type RawVersion = Omit<DefinitionVersionRow, 'lintReport' | 'deployable'> & {
  lintReport: string | null;
  deployable: number;
};

function coerce(row: RawVersion): DefinitionVersionRow {
  return {
    ...row,
    lintReport: row.lintReport ? (JSON.parse(row.lintReport) as LintReport) : null,
    deployable: !!row.deployable,
  };
}

/** BPMN file store: immutable versions, deployable flag (design §3, FR-4). */
export class DefinitionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS definition_versions (
        definition_id TEXT NOT NULL REFERENCES definitions(id),
        version_no INTEGER NOT NULL,
        xml TEXT NOT NULL,
        lint_report TEXT,
        deployable INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (definition_id, version_no)
      );
    `);
  }

  upload(name: string, xml: string): { id: string; versionNo: number } {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO definitions (id, name, created_at) VALUES (?, ?, ?)`)
      .run(id, name, Date.now());
    return { id, versionNo: this.saveVersion(id, xml) };
  }

  /** Appends the next version. Versions are immutable: xml is never updated (FR-4). */
  saveVersion(definitionId: string, xml: string, lintReport?: LintReport): number {
    if (!this.getDefinition(definitionId)) throw new Error(`no definition ${definitionId}`);
    const { next } = this.db
      .prepare(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next
         FROM definition_versions WHERE definition_id = ?`,
      )
      .get(definitionId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO definition_versions
           (definition_id, version_no, xml, lint_report, deployable, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definitionId,
        next,
        xml,
        lintReport ? JSON.stringify(lintReport) : null,
        lintReport?.deployable ? 1 : 0,
        Date.now(),
      );
    return next;
  }

  /** Records a lint run against an existing version (report only; xml stays immutable). */
  setLintReport(definitionId: string, versionNo: number, report: LintReport): void {
    const result = this.db
      .prepare(
        `UPDATE definition_versions SET lint_report = ?, deployable = ?
         WHERE definition_id = ? AND version_no = ?`,
      )
      .run(JSON.stringify(report), report.deployable ? 1 : 0, definitionId, versionNo);
    if (result.changes === 0) throw new Error(`no version ${versionNo} of ${definitionId}`);
  }

  getDefinition(id: string): DefinitionRow | undefined {
    return this.db
      .prepare(`SELECT id, name, created_at AS createdAt FROM definitions WHERE id = ?`)
      .get(id) as DefinitionRow | undefined;
  }

  listDefinitions(): DefinitionRow[] {
    return this.db
      .prepare(`SELECT id, name, created_at AS createdAt FROM definitions ORDER BY created_at`)
      .all() as DefinitionRow[];
  }

  getVersion(definitionId: string, versionNo: number): DefinitionVersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM definition_versions
         WHERE definition_id = ? AND version_no = ?`,
      )
      .get(definitionId, versionNo) as RawVersion | undefined;
    return row ? coerce(row) : undefined;
  }

  listVersions(definitionId: string): Array<{ versionNo: number; deployable: boolean; createdAt: number }> {
    return (
      this.db
        .prepare(
          `SELECT version_no AS versionNo, deployable, created_at AS createdAt
           FROM definition_versions WHERE definition_id = ? ORDER BY version_no`,
        )
        .all(definitionId) as Array<{ versionNo: number; deployable: number; createdAt: number }>
    ).map((r) => ({ versionNo: r.versionNo, deployable: !!r.deployable, createdAt: r.createdAt }));
  }

  getLatestVersion(definitionId: string): DefinitionVersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM definition_versions
         WHERE definition_id = ? ORDER BY version_no DESC LIMIT 1`,
      )
      .get(definitionId) as RawVersion | undefined;
    return row ? coerce(row) : undefined;
  }

  /**
   * Deletes a definition and all its versions.
   * Refuses if any instance references this definition (409-style guard).
   */
  delete(id: string): void {
    if (!this.getDefinition(id)) throw new DefinitionNotFoundError(id);
    const hasTable = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='instances'`)
      .get();
    if (hasTable) {
      const { count } = this.db
        .prepare(`SELECT COUNT(*) AS count FROM instances WHERE definition_id = ?`)
        .get(id) as { count: number };
      if (count > 0) throw new DefinitionInUseError(id, count);
    }
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM definition_versions WHERE definition_id = ?`).run(id);
      this.db.prepare(`DELETE FROM definitions WHERE id = ?`).run(id);
    })();
  }

  close(): void {
    this.db.close();
  }
}

export class DefinitionNotFoundError extends Error {
  constructor(id: string) { super(`no definition ${id}`); this.name = 'DefinitionNotFoundError'; }
}

export class DefinitionInUseError extends Error {
  constructor(id: string, public readonly instanceCount: number) {
    super(`definition ${id} has ${instanceCount} linked instance(s); delete them first`);
    this.name = 'DefinitionInUseError';
  }
}
