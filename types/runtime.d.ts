declare namespace ToolPkg {
  type LocalizedText = import("./operit/toolpkg").ToolPkg.LocalizedText;
  type JsonPrimitive = import("./operit/toolpkg").ToolPkg.JsonPrimitive;
  type JsonValue = import("./operit/toolpkg").ToolPkg.JsonValue;
  type JsonObject = import("./operit/toolpkg").ToolPkg.JsonObject;
  type AppLifecycleEvent = import("./operit/toolpkg").ToolPkg.AppLifecycleEvent;
  type AppLifecycleHookReturn = import("./operit/toolpkg").ToolPkg.AppLifecycleHookReturn;
  type MessageProcessingHookObjectResult = import("./operit/toolpkg").ToolPkg.MessageProcessingHookObjectResult;
  type MessageProcessingHookReturnValue = import("./operit/toolpkg").ToolPkg.MessageProcessingHookReturnValue;
  type MessageProcessingHookReturn = import("./operit/toolpkg").ToolPkg.MessageProcessingHookReturn;
  type XmlRenderHookObjectResult = import("./operit/toolpkg").ToolPkg.XmlRenderHookObjectResult;
  type XmlRenderHookReturn = import("./operit/toolpkg").ToolPkg.XmlRenderHookReturn;
  type InputMenuToggleSlot = import("./operit/toolpkg").ToolPkg.InputMenuToggleSlot;
  type InputMenuToggleDefinitionResult = import("./operit/toolpkg").ToolPkg.InputMenuToggleDefinitionResult;
  type InputMenuToggleObjectResult = import("./operit/toolpkg").ToolPkg.InputMenuToggleObjectResult;
  type InputMenuToggleHookReturn = import("./operit/toolpkg").ToolPkg.InputMenuToggleHookReturn;
  type ChatInputHookObjectResult = import("./operit/toolpkg").ToolPkg.ChatInputHookObjectResult;
  type ChatInputHookReturn = import("./operit/toolpkg").ToolPkg.ChatInputHookReturn;
  type ToolLifecycleAllowResult = import("./operit/toolpkg").ToolPkg.ToolLifecycleAllowResult;
  type ToolLifecycleBlockResult = import("./operit/toolpkg").ToolPkg.ToolLifecycleBlockResult;
  type ToolLifecycleHookObjectResult = import("./operit/toolpkg").ToolPkg.ToolLifecycleHookObjectResult;
  type ToolLifecycleHookReturnValue = import("./operit/toolpkg").ToolPkg.ToolLifecycleHookReturnValue;
  type ToolLifecycleHookReturn = import("./operit/toolpkg").ToolPkg.ToolLifecycleHookReturn;
  type PromptInputHookReturn = import("./operit/toolpkg").ToolPkg.PromptInputHookReturn;
  type PromptHistoryHookReturn = import("./operit/toolpkg").ToolPkg.PromptHistoryHookReturn;
  type SystemPromptComposeHookReturn = import("./operit/toolpkg").ToolPkg.SystemPromptComposeHookReturn;
  type ToolPromptComposeHookReturn = import("./operit/toolpkg").ToolPkg.ToolPromptComposeHookReturn;
  type PromptFinalizeHookReturn = import("./operit/toolpkg").ToolPkg.PromptFinalizeHookReturn;
  type SummaryGenerateHookReturn = import("./operit/toolpkg").ToolPkg.SummaryGenerateHookReturn;
  type HookEventName = import("./operit/toolpkg").ToolPkg.HookEventName;
  type HookReturn = import("./operit/toolpkg").ToolPkg.HookReturn;
  type PromptTurnKind = import("./operit/toolpkg").ToolPkg.PromptTurnKind;
  type PromptTurn = import("./operit/toolpkg").ToolPkg.PromptTurn;
  type ToolPromptParameter = import("./operit/toolpkg").ToolPkg.ToolPromptParameter;
  type ToolPromptItem = import("./operit/toolpkg").ToolPkg.ToolPromptItem;
  type PromptHookObjectResult = import("./operit/toolpkg").ToolPkg.PromptHookObjectResult;
  type SummaryHookObjectResult = import("./operit/toolpkg").ToolPkg.SummaryHookObjectResult;
  type PromptHookEventPayload = import("./operit/toolpkg").ToolPkg.PromptHookEventPayload;
  type SummaryGenerateEventPayload = import("./operit/toolpkg").ToolPkg.SummaryGenerateEventPayload;
  type ToolLifecycleEventPayload = import("./operit/toolpkg").ToolPkg.ToolLifecycleEventPayload;
  type AppLifecycleEventPayload = import("./operit/toolpkg").ToolPkg.AppLifecycleEventPayload;
  type MessageProcessingEventPayload = import("./operit/toolpkg").ToolPkg.MessageProcessingEventPayload;
  type XmlRenderEventPayload = import("./operit/toolpkg").ToolPkg.XmlRenderEventPayload;
  type InputMenuToggleEventPayload = import("./operit/toolpkg").ToolPkg.InputMenuToggleEventPayload;
  type ChatInputEventPayload = import("./operit/toolpkg").ToolPkg.ChatInputEventPayload;
  type ChatViewEventPayload = import("./operit/toolpkg").ToolPkg.ChatViewEventPayload;
  type ChatMessageEventPayload = import("./operit/toolpkg").ToolPkg.ChatMessageEventPayload;
  type ToolLifecycleEventName = import("./operit/toolpkg").ToolPkg.ToolLifecycleEventName;
  type PromptInputEventName = import("./operit/toolpkg").ToolPkg.PromptInputEventName;
  type PromptHistoryEventName = import("./operit/toolpkg").ToolPkg.PromptHistoryEventName;
  type SystemPromptComposeEventName = import("./operit/toolpkg").ToolPkg.SystemPromptComposeEventName;
  type ToolPromptComposeEventName = import("./operit/toolpkg").ToolPkg.ToolPromptComposeEventName;
  type PromptFinalizeEventName = import("./operit/toolpkg").ToolPkg.PromptFinalizeEventName;
  type SummaryGenerateEventName = import("./operit/toolpkg").ToolPkg.SummaryGenerateEventName;
  type ChatInputEventName = import("./operit/toolpkg").ToolPkg.ChatInputEventName;
  type ChatViewEventName = import("./operit/toolpkg").ToolPkg.ChatViewEventName;
  type ChatMessageEventName = import("./operit/toolpkg").ToolPkg.ChatMessageEventName;
  type HookEventBase<TEventName extends string, TPayload extends JsonObject = JsonObject> =
    import("./operit/toolpkg").ToolPkg.HookEventBase<TEventName, TPayload>;
  type AppLifecycleHookEvent = import("./operit/toolpkg").ToolPkg.AppLifecycleHookEvent;
  type MessageProcessingHookEvent = import("./operit/toolpkg").ToolPkg.MessageProcessingHookEvent;
  type XmlRenderHookEvent = import("./operit/toolpkg").ToolPkg.XmlRenderHookEvent;
  type InputMenuToggleHookEvent = import("./operit/toolpkg").ToolPkg.InputMenuToggleHookEvent;
  type ChatInputHookEvent = import("./operit/toolpkg").ToolPkg.ChatInputHookEvent;
  type ChatViewHookEvent = import("./operit/toolpkg").ToolPkg.ChatViewHookEvent;
  type ChatMessageHookEvent = import("./operit/toolpkg").ToolPkg.ChatMessageHookEvent;
  type ToolLifecycleHookEvent = import("./operit/toolpkg").ToolPkg.ToolLifecycleHookEvent;
  type PromptInputHookEvent = import("./operit/toolpkg").ToolPkg.PromptInputHookEvent;
  type PromptHistoryHookEvent = import("./operit/toolpkg").ToolPkg.PromptHistoryHookEvent;
  type PromptEstimateHistoryHookEvent = import("./operit/toolpkg").ToolPkg.PromptEstimateHistoryHookEvent;
  type SystemPromptComposeHookEvent = import("./operit/toolpkg").ToolPkg.SystemPromptComposeHookEvent;
  type ToolPromptComposeHookEvent = import("./operit/toolpkg").ToolPkg.ToolPromptComposeHookEvent;
  type PromptFinalizeHookEvent = import("./operit/toolpkg").ToolPkg.PromptFinalizeHookEvent;
  type PromptEstimateFinalizeHookEvent = import("./operit/toolpkg").ToolPkg.PromptEstimateFinalizeHookEvent;
  type SummaryGenerateHookEvent = import("./operit/toolpkg").ToolPkg.SummaryGenerateHookEvent;
  type AppLifecycleHookRegistration = import("./operit/toolpkg").ToolPkg.AppLifecycleHookRegistration;
  type MessageProcessingPluginRegistration = import("./operit/toolpkg").ToolPkg.MessageProcessingPluginRegistration;
  type XmlRenderPluginRegistration = import("./operit/toolpkg").ToolPkg.XmlRenderPluginRegistration;
  type InputMenuTogglePluginRegistration = import("./operit/toolpkg").ToolPkg.InputMenuTogglePluginRegistration;
  type ChatInputHookRegistration = import("./operit/toolpkg").ToolPkg.ChatInputHookRegistration;
  type ChatViewHookRegistration = import("./operit/toolpkg").ToolPkg.ChatViewHookRegistration;
  type ChatMessageHookRegistration = import("./operit/toolpkg").ToolPkg.ChatMessageHookRegistration;
  type PromptInputHookRegistration = import("./operit/toolpkg").ToolPkg.PromptInputHookRegistration;
  type PromptHistoryHookRegistration = import("./operit/toolpkg").ToolPkg.PromptHistoryHookRegistration;
  type PromptEstimateHistoryHookRegistration = import("./operit/toolpkg").ToolPkg.PromptEstimateHistoryHookRegistration;
  type SystemPromptComposeHookRegistration = import("./operit/toolpkg").ToolPkg.SystemPromptComposeHookRegistration;
  type ToolPromptComposeHookRegistration = import("./operit/toolpkg").ToolPkg.ToolPromptComposeHookRegistration;
  type PromptFinalizeHookRegistration = import("./operit/toolpkg").ToolPkg.PromptFinalizeHookRegistration;
  type PromptEstimateFinalizeHookRegistration = import("./operit/toolpkg").ToolPkg.PromptEstimateFinalizeHookRegistration;
  type SummaryGenerateHookRegistration = import("./operit/toolpkg").ToolPkg.SummaryGenerateHookRegistration;
  type AiProviderConfig = import("./operit/toolpkg").ToolPkg.AiProviderConfig;
  type AiProviderRegistration = import("./operit/toolpkg").ToolPkg.AiProviderRegistration;
  type ToolboxUiModuleRegistration = import("./operit/toolpkg").ToolPkg.ToolboxUiModuleRegistration;
  type UiRouteRegistration = import("./operit/toolpkg").ToolPkg.UiRouteRegistration;
  type NavigationEntryRegistration = import("./operit/toolpkg").ToolPkg.NavigationEntryRegistration;
  type DesktopWidgetRegistration = import("./operit/toolpkg").ToolPkg.DesktopWidgetRegistration;
  type RuntimeKind = import("./operit/toolpkg").ToolPkg.RuntimeKind;
  type IpcMeta = import("./operit/toolpkg").ToolPkg.IpcMeta;
  type IpcCallOptions = import("./operit/toolpkg").ToolPkg.IpcCallOptions;
  type IpcApi = import("./operit/toolpkg").ToolPkg.IpcApi;
  type WasmValueType = import("./operit/toolpkg").ToolPkg.WasmValueType;
  type WasmArg = import("./operit/toolpkg").ToolPkg.WasmArg;
  type WasmResult = import("./operit/toolpkg").ToolPkg.WasmResult;
  type WasmCallResult = import("./operit/toolpkg").ToolPkg.WasmCallResult;
  type WasmApi = import("./operit/toolpkg").ToolPkg.WasmApi;
  type ComposeDslContext = Omit<import("./operit/compose-dsl").ComposeDslContext,
    "UI" | "getEnv" | "showToast"> & {
    UI: Record<string, (props?: Record<string, unknown>, children?: unknown) => ComposeNode>;
    getEnv?(key: string): unknown;
    showToast?(message: string): unknown;
    [key: string]: unknown;
  };
  type ComposeDslScreen = import("./operit/compose-dsl").ComposeDslScreen;
  type ComposeNode = import("./operit/compose-dsl").ComposeNode;

  interface ToolLifecycleHookRegistration {
    id: string;
    function: (event: ToolLifecycleHookEvent) => unknown;
  }

  interface Registry extends Omit<import("./operit/toolpkg").ToolPkg.Registry,
    "registerPromptHistoryHook" | "registerToolPromptComposeHook" | "registerToolLifecycleHook"> {
    registerPromptHistoryHook(definition: { id: string; function: (event: PromptHistoryHookEvent) => unknown }): void;
    registerToolPromptComposeHook(definition: { id: string; function: (event: ToolPromptComposeHookEvent) => unknown }): void;
    registerToolLifecycleHook(definition: ToolLifecycleHookRegistration): void;
  }
}

