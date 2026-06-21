export class WorkflowEntrypoint<Env = unknown> {
  protected env: Env;

  constructor(_ctx: ExecutionContext, env: Env) {
    this.env = env;
  }
}

export type WorkflowEvent<T> = {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
  workflowName: string;
};

export type WorkflowStep = {
  do<T>(
    name: string,
    callbackOrConfig: ((ctx: unknown) => Promise<T>) | unknown,
    callback?: (ctx: unknown) => Promise<T>,
  ): Promise<T>;
};
