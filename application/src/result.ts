import { createHash } from 'node:crypto';

export interface WorkflowResult {
  workflowID: string;
  input: string;
  activityAttempts: number;
  result: string;
}

export function deterministicResult(workflowID: string, input: string, activityAttempts: number): WorkflowResult {
  return {
    workflowID,
    input,
    activityAttempts,
    result: createHash('sha256').update(`${workflowID}:${input}`).digest('hex'),
  };
}
