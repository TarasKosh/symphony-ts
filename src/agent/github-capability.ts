import type {
  CodexCommandExecInput,
  CodexCommandExecResult,
} from "../codex/app-server-client.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
  GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
  appendGithubDiagnostic,
  boundedGithubDiagnosticSource,
  safeGithubWorkspaceLabel,
} from "./github-diagnostic.js";

export {
  GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
  GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
};

const CAPABILITY = "github";
const DEFAULT_GITHUB_CAPABILITY_PROBE_TIMEOUT_MS = 15_000;
const WINDOWS_GITHUB_CAPABILITY_PROBE_TIMEOUT_MS = 60_000;
type GithubProbeStep = "identity" | "repository" | "permission";

export function resolveGithubCapabilityProbeTimeoutMs(
  platform: NodeJS.Platform,
): number {
  return platform === "win32"
    ? WINDOWS_GITHUB_CAPABILITY_PROBE_TIMEOUT_MS
    : DEFAULT_GITHUB_CAPABILITY_PROBE_TIMEOUT_MS;
}

export const GITHUB_CAPABILITY_PROBE_TIMEOUT_MS =
  resolveGithubCapabilityProbeTimeoutMs(process.platform);

export interface CapabilityCommandExecutor {
  execCommand(input: CodexCommandExecInput): Promise<CodexCommandExecResult>;
}

export interface GithubCapabilityProbeInput {
  workspacePath: string;
  sandboxPolicy: unknown;
  executor: CapabilityCommandExecutor;
}

export interface GithubCapabilityProbeResult {
  identity: string;
  repository: string;
  canPush: true;
}

export interface GithubCapabilityProbe {
  probe(
    input: GithubCapabilityProbeInput,
  ): Promise<GithubCapabilityProbeResult>;
}

export interface GhGithubCapabilityProbeOptions {
  platform?: NodeJS.Platform;
}

export class GithubCapabilityError extends Error {
  readonly code: string;
  readonly capability = CAPABILITY;
  readonly deterministic: boolean;

  constructor(input: {
    code: string;
    message: string;
    deterministic: boolean;
  }) {
    super(input.message);
    this.name = "GithubCapabilityError";
    this.code = input.code;
    this.deterministic = input.deterministic;
  }
}

export class GhGithubCapabilityProbe implements GithubCapabilityProbe {
  private readonly timeoutMs: number;

  constructor(options: GhGithubCapabilityProbeOptions = {}) {
    this.timeoutMs = resolveGithubCapabilityProbeTimeoutMs(
      options.platform ?? process.platform,
    );
  }

