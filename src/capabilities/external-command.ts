import { randomBytes } from "node:crypto";

import type {
  CodexCommandExecInput,
  CodexCommandExecResult,
} from "../codex/app-server-client.js";
import type {
  ResolvedWorkflowConfig,
  WorkflowCommandCapabilities,
  WorkflowCommandHook,
} from "../config/types.js";
import { ERROR_CODES } from "../errors/codes.js";

const CAPABILITY = "external_command";
const MARKER_PREFIX = "__SYMPHONY_REQUIRED_COMMAND_V1__";
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const WINDOWS_PROBE_TIMEOUT_MS = 60_000;
const SAFE_EXECUTABLE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const EXTERNAL_COMMAND_OUTPUT_BYTES_CAP = 64 * 1024;

export type ExternalCommandBoundary =
  | "hook:after_create"
  | "hook:before_run"
  | "hook:after_run"
  | "hook:before_remove"
  | "agent";

export interface CapabilityFailureMetadata {
  code: string;
  capability: string;
  command: string;
  boundary: ExternalCommandBoundary;
  remediation: string;
}

export interface ExternalCommandExecutor {
  execCommand(input: CodexCommandExecInput): Promise<CodexCommandExecResult>;
}

export interface ExternalCommandProbeInput {
  command: string;
  probeArgs: readonly string[];
  workspacePath: string;
  sandboxPolicy: unknown;
  executor: ExternalCommandExecutor;
}

export interface ExternalCommandProbeResult {
  command: string;
  boundary: "agent";
}

export interface ExternalCommandProbe {
  probe(input: ExternalCommandProbeInput): Promise<ExternalCommandProbeResult>;
}

export interface HookCommandPreflight {
  nonce: string;
  commandNames: readonly string[];
  successMarker: string;
  scriptPrefix: string;
  boundary: Exclude<ExternalCommandBoundary, "agent">;
}

export class ExternalCommandCapabilityError extends Error {
  readonly code: string;
  readonly capability = CAPABILITY;
  readonly command: string;
  readonly boundary: ExternalCommandBoundary;
  readonly remediation: string;
  readonly deterministic: boolean;
  readonly capabilityFailure: CapabilityFailureMetadata;

  constructor(input: {
    code:
      | typeof ERROR_CODES.requiredCommandNotFound
      | typeof ERROR_CODES.requiredCommandExecutionDenied
      | typeof ERROR_CODES.requiredCommandCapabilityTransient;
    command: string;
    boundary: ExternalCommandBoundary;
  }) {
    const remediation = remediationFor(
      input.code,
      input.command,
      input.boundary,
    );
    super(messageFor(input.code, input.command, input.boundary));
    this.name = "ExternalCommandCapabilityError";
    this.code = input.code;
    this.command = input.command;
    this.boundary = input.boundary;
    this.remediation = remediation;
    this.deterministic = isDeterministicCapabilityErrorCode(input.code);
    this.capabilityFailure = {
      code: input.code,
      capability: this.capability,
      command: input.command,
      boundary: input.boundary,
      remediation,
    };
  }
}

export class CodexExternalCommandProbe implements ExternalCommandProbe {
  readonly #platform: NodeJS.Platform;

  constructor(options: { platform?: NodeJS.Platform } = {}) {
    this.#platform = options.platform ?? process.platform;
  }

