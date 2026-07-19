import type {
  InstanceDto, InstanceDetailDto, InboxDto, DefinitionDto, VersionSummaryDto,
  SchedulerDto, DefinitionMetricsDto, LogsDto, LintReport,
} from '@flowfabric/shared';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { method: 'GET', ...init });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return req<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface StartInstanceBody {
  definitionId?: string;
  version?: number;
  source?: string;
  name?: string;
  workspacePath: string;
  dryRun?: boolean;
  inputs?: Record<string, unknown>;
  stubOverrides?: Record<string, Record<string, unknown>>;
}

export const api = {
  listInstances: () => req<{ instances: InstanceDto[] }>('/api/instances').then((r) => r.instances),
  getInstance: (id: string) => req<InstanceDetailDto>(`/api/instances/${id}`),
  startInstance: (body: StartInstanceBody) => post<{ id: string }>('/api/instances', body),
  abortInstance: (id: string) => post<void>(`/api/instances/${id}/abort`),

  getInbox: () => req<InboxDto>('/api/inbox'),
  submitUserTask: (id: number, vars: Record<string, unknown>) =>
    post<void>(`/api/user-tasks/${id}/submit`, { vars }),
  resolveIncident: (id: number, action: 'retry' | 'skip' | 'abort', output?: Record<string, unknown>) =>
    post<void>(`/api/incidents/${id}/resolve`, { action, output }),

  listDefinitions: () => req<{ definitions: DefinitionDto[] }>('/api/definitions').then((r) => r.definitions),
  uploadDefinition: (name: string, xml: string) => post<{ id: string; versionNo: number }>('/api/definitions', { name, xml }),
  listVersions: (id: string) => req<{ versions: VersionSummaryDto[] }>(`/api/definitions/${id}/versions`).then((r) => r.versions),
  getVersion: (id: string, v: number | 'latest') =>
    req<{ definitionId: string; versionNo: number; xml: string; lintReport: LintReport | null; deployable: boolean }>(
      `/api/definitions/${id}/versions/${v}`,
    ),
  lintVersion: (id: string, v: number | 'latest') => post<LintReport>(`/api/definitions/${id}/versions/${v}/lint`),

  startGrill: (definitionId: string) => post<{ sessionId: string; lint: LintReport }>('/api/grill/sessions', { definitionId }),
  getGrill: (sessionId: string) => req<{ sessionId: string; xml: string; lint: LintReport }>(`/api/grill/sessions/${sessionId}`),
  sendGrill: (sessionId: string, text: string) => post<{ accepted: boolean }>(`/api/grill/sessions/${sessionId}/messages`, { text }),
  saveGrillVersion: (sessionId: string) => post<{ versionNo: number; deployable: boolean }>(`/api/grill/sessions/${sessionId}/save-version`),

  metrics: (definitionId: string) => req<DefinitionMetricsDto>(`/api/metrics/definitions/${definitionId}`),
  scheduler: () => req<SchedulerDto>('/api/scheduler'),
  logs: (limit?: number) => req<LogsDto>(`/api/logs${limit ? `?limit=${limit}` : ''}`),
  transcript: (execId: number) => req<string>(`/api/task-executions/${execId}/transcript`),
};
