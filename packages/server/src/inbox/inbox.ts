import type { InstanceStore, UserTaskRow } from '../engine-host/store.js';
import type { EngineHost, UserTaskWaitInfo } from '../engine-host/engine-host.js';
import { type Notifier, DEFAULT_INBOX_LINK } from '../notify/notifier.js';
import { validateOutput } from '../runners/validate.js';

export class Inbox {
  constructor(
    private store: InstanceStore,
    private host: EngineHost,
    private notifier: Notifier,
    private inboxUrl: string = DEFAULT_INBOX_LINK,
  ) {}

  /** Wire as EngineHostOptions.onUserTaskWait. Idempotent across resumes. */
  handleWait(info: UserTaskWaitInfo): void {
    if (this.store.findPendingUserTask(info.instanceId, info.nodeId)) return;
    const taskExecutionId = this.store.startTaskExecution(info.instanceId, info.nodeId, 'user', 1, {});
    this.store.createUserTask(info.instanceId, info.nodeId, JSON.stringify(info.formSchema), taskExecutionId);
    this.store.appendEvent(info.instanceId, 'usertask.created', info.nodeId);
    void this.notifier.notify(
      'Flow Fabric: task waiting',
      `${info.nodeId} needs your input`,
      this.inboxUrl,
    );
  }

  listPending(): UserTaskRow[] {
    return this.store.listPendingUserTasks();
  }

  async submit(taskId: number, vars: Record<string, unknown>): Promise<void> {
    const task = this.store.getUserTask(taskId);
    if (!task || task.status !== 'pending') throw new Error(`no pending user task ${taskId}`);
    validateOutput(JSON.parse(task.formSchema), vars); // FR-13: validate before resuming
    this.host.signal(task.instanceId, task.nodeId, vars);
    this.store.submitUserTask(taskId, vars);
    this.store.appendEvent(task.instanceId, 'usertask.submitted', task.nodeId);
    if (task.taskExecutionId !== null) {
      this.store.finishTaskExecution(task.taskExecutionId, { status: 'completed', output: vars });
    }
  }
}