  async probe(
    input: ExternalCommandProbeInput,
  ): Promise<ExternalCommandProbeResult> {
    const executable = resolveExternalCommandExecutable(
      input.command,
      this.#platform,
    );

    let result: CodexCommandExecResult;
    try {
      result = await input.executor.execCommand({
        command: [executable, ...input.probeArgs],
        cwd: input.workspacePath,
        timeoutMs: resolveExternalCommandProbeTimeoutMs(this.#platform),
        ...(this.#platform === "win32"
          ? {}
          : { outputBytesCap: EXTERNAL_COMMAND_OUTPUT_BYTES_CAP }),
        sandboxPolicy: input.sandboxPolicy,
      });
    } catch (error) {
      throw capabilityError(
        classifyRejectedCommand(error),
        input.command,
        "agent",
      );
    }

    if (result.exitCode !== 0) {
      throw capabilityError(
        classifyCommandResult(result),
        input.command,
        "agent",
      );
    }

    return {
      command: input.command,
      boundary: "agent",
    };
  }
}

export function resolveExternalCommandProbeTimeoutMs(
  platform: NodeJS.Platform,
): number {
  return platform === "win32"
    ? WINDOWS_PROBE_TIMEOUT_MS
    : DEFAULT_PROBE_TIMEOUT_MS;
}

export function resolveExternalCommandExecutable(
  command: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32" && !command.includes(".")
    ? `${command}.exe`
    : command;
}

export function isSafeExecutableBasename(command: string): boolean {
  return (
    command !== "." &&
    command !== ".." &&
    SAFE_EXECUTABLE_BASENAME.test(command)
  );
}

export function createHookCommandPreflight(input: {
  hook: WorkflowCommandHook;
  commands: WorkflowCommandCapabilities;
  nonce?: string;
  platform?: NodeJS.Platform;
}): HookCommandPreflight | null {
  const commandNames = Object.entries(input.commands)
    .filter(([, requirement]) => requirement.hooks.includes(input.hook))
    .map(([command]) => command);
  if (commandNames.length === 0) {
    return null;
  }

  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const boundary = hookBoundary(input.hook);
  const windows = (input.platform ?? process.platform) === "win32";
  const checks = commandNames
    .map((command) => buildShellCommandCheck(command, nonce))
    .join("\n");
  const windowsDeniedCheck = windows
    ? [
        '    if [ -e "$__symphony_dir/$__symphony_name.exe" ] && [ ! -x "$__symphony_dir/$__symphony_name.exe" ]; then',
        "      __symphony_denied=1",
        "    fi",
      ]
    : [];
  const scriptPrefix = [
    "__symphony_had_noglob=0",
    'case "$-" in *f*) __symphony_had_noglob=1 ;; esac',
    "set -f",
    "__symphony_required_command_check() {",
    "  __symphony_name=$1",
    '  if command -v "$__symphony_name" >/dev/null 2>&1; then',
    "    return 0",
    "  fi",
    "  __symphony_denied=0",
    "  __symphony_path_rest=${PATH-}",
    "  while :; do",
    '    case "$__symphony_path_rest" in',
    "      *:*) __symphony_dir=${__symphony_path_rest%%:*}; __symphony_path_rest=${__symphony_path_rest#*:} ;;",
    "      *) __symphony_dir=$__symphony_path_rest; __symphony_path_rest=; __symphony_last=1 ;;",
    "    esac",
    '    [ -n "$__symphony_dir" ] || __symphony_dir=.',
    '    if [ -e "$__symphony_dir/$__symphony_name" ] && [ ! -x "$__symphony_dir/$__symphony_name" ]; then',
    "      __symphony_denied=1",
    "    fi",
    ...windowsDeniedCheck,
    '    [ "${__symphony_last-0}" = 1 ] && break',
    "  done",
    "  unset __symphony_last",
    '  [ "$__symphony_denied" = 1 ] && return 126',
    "  return 127",
    "}",
    checks,
    '[ "$__symphony_had_noglob" = 1 ] || set +f',
    "unset -f __symphony_required_command_check 2>/dev/null || :",
    "unset __symphony_name __symphony_denied __symphony_path_rest __symphony_dir __symphony_status __symphony_last __symphony_had_noglob",
    `printf '%s\\n' '${MARKER_PREFIX}:${nonce}:ok'`,
  ].join("\n");

  return {
    nonce,
    commandNames,
    successMarker: `${MARKER_PREFIX}:${nonce}:ok`,
    scriptPrefix,
    boundary,
  };
}

export function classifyHookCommandPreflightResult(input: {
  preflight: HookCommandPreflight;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): {
  error: ExternalCommandCapabilityError | null;
  successSeen: boolean;
  stdout: string;
  stderr: string;
} {
  const combined = `${input.stdout}\n${input.stderr}`;
  const successIndex = findExactMarkerLineIndex(
    combined,
    input.preflight.successMarker,
  );
  const failure = findValidFailureMarker(
    combined,
    input.preflight,
    input.exitCode,
    successIndex,
  );
  const stdout = stripOwnedMarkers(input.stdout, input.preflight.nonce);
  const stderr = stripOwnedMarkers(input.stderr, input.preflight.nonce);

  if (failure !== null) {
    return {
      error: capabilityError(
        failure.code,
        failure.command,
        input.preflight.boundary,
      ),
      successSeen: false,
      stdout,
      stderr,
    };
  }

  if (successIndex >= 0) {
    return {
      error: null,
      successSeen: true,
      stdout,
      stderr,
    };
  }

  return {
    error: capabilityError(
      ERROR_CODES.requiredCommandCapabilityTransient,
      input.preflight.commandNames[0] ?? "unknown",
      input.preflight.boundary,
    ),
    successSeen: false,
    stdout: "",
    stderr: "",
  };
}

export function isDeterministicCapabilityErrorCode(
  code: string | undefined,
): boolean {
  return (
    code === ERROR_CODES.requiredCommandNotFound ||
    code === ERROR_CODES.requiredCommandExecutionDenied ||
    code === ERROR_CODES.githubCliNotFound ||
    code === ERROR_CODES.githubAuthInvalid ||
    code === ERROR_CODES.githubPermissionDenied
  );
}

export function isCapabilityErrorCode(code: string | undefined): boolean {
  return (
    isDeterministicCapabilityErrorCode(code) ||
    code === ERROR_CODES.requiredCommandCapabilityTransient ||
    code === ERROR_CODES.githubCapabilityTransient
  );
}

export function getCommandCapabilities(
  config: Pick<ResolvedWorkflowConfig, "capabilities">,
): WorkflowCommandCapabilities {
  return config.capabilities.commands ?? {};
}

export function requiresPredispatchCapability(
  config: Pick<ResolvedWorkflowConfig, "capabilities">,
): boolean {
  if (config.capabilities.github.required) {
    return true;
  }

  return Object.values(getCommandCapabilities(config)).some(
    (requirement) =>
      requirement.agent ||
      requirement.hooks.includes("afterCreate") ||
      requirement.hooks.includes("beforeRun"),
  );
}

function buildShellCommandCheck(command: string, nonce: string): string {
  return [
    `__symphony_required_command_check '${command}'`,
    "__symphony_status=$?",
    'if [ "$__symphony_status" -eq 126 ]; then',
    '[ "$__symphony_had_noglob" = 1 ] || set +f',
    `  printf '%s\\n' '${MARKER_PREFIX}:${nonce}:${ERROR_CODES.requiredCommandExecutionDenied}:${command}'`,
    "  exit 126",
    "fi",
    'if [ "$__symphony_status" -eq 127 ]; then',
    '[ "$__symphony_had_noglob" = 1 ] || set +f',
    `  printf '%s\\n' '${MARKER_PREFIX}:${nonce}:${ERROR_CODES.requiredCommandNotFound}:${command}'`,
    "  exit 127",
    "fi",
  ].join("\n");
}

function findValidFailureMarker(
  output: string,
  preflight: HookCommandPreflight,
  exitCode: number | null,
  successIndex: number,
): {
  code:
    | typeof ERROR_CODES.requiredCommandNotFound
    | typeof ERROR_CODES.requiredCommandExecutionDenied;
  command: string;
} | null {
  const codes = [
    ERROR_CODES.requiredCommandNotFound,
    ERROR_CODES.requiredCommandExecutionDenied,
  ] as const;
  for (const command of preflight.commandNames) {
    for (const code of codes) {
      const marker = `${MARKER_PREFIX}:${preflight.nonce}:${code}:${command}`;
      const markerIndex = findExactMarkerLineIndex(output, marker);
      const expectedExitCode =
        code === ERROR_CODES.requiredCommandExecutionDenied ? 126 : 127;
      if (
        markerIndex >= 0 &&
        (successIndex < 0 || markerIndex < successIndex) &&
        exitCode === expectedExitCode
      ) {
        return { code, command };
      }
    }
  }

  return null;
}

function findExactMarkerLineIndex(output: string, marker: string): number {
  let fromIndex = 0;
  while (fromIndex <= output.length) {
    const markerIndex = output.indexOf(marker, fromIndex);
    if (markerIndex < 0) {
      return -1;
    }

    const before = markerIndex === 0 ? undefined : output[markerIndex - 1];
    const after = output[markerIndex + marker.length];
    if (
      (before === undefined || before === "\n" || before === "\r") &&
      (after === undefined || after === "\n" || after === "\r")
    ) {
      return markerIndex;
    }

    fromIndex = markerIndex + marker.length;
  }

  return -1;
}

function stripOwnedMarkers(value: string, nonce: string): string {
  const ownedPrefix = `${MARKER_PREFIX}:${nonce}:`;
  return value
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(ownedPrefix))
    .join("\n")
    .replace(/\n$/, "");
}

function classifyCommandResult(
  result: CodexCommandExecResult,
):
  | typeof ERROR_CODES.requiredCommandNotFound
  | typeof ERROR_CODES.requiredCommandExecutionDenied
  | typeof ERROR_CODES.requiredCommandCapabilityTransient {
  const diagnostic = `${result.stdout}\n${result.stderr}`.slice(
    0,
    EXTERNAL_COMMAND_OUTPUT_BYTES_CAP * 2,
  );
  if (
    result.exitCode === 127 ||
    /command not found|not recognized as an internal or external command|no such file or directory|executable.*not found/i.test(
      diagnostic,
    )
  ) {
    return ERROR_CODES.requiredCommandNotFound;
  }
  if (
    result.exitCode === 126 ||
    /permission denied|access is denied|operation not permitted|EACCES|EPERM/i.test(
      diagnostic,
    )
  ) {
    return ERROR_CODES.requiredCommandExecutionDenied;
  }
  return ERROR_CODES.requiredCommandCapabilityTransient;
}

function classifyRejectedCommand(
  error: unknown,
):
  | typeof ERROR_CODES.requiredCommandNotFound
  | typeof ERROR_CODES.requiredCommandExecutionDenied
  | typeof ERROR_CODES.requiredCommandCapabilityTransient {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  if (code === "ENOENT") {
    return ERROR_CODES.requiredCommandNotFound;
  }
  if (code === "EACCES" || code === "EPERM") {
    return ERROR_CODES.requiredCommandExecutionDenied;
  }
  return ERROR_CODES.requiredCommandCapabilityTransient;
}

function capabilityError(
  code:
    | typeof ERROR_CODES.requiredCommandNotFound
    | typeof ERROR_CODES.requiredCommandExecutionDenied
    | typeof ERROR_CODES.requiredCommandCapabilityTransient,
  command: string,
  boundary: ExternalCommandBoundary,
): ExternalCommandCapabilityError {
  return new ExternalCommandCapabilityError({ code, command, boundary });
}

function hookBoundary(
  hook: WorkflowCommandHook,
): Exclude<ExternalCommandBoundary, "agent"> {
  switch (hook) {
    case "afterCreate":
      return "hook:after_create";
    case "beforeRun":
      return "hook:before_run";
    case "afterRun":
      return "hook:after_run";
    case "beforeRemove":
      return "hook:before_remove";
  }
}

function messageFor(
  code: string,
  command: string,
  boundary: ExternalCommandBoundary,
): string {
  if (code === ERROR_CODES.requiredCommandNotFound) {
    return `Required command '${command}' is not available in ${boundary}.`;
  }
  if (code === ERROR_CODES.requiredCommandExecutionDenied) {
    return `Required command '${command}' cannot execute in ${boundary}.`;
  }
  return `Required command '${command}' could not be verified in ${boundary}.`;
}

function remediationFor(
  code: string,
  command: string,
  boundary: ExternalCommandBoundary,
): string {
  if (code === ERROR_CODES.requiredCommandNotFound) {
    return `Install ${command} or expose it in ${boundary}, then explicitly retry the held issue.`;
  }
  if (code === ERROR_CODES.requiredCommandExecutionDenied) {
    return `Repair execute permissions or policy for ${command} in ${boundary}, then explicitly retry the held issue.`;
  }
  return `Retry the issue; if verification keeps failing, inspect the ${boundary} command boundary.`;
}
