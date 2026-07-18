export interface InputDecl {
  name: string;
  type: string;
}

export interface AgentTaskContract {
  kind: 'agent';
  retries: number;
  timeoutSeconds: number;
  prompt: string;
  tools: string[];
  boundaries?: string;
  inputs: InputDecl[];
  outputSchema: Record<string, unknown>;
}

export interface CodeTaskContract {
  kind: 'code';
  retries: number;
  timeoutSeconds: number;
  command: string;
  inputs: InputDecl[];
  outputSchema: Record<string, unknown>;
}

export interface UserTaskContract {
  kind: 'user';
  formSchema: Record<string, unknown>;
}

export type TaskContract = AgentTaskContract | CodeTaskContract | UserTaskContract;