declare const ToolPkg: ToolPkg.Registry;

declare function registerToolPkgToolboxUiModule(definition: ToolPkg.ToolboxUiModuleRegistration): void;
declare function registerToolPkgUiRoute(definition: ToolPkg.UiRouteRegistration): void;
declare function registerToolPkgNavigationEntry(definition: ToolPkg.NavigationEntryRegistration): void;
declare function registerToolPkgDesktopWidget(definition: ToolPkg.DesktopWidgetRegistration): void;
declare function registerToolPkgAppLifecycleHook(definition: ToolPkg.AppLifecycleHookRegistration): void;
declare function registerToolPkgMessageProcessingPlugin(definition: ToolPkg.MessageProcessingPluginRegistration): void;
declare function registerToolPkgXmlRenderPlugin(definition: ToolPkg.XmlRenderPluginRegistration): void;
declare function registerToolPkgInputMenuTogglePlugin(definition: ToolPkg.InputMenuTogglePluginRegistration): void;
declare function registerToolPkgChatInputHook(definition: ToolPkg.ChatInputHookRegistration): void;
declare function registerToolPkgChatViewHook(definition: ToolPkg.ChatViewHookRegistration): void;
declare function registerToolPkgChatMessageHook(definition: ToolPkg.ChatMessageHookRegistration): void;
declare function registerToolPkgToolLifecycleHook(definition: ToolPkg.ToolLifecycleHookRegistration): void;
declare function registerToolPkgPromptInputHook(definition: ToolPkg.PromptInputHookRegistration): void;
declare function registerToolPkgPromptHistoryHook(definition: ToolPkg.PromptHistoryHookRegistration): void;
declare function registerToolPkgPromptEstimateHistoryHook(definition: ToolPkg.PromptEstimateHistoryHookRegistration): void;
declare function registerToolPkgSystemPromptComposeHook(definition: ToolPkg.SystemPromptComposeHookRegistration): void;
declare function registerToolPkgToolPromptComposeHook(definition: ToolPkg.ToolPromptComposeHookRegistration): void;
declare function registerToolPkgPromptFinalizeHook(definition: ToolPkg.PromptFinalizeHookRegistration): void;
declare function registerToolPkgPromptEstimateFinalizeHook(definition: ToolPkg.PromptEstimateFinalizeHookRegistration): void;
declare function registerToolPkgSummaryGenerateHook(definition: ToolPkg.SummaryGenerateHookRegistration): void;
declare function registerToolPkgAiProvider(definition: ToolPkg.AiProviderRegistration): void;

declare interface ToolParams extends import("./operit/core").ToolParams {}

declare const Java: {
  com: any;
  kotlin: any;
  type(name: string): any;
  getApplicationContext(): unknown;
};

declare function complete<T>(value: T): void;
declare function setTimeout(handler: () => void, timeoutMs?: number): unknown;
declare function clearTimeout(handle: unknown): void;