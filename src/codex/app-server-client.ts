import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";

import { ERROR_CODES } from "../errors/codes.js";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "symphony-ts",
  version: "0.1.0",
});

const DEFAULT_CAPABILITIES = Object.freeze({
  experimentalApi: true,
  requestAttestation: false,
});

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
const WINDOWS_SESSION_REQUEST_TIMEOUT_MS = 30_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_FORCE_KILL_GRACE_MS = 1_000;
const CLOSED_CHILDREN = new WeakSet<ChildProcess>();

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type CodexTurnStatus = "completed" | "failed" | "cancelled";

export interface CodexClientEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "approval_auto_approved"
    | "unsupported_tool_call"
    | "notification"
    | "other_message"
    | "malformed";
  timestamp: string;
  codexAppServerPid: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  usage?: CodexUsage;
  rateLimits?: Record<string, unknown> | null;
  errorCode?: string;
  message?: string;
  raw?: unknown;
  toolName?: string | null;
}

export interface CodexDynamicToolDefinition {
  namespace?: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  deferLoading?: boolean;
}

export interface CodexDynamicTool extends CodexDynamicToolDefinition {
  execute: (input: unknown) => Promise<object>;
}

export interface CodexAppServerClientOptions {
  command: string;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  clientInfo?: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
  tools?: CodexDynamicToolDefinition[];
  dynamicTools?: CodexDynamicTool[];
  maxLineBytes?: number;
  platform?: NodeJS.Platform;
  onEvent?: (event: CodexClientEvent) => void;
}

export interface CodexStartSessionInput {
  prompt: string;
  title: string;
}

export interface CodexCommandExecInput {
  command: string[];
  cwd: string;
  timeoutMs: number;
  outputBytesCap?: number;
  sandboxPolicy: unknown;
}

export interface CodexCommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function resolveCodexCommandExecRequestTimeoutMs(
  commandTimeoutMs: number,
  readTimeoutMs: number,
): number {
  return Math.max(readTimeoutMs, commandTimeoutMs + readTimeoutMs);
}

export function resolveCodexSessionRequestTimeoutMs(
  readTimeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32"
    ? Math.max(readTimeoutMs, WINDOWS_SESSION_REQUEST_TIMEOUT_MS)
    : readTimeoutMs;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  threadId: string;
  turnId: string;
  sessionId: string;
  usage: CodexUsage | null;
  rateLimits: Record<string, unknown> | null;
  message: string | null;
}

