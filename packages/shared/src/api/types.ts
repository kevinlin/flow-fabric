export type InstanceStatusDto =
  | 'running' | 'completed' | 'terminated' | 'stopped' | 'error' | 'incident' | 'aborted';

export interface InstanceDto {
  id: string;
  name: string;
  status: InstanceStatusDto;
  workspace: string;
  dryRun: boolean;
  definitionId: string | null;
  versionNo: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineEntryDto {
  id: number;
  nodeId: string;
  actor: 'agent' | 'code' | 'user';
  attempt: number;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  endedAt: number | null;
  resolvedInputs: string;
  output: string | null;
  error: string | null;
  costUsd: number | null;
  tokenUsage: string | null;
  transcriptPath: string | null;
}

export interface EventDto {
  seq: number;
  type: string;
  elementId: string | null;
  detail: string | null;
  ts: number;
}

export interface InstanceDetailDto {
  instance: InstanceDto;
  timeline: TimelineEntryDto[];
  events: EventDto[];
}

export interface UserTaskDto {
  id: number;
  instanceId: string;
  nodeId: string;
  formSchema: string;
  status: 'pending' | 'submitted';
}

export interface IncidentDto {
  id: number;
  instanceId: string;
  nodeId: string;
  reason: string;
  status: 'open' | 'resolved';
}

export interface InboxDto {
  userTasks: UserTaskDto[];
  incidents: IncidentDto[];
}

export interface DefinitionDto {
  id: string;
  name: string;
  createdAt: number;
}

export interface VersionSummaryDto {
  versionNo: number;
  deployable: boolean;
  createdAt: number;
}

export interface ArmedTimerDto {
  instanceId: string;
  nodeId: string;
  expireAt: number;
}

export interface SchedulerDto {
  timers: ArmedTimerDto[];
}

export interface DefinitionMetricsDto {
  runs: { total: number; completed: number; terminated: number; aborted: number; error: number; active: number };
  successRate: number | null;
  durationsMs: number[];
  costPerRun: Array<{ instanceId: string; costUsd: number }>;
  costPerTask: Array<{ nodeId: string; runs: number; totalCostUsd: number; avgDurationMs: number | null }>;
  incidents: { total: number; open: number };
}

export interface LogsDto {
  lines: string[];
}