  async probe(
    input: GithubCapabilityProbeInput,
  ): Promise<GithubCapabilityProbeResult> {
    const identityResult = await this.runGh(input, [
      "api",
      "user",
      "--jq",
      ".login",
    ]);
    assertCommandSucceeded(identityResult, {
      step: "identity",
      workspacePath: input.workspacePath,
    });
    const identity = identityResult.stdout.trim();
    if (identity.length === 0) {
      throw transientFailure();
    }

    const repositoryResult = await this.runGh(input, [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
    assertCommandSucceeded(repositoryResult, {
      step: "repository",
      workspacePath: input.workspacePath,
    });
    const repository = repositoryResult.stdout.trim();
    if (!isRepositoryNameWithOwner(repository)) {
      throw transientFailure();
    }

    const permissionResult = await this.runGh(input, [
      "api",
      `repos/${repository}`,
      "--jq",
      ".permissions.push",
    ]);
    assertCommandSucceeded(permissionResult, {
      step: "permission",
      workspacePath: input.workspacePath,
    });
    const canPush = permissionResult.stdout.trim().toLowerCase();
    if (canPush === "false") {
      throw permissionFailure();
    }
    if (canPush !== "true") {
      throw transientFailure();
    }

    return {
      identity,
      repository,
      canPush: true,
    };
  }

  private async runGh(
    input: GithubCapabilityProbeInput,
    args: string[],
  ): Promise<CodexCommandExecResult> {
    try {
      return await input.executor.execCommand({
        command: ["gh", ...args],
        cwd: input.workspacePath,
        timeoutMs: this.timeoutMs,
        ...(process.platform === "win32"
          ? {}
          : { outputBytesCap: GITHUB_CAPABILITY_OUTPUT_BYTES_CAP }),
        sandboxPolicy: input.sandboxPolicy,
      });
    } catch (error) {
      throw transientFailure(
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}

export function isDeterministicGithubCapabilityErrorCode(
  code: string | undefined,
): code is
  | typeof ERROR_CODES.githubCliNotFound
  | typeof ERROR_CODES.githubRemoteMissing
  | typeof ERROR_CODES.githubAuthInvalid
  | typeof ERROR_CODES.githubPermissionDenied {
  return (
    code === ERROR_CODES.githubCliNotFound ||
    code === ERROR_CODES.githubRemoteMissing ||
    code === ERROR_CODES.githubAuthInvalid ||
    code === ERROR_CODES.githubPermissionDenied
  );
}

export function isGithubCapabilityErrorCode(
  code: string | undefined,
): code is
  | typeof ERROR_CODES.githubCliNotFound
  | typeof ERROR_CODES.githubRemoteMissing
  | typeof ERROR_CODES.githubAuthInvalid
  | typeof ERROR_CODES.githubPermissionDenied
  | typeof ERROR_CODES.githubCapabilityTransient {
  return (
    isDeterministicGithubCapabilityErrorCode(code) ||
    code === ERROR_CODES.githubCapabilityTransient
  );
}

function assertCommandSucceeded(
  result: CodexCommandExecResult,
  context: { step: GithubProbeStep; workspacePath: string },
): void {
  if (result.exitCode === 0) {
    return;
  }

  throw classifyCommandFailure(result, context);
}

function classifyCommandFailure(
  result: CodexCommandExecResult,
  context: { step: GithubProbeStep; workspacePath: string },
): GithubCapabilityError {
  const diagnostic = boundedGithubDiagnosticSource(result.stderr);

  if (result.exitCode === 127) {
    return missingExecutableFailure(diagnostic);
  }

  if (
    context.step === "repository" &&
    isMissingGithubRemoteDiagnostic(diagnostic)
  ) {
    return remoteMissingFailure(context.workspacePath, diagnostic);
  }

  if (isHttpStatus(diagnostic, 401)) {
    return authenticationFailure(diagnostic);
  }

  if (isHttpStatus(diagnostic, 403)) {
    return permissionFailure(diagnostic);
  }

  if (
    /\b(?:bad credentials|not logged in(?:to)?|not authenticated|authentication failed|requires authentication)\b/i.test(
      diagnostic,
    )
  ) {
    return authenticationFailure(diagnostic);
  }

  if (/\bResource not accessible by integration\b/i.test(diagnostic)) {
    return permissionFailure(diagnostic);
  }

  return transientFailure(diagnostic);
}

function isMissingGithubRemoteDiagnostic(diagnostic: string): boolean {
  return (
    /^none of the git remotes configured for this repository point to a known GitHub host\.?$/im.test(
      diagnostic,
    ) ||
    /^(?:fatal:\s*)?not a git repository(?: \(or any of the parent directories\))?(?:: \.git)?\.?$/im.test(
      diagnostic,
    )
  );
}

function isHttpStatus(diagnostic: string, status: 401 | 403): boolean {
  return new RegExp(
    `\\bHTTP(?:\\/[0-9.]+)?\\s+${status}\\b|\\bstatus(?:\\s+code)?(?:\\s*[:=]\\s*|\\s+)${status}\\b`,
    "i",
  ).test(diagnostic);
}

function missingExecutableFailure(diagnostic?: string): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubCliNotFound,
    message: appendGithubDiagnostic(
      "Required GitHub capability is unavailable: gh was not found in the Codex command environment.",
      diagnostic,
    ),
    deterministic: true,
  });
}

function remoteMissingFailure(
  workspacePath: string,
  diagnostic: string,
): GithubCapabilityError {
  const workspaceLabel = safeGithubWorkspaceLabel(workspacePath);
  return new GithubCapabilityError({
    code: ERROR_CODES.githubRemoteMissing,
    message: appendGithubDiagnostic(
      `Required GitHub capability failed: ticket workspace '${workspaceLabel}' has no GitHub-backed git remote.`,
      diagnostic,
    ),
    deterministic: true,
  });
}

function authenticationFailure(diagnostic?: string): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubAuthInvalid,
    message: appendGithubDiagnostic(
      "Required GitHub capability failed: gh authentication is invalid or expired.",
      diagnostic,
    ),
    deterministic: true,
  });
}

function permissionFailure(diagnostic?: string): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubPermissionDenied,
    message: appendGithubDiagnostic(
      "Required GitHub capability failed: the authenticated identity cannot push to the workspace target repository.",
      diagnostic,
    ),
    deterministic: true,
  });
}

function transientFailure(diagnostic?: string): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubCapabilityTransient,
    message: appendGithubDiagnostic(
      "Required GitHub capability could not be verified due to a transient GitHub CLI or network failure.",
      diagnostic,
    ),
    deterministic: false,
  });
}

function isRepositoryNameWithOwner(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}