export class CodexAppServerClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexAppServerClientError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (message: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly resolve: (result: CodexTurnResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  stallTimer: NodeJS.Timeout | null;
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly sessionRequestTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private threadId: string | null = null;
  private currentTurn: ActiveTurn | null = null;
  private lastUsage: CodexUsage | null = null;
  private lastRateLimits: Record<string, unknown> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private stderrBuffer = "";
  private closed = false;
  private initialized = false;
  private dynamicTools: CodexDynamicTool[];

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.sessionRequestTimeoutMs = resolveCodexSessionRequestTimeoutMs(
      options.readTimeoutMs,
      options.platform,
    );
    this.dynamicTools = [...(options.dynamicTools ?? [])];
  }

  async startSession(input: CodexStartSessionInput): Promise<CodexTurnResult> {
    await this.ensureThreadStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "thread/start did not return a thread id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt: input.prompt,
      title: input.title,
    });
  }

  async continueTurn(prompt: string, title: string): Promise<CodexTurnResult> {
    await this.ensureThreadStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "Cannot continue a turn before a thread is started.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt,
      title,
    });
  }

  configureDynamicTools(dynamicTools: CodexDynamicTool[]): void {
    if (this.threadId !== null) {
      throw new CodexAppServerClientError(
        "Cannot configure dynamic tools after thread/start.",
        ERROR_CODES.codexProtocolError,
      );
    }

    this.dynamicTools = [...dynamicTools];
  }

  async execCommand(
    input: CodexCommandExecInput,
  ): Promise<CodexCommandExecResult> {
    await this.ensureInitialized();

    const response = await this.request(
      "command/exec",
      {
        command: [...input.command],
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        ...(input.outputBytesCap === undefined
          ? {}
          : { outputBytesCap: input.outputBytesCap }),
        sandboxPolicy: input.sandboxPolicy,
      },
      resolveCodexCommandExecRequestTimeoutMs(
        input.timeoutMs,
        this.options.readTimeoutMs,
      ),
    );

    const result = extractNestedObject(response, ["result"]);
    const exitCode = result?.exitCode;
    const stdout = result?.stdout;
    const stderr = result?.stderr;
    if (
      typeof exitCode !== "number" ||
      !Number.isInteger(exitCode) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string"
    ) {
      throw new CodexAppServerClientError(
        "command/exec returned an invalid response.",
        ERROR_CODES.codexProtocolError,
      );
    }

    return { exitCode, stdout, stderr };
  }

  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = this.closeInternal();
    }

    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.rejectPending(
      new CodexAppServerClientError(
        "Codex session closed.",
        ERROR_CODES.codexProtocolError,
      ),
    );

    if (this.currentTurn !== null) {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          "Codex session closed while a turn was running.",
          ERROR_CODES.codexProtocolError,
        ),
        "turn_ended_with_error",
      );
    }

    const child = this.child;
    this.initialized = false;
    this.threadId = null;
    if (child === null) {
      return;
    }

    await terminateChildProcess(child);
    if (this.child === child) {
      this.child = null;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.closed) {
      throw new CodexAppServerClientError(
        "Codex session is closed.",
        ERROR_CODES.codexProtocolError,
      );
    }

    if (this.child !== null && this.initialized) {
      return;
    }

    if (this.startPromise !== null) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async ensureThreadStarted(): Promise<void> {
    await this.ensureInitialized();
    if (this.threadId !== null) {
      return;
    }

    await this.startThread();
  }

  private async spawnAndInitialize(): Promise<void> {
    try {
      this.child = spawn("bash", ["-lc", this.options.command], {
        cwd: this.options.cwd,
        env: this.options.environment,
        stdio: "pipe",
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const wrapped = new CodexAppServerClientError(
        `Failed to launch Codex app-server: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      throw wrapped;
    }

    const child = this.child;
    child.once("close", () => {
      CLOSED_CHILDREN.add(child);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.handleStderrChunk(chunk);
    });
    child.on("error", (error) => {
      const wrapped = new CodexAppServerClientError(
        `Codex app-server process error: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      this.rejectPending(wrapped);
      if (this.currentTurn !== null) {
        this.finishTurnWithError(wrapped, "turn_ended_with_error");
      }
    });
    child.on("exit", (code, signal) => {
      this.flushStderrBuffer();
      const error = new CodexAppServerClientError(
        `Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`,
        ERROR_CODES.codexProtocolError,
      );
      this.rejectPending(error);
      if (this.currentTurn !== null) {
        this.finishTurnWithError(error, "turn_ended_with_error");
      }
      if (!this.closed && this.threadId === null) {
        this.emit({
          event: "startup_failed",
          errorCode: error.code,
          message: error.message,
        });
      }
      this.child = null;
      this.initialized = false;
    });

    try {
      await this.request(
        "initialize",
        {
          clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
          capabilities: {
            ...DEFAULT_CAPABILITIES,
            ...(this.options.capabilities ?? {}),
          },
        },
        this.sessionRequestTimeoutMs,
      );
      this.send({
        method: "initialized",
        params: {},
      });
      this.initialized = true;
    } catch (error) {
      const wrapped =
        error instanceof CodexAppServerClientError
          ? error
          : new CodexAppServerClientError(
              `Startup handshake failed: ${toErrorMessage(error)}`,
              ERROR_CODES.codexHandshakeFailed,
              { cause: error },
            );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      await this.close();
      throw wrapped;
    }
  }

  private async startThread(): Promise<void> {
    const threadResult = await this.request(
      "thread/start",
      {
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.threadSandbox,
        cwd: this.options.cwd,
        dynamicTools: this.getAdvertisedDynamicTools(),
      },
      this.sessionRequestTimeoutMs,
    );

    const threadId = extractNestedString(threadResult, [
      "result",
      "thread",
      "id",
    ]);
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "thread/start did not include result.thread.id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    this.threadId = threadId;
  }

  private async startTurn(input: {
    threadId: string;
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    if (this.currentTurn !== null) {
      throw new CodexAppServerClientError(
        "Only one turn can run at a time.",
        ERROR_CODES.codexProtocolError,
      );
    }

    const response = await this.request(
      "turn/start",
      {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
          },
        ],
        cwd: this.options.cwd,
        title: input.title,
        approvalPolicy: this.options.approvalPolicy,
        sandboxPolicy: this.options.turnSandboxPolicy,
      },
      this.sessionRequestTimeoutMs,
    );

    const turnId = extractNestedString(response, ["result", "turn", "id"]);
    if (turnId === null) {
      throw new CodexAppServerClientError(
        "turn/start did not include result.turn.id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    const sessionId = `${input.threadId}-${turnId}`;
    this.emit({
      event: "session_started",
      sessionId,
      threadId: input.threadId,
      turnId,
    });

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishTurnWithError(
          new CodexAppServerClientError(
            `Codex turn exceeded ${this.options.turnTimeoutMs}ms.`,
            ERROR_CODES.codexTurnTimeout,
          ),
          "turn_ended_with_error",
        );
      }, this.options.turnTimeoutMs);

      const activeTurn: ActiveTurn = {
        threadId: input.threadId,
        turnId,
        sessionId,
        resolve,
        reject,
        timeout,
        stallTimer: null,
      };

      this.currentTurn = activeTurn;
      this.bumpStallTimer(activeTurn);
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxLineBytes) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Codex stdout line exceeded the maximum buffered size.",
      });
      this.stdoutBuffer = "";
      return;
    }

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseJsonLine(line);
    if (parsed === null) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Received non-JSON stdout line from Codex app-server.",
        raw: line,
      });
      return;
    }

    const usage = extractUsage(parsed);
    if (usage !== null) {
      this.lastUsage = usage;
    }

    const rateLimits = extractRateLimits(parsed);
    if (rateLimits !== null) {
      this.lastRateLimits = rateLimits;
    }

    if (this.currentTurn !== null) {
      this.bumpStallTimer(this.currentTurn);
    }

    const responseId = normalizeJsonRpcId(parsed.id);
    const method = typeof parsed.method === "string" ? parsed.method : null;

    if (responseId !== null && !("method" in parsed)) {
      const pending = this.pendingRequests.get(responseId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(responseId);
        pending.resolve(parsed);
        return;
      }
    }

    if (isApprovalRequest(parsed, method)) {
      if (responseId !== null) {
        this.send({
          id: parsed.id,
          result: {
            approved: true,
          },
        });
      }
      this.emit({
        event: "approval_auto_approved",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    if (isToolCallRequest(parsed, method)) {
      const toolName = extractToolName(parsed);
      const toolNamespace = extractToolNamespace(parsed);
      const tool =
        toolName === null
          ? null
          : this.findDynamicTool(toolName, toolNamespace);
      if (tool !== null && responseId !== null) {
        void this.handleDynamicToolCall(parsed.id as JsonRpcId, tool, parsed);
        return;
      }

      if (responseId !== null) {
        this.send({
          id: parsed.id,
          result: {
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: `Unsupported tool call: ${toolName ?? "unknown"}`,
              },
            ],
          },
        });
      }
      this.emit({
        event: "unsupported_tool_call",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        toolName,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    if (isUserInputRequired(parsed, method)) {
      const error = new CodexAppServerClientError(
        "Codex requested operator input during a turn.",
        ERROR_CODES.codexUserInputRequired,
      );
      this.emit({
        event: "turn_input_required",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        errorCode: error.code,
        message: error.message,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      this.finishTurnWithError(error, "turn_ended_with_error");
      return;
    }

    if (method === "turn/completed") {
      this.completeTurn("completed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/failed") {
      this.completeTurn("failed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/cancelled") {
      this.completeTurn("cancelled", usage, rateLimits, parsed);
      return;
    }

    if (method !== null) {
      this.emit({
        event: "notification",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: method,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      raw: parsed,
      ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
    });
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.emit({
        event: "other_message",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: line,
        raw: {
          stream: "stderr",
          line,
        },
      });
    }
  }

  private flushStderrBuffer(): void {
    const line = this.stderrBuffer.trim();
    this.stderrBuffer = "";
    if (line.length === 0) {
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      message: line,
      raw: {
        stream: "stderr",
        line,
      },
    });
  }

  private completeTurn(
    status: CodexTurnStatus,
    usage: CodexUsage | null,
    rateLimits: Record<string, unknown> | null,
    raw: JsonObject,
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    const result: CodexTurnResult = {
      status,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      sessionId: activeTurn.sessionId,
      usage: usage ?? this.lastUsage,
      rateLimits: rateLimits ?? this.lastRateLimits,
      message: extractTurnMessage(raw),
    };

    this.emit({
      event:
        status === "completed"
          ? "turn_completed"
          : status === "failed"
            ? "turn_failed"
            : "turn_cancelled",
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      raw,
      ...(result.message === null ? {} : { message: result.message }),
      ...optionalTelemetry(result.usage, result.rateLimits),
    });

    activeTurn.resolve(result);
  }

  private finishTurnWithError(
    error: CodexAppServerClientError,
    event: "turn_ended_with_error",
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    this.emit({
      event,
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      errorCode: error.code,
      message: error.message,
      ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
    });

    activeTurn.reject(error);
  }

  private bumpStallTimer(activeTurn: ActiveTurn): void {
    clearTimeoutIfPresent(activeTurn.stallTimer);

    if (this.options.stallTimeoutMs <= 0) {
      activeTurn.stallTimer = null;
      return;
    }

    activeTurn.stallTimer = setTimeout(() => {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          `Codex session stalled for ${this.options.stallTimeoutMs}ms.`,
          ERROR_CODES.codexSessionStalled,
        ),
        "turn_ended_with_error",
      );
    }, this.options.stallTimeoutMs);
  }

  private request(
    method: string,
    params: JsonObject,
    timeoutMs = this.options.readTimeoutMs,
  ): Promise<JsonObject> {
    const id = this.nextRequestId++;

    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(
          new CodexAppServerClientError(
            `Timed out waiting for ${method} response after ${timeoutMs}ms.`,
            ERROR_CODES.codexReadTimeout,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        resolve,
        reject,
        timer,
      });

      this.send({
        id,
        method,
        params,
      });
    });
  }

  private send(message: JsonObject): void {
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      throw new CodexAppServerClientError(
        "Codex app-server process is not writable.",
        ERROR_CODES.codexProtocolError,
      );
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(
    input: Omit<CodexClientEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: new Date().toISOString(),
      codexAppServerPid:
        this.child?.pid === undefined ? null : String(this.child.pid),
    });
  }

  private get maxLineBytes(): number {
    return this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  private getAdvertisedDynamicTools(): CodexDynamicToolDefinition[] {
    const advertised = new Map<string, CodexDynamicToolDefinition>();

    for (const tool of this.options.tools ?? []) {
      advertised.set(dynamicToolKey(tool.name, tool.namespace ?? null), {
        ...normalizeDynamicToolDefinition(tool),
      });
    }

    for (const tool of this.dynamicTools) {
      advertised.set(dynamicToolKey(tool.name, tool.namespace ?? null), {
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        name: tool.name,
        description: tool.description ?? `Symphony dynamic tool ${tool.name}.`,
        inputSchema: tool.inputSchema ?? emptyObjectJsonSchema(),
        ...(tool.deferLoading === undefined
          ? {}
          : { deferLoading: tool.deferLoading }),
      });
    }

    return [...advertised.values()];
  }

  private findDynamicTool(
    name: string,
    namespace: string | null,
  ): CodexDynamicTool | null {
    return (
      this.dynamicTools.find(
        (tool) => tool.name === name && (tool.namespace ?? null) === namespace,
      ) ?? null
    );
  }

  private async handleDynamicToolCall(
    requestId: JsonRpcId,
    tool: CodexDynamicTool,
    message: JsonObject,
  ): Promise<void> {
    try {
      const result = await tool.execute(extractToolInput(message));
      this.send({
        id: requestId,
        result: normalizeDynamicToolCallResponse(result),
      });
    } catch (error) {
      this.send({
        id: requestId,
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `Dynamic tool ${tool.name} failed: ${toErrorMessage(error)}`,
            },
          ],
        },
      });
    }
  }
}

