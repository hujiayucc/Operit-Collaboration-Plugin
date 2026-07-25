declare namespace ToolPkg {
  type RuntimeKind = "main" | "ui" | "sandbox" | "provider";

  interface IpcCallOptions {
    targetRuntime?: RuntimeKind;
    targetContextKey?: string;
  }

  interface IpcApi {
    on<TPayload = unknown, TResult = unknown>(
      channel: string,
      handler: (payload: TPayload) => TResult | Promise<TResult>
    ): () => void;
    call<TPayload = unknown, TResult = unknown>(
      channel: string,
      payload?: TPayload,
      options?: IpcCallOptions
    ): Promise<TResult>;
  }

  interface AppLifecycleHookEvent {
    eventName: string;
  }

  interface AppLifecycleHookRegistration {
    id: string;
    event: "application_on_terminate";
    function: (event: AppLifecycleHookEvent) => unknown;
  }

  interface Registry {
    ipc: IpcApi;
    registerToolPromptComposeHook(definition: { id: string; function: (event: any) => unknown }): void;
    registerAppLifecycleHook(definition: AppLifecycleHookRegistration): void;
  }
}

declare const ToolPkg: ToolPkg.Registry;

declare const Java: {
  com: any;
  kotlin: any;
  type(name: string): any;
  getApplicationContext(): unknown;
};

declare function complete(value: unknown): void;
declare const exports: Record<string, unknown>;