function parseJsonLine(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function normalizeJsonRpcId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function isApprovalRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (normalized.includes("approval")) {
    return true;
  }

  return containsStringValue(message, "approval");
}

function isToolCallRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (
    normalized.includes("tool/call") ||
    normalized.includes("item/tool/call") ||
    normalized.includes("tool_call")
  ) {
    return true;
  }

  return false;
}

function isUserInputRequired(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method !== null) {
    const normalized = method.toLowerCase();
    if (
      (normalized.includes("input") && normalized.includes("required")) ||
      (normalized.includes("user") && normalized.includes("input"))
    ) {
      return true;
    }
  }

  return containsStringValue(message, "user_input_required");
}

function extractToolName(message: JsonObject): string | null {
  const directNames = [
    extractNestedString(message, ["params", "toolName"]),
    extractNestedString(message, ["params", "name"]),
    extractNestedString(message, ["params", "tool"]),
    extractNestedString(message, ["params", "tool", "name"]),
    extractNestedString(message, ["name"]),
  ];

  return directNames.find((value) => value !== null) ?? null;
}

function extractToolNamespace(message: JsonObject): string | null {
  return (
    extractNestedString(message, ["params", "namespace"]) ??
    extractNestedString(message, ["params", "tool", "namespace"]) ??
    extractNestedString(message, ["namespace"])
  );
}

function extractToolInput(message: JsonObject): unknown {
  const params =
    message.params !== null &&
    typeof message.params === "object" &&
    !Array.isArray(message.params)
      ? (message.params as JsonObject)
      : null;

  if (params === null) {
    return undefined;
  }

  const candidates = [
    params.input,
    params.arguments,
    params.args,
    params.payload,
    params.toolInput,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeDynamicToolDefinition(
  tool: CodexDynamicToolDefinition,
): CodexDynamicToolDefinition {
  return {
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
    name: tool.name,
    description: tool.description ?? `Symphony dynamic tool ${tool.name}.`,
    inputSchema: tool.inputSchema ?? emptyObjectJsonSchema(),
    ...(tool.deferLoading === undefined
      ? {}
      : { deferLoading: tool.deferLoading }),
  };
}

function normalizeDynamicToolCallResponse(result: unknown): JsonObject {
  if (isDynamicToolCallResponse(result)) {
    return result;
  }

  const success =
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof (result as JsonObject).success === "boolean"
      ? Boolean((result as JsonObject).success)
      : true;

  return {
    success,
    contentItems: [
      {
        type: "inputText",
        text: stringifyDynamicToolResult(result),
      },
    ],
  };
}

function isDynamicToolCallResponse(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const object = value as JsonObject;
  return (
    typeof object.success === "boolean" &&
    Array.isArray(object.contentItems) &&
    object.contentItems.every(isDynamicToolContentItem)
  );
}

function isDynamicToolContentItem(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const object = value as JsonObject;
  return (
    (object.type === "inputText" && typeof object.text === "string") ||
    (object.type === "inputImage" && typeof object.imageUrl === "string")
  );
}

function stringifyDynamicToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function emptyObjectJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
  };
}

function dynamicToolKey(name: string, namespace: string | null): string {
  return namespace === null ? name : `${namespace}/${name}`;
}

function extractUsage(message: JsonObject): CodexUsage | null {
  for (const candidate of walkObjects(message)) {
    const usage = coerceUsage(candidate);
    if (usage !== null) {
      return usage;
    }
  }
  return null;
}

function coerceUsage(value: JsonObject): CodexUsage | null {
  const aliases = [
    ["inputTokens", "outputTokens", "totalTokens"],
    ["input_tokens", "output_tokens", "total_tokens"],
    ["input", "output", "total"],
  ] as const;

  for (const [inputKey, outputKey, totalKey] of aliases) {
    const input = asFiniteNumber(value[inputKey]);
    const output = asFiniteNumber(value[outputKey]);
    const total = asFiniteNumber(value[totalKey]);
    if (input !== null && output !== null && total !== null) {
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
      };
    }
  }

  if ("total_token_usage" in value) {
    const nested = value.total_token_usage;
    if (
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      return coerceUsage(nested as JsonObject);
    }
  }

  return null;
}

function extractRateLimits(
  message: JsonObject,
): Record<string, unknown> | null {
  for (const candidate of walkObjects(message)) {
    if ("rateLimits" in candidate) {
      const nested = candidate.rateLimits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
    if ("rate_limits" in candidate) {
      const nested = candidate.rate_limits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return null;
}

function extractTurnMessage(message: JsonObject): string | null {
  const direct = [
    extractNestedString(message, ["params", "message"]),
    extractNestedString(message, ["params", "summary"]),
    extractNestedString(message, ["result", "message"]),
    extractNestedString(message, ["message"]),
  ];

  return direct.find((value) => value !== null) ?? null;
}

function extractNestedString(
  source: JsonObject,
  path: readonly string[],
): string | null {
  let current: unknown = source;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as JsonObject)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function extractNestedObject(
  source: JsonObject,
  path: readonly string[],
): JsonObject | null {
  let current: unknown = source;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as JsonObject)[segment];
  }

  return current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
    ? (current as JsonObject)
    : null;
}

function* walkObjects(value: unknown): Generator<JsonObject> {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* walkObjects(entry);
    }
    return;
  }

  const objectValue = value as JsonObject;
  yield objectValue;
  for (const nested of Object.values(objectValue)) {
    yield* walkObjects(nested);
  }
}

function containsStringValue(value: unknown, expected: string): boolean {
  const target = expected.toLowerCase();
  if (typeof value === "string") {
    return value.toLowerCase().includes(target);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsStringValue(entry, expected));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) =>
      containsStringValue(entry, expected),
    );
  }
  return false;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clearTimeoutIfPresent(timer: NodeJS.Timeout | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (
    CLOSED_CHILDREN.has(child) &&
    (process.platform === "win32" ||
      pid === undefined ||
      !isUnixProcessGroupAlive(pid))
  ) {
    return;
  }

  try {
    child.stdin?.end();
  } catch {
    // Fall through to process termination.
  }
  const closedAfterInput = await waitForChildClose(
    child,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (
    closedAfterInput &&
    (process.platform === "win32" ||
      pid === undefined ||
      !isUnixProcessGroupAlive(pid))
  ) {
    return;
  }

  if (process.platform === "win32") {
    const treeTerminated = await terminateWindowsProcessTree(child);
    if (!treeTerminated) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child may already have exited.
      }
    }
    await waitForChildClose(child, PROCESS_FORCE_KILL_GRACE_MS);
    return;
  }

  signalUnixProcessTree(child, "SIGTERM");
  const childDidCloseAfterTerm = await waitForChildClose(
    child,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (
    childDidCloseAfterTerm &&
    (pid === undefined || !isUnixProcessGroupAlive(pid))
  ) {
    return;
  }

  signalUnixProcessTree(child, "SIGKILL");
  await waitForChildClose(child, PROCESS_FORCE_KILL_GRACE_MS);
}

function isUnixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (CLOSED_CHILDREN.has(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => {
      finish(true);
    };
    const timeoutHandle = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    child.once("close", onClose);
    if (CLOSED_CHILDREN.has(child)) {
      finish(true);
    }
  });
}

function signalUnixProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to signalling the direct child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the close request and the signal.
  }
}

function terminateWindowsProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (terminated: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve(terminated);
    };
    let taskkill: ChildProcess;
    try {
      taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }

    const timeoutHandle = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The helper may already have exited.
      }
      finish(false);
    }, PROCESS_FORCE_KILL_GRACE_MS);
    taskkill.once("error", () => {
      finish(false);
    });
    taskkill.once("close", (exitCode) => {
      finish(exitCode === 0);
    });
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function optionalTelemetry(
  usage: CodexUsage | null,
  rateLimits: Record<string, unknown> | null,
): Partial<Pick<CodexClientEvent, "usage" | "rateLimits">> {
  return {
    ...(usage === null ? {} : { usage }),
    ...(rateLimits === null ? {} : { rateLimits }),
  };
}
