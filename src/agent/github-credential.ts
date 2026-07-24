import { execFile } from "node:child_process";

import { ERROR_CODES } from "../errors/codes.js";
import {
  GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
  GithubCapabilityError,
} from "./github-capability.js";
import {
  appendGithubDiagnostic,
  boundedGithubDiagnosticSource,
} from "./github-diagnostic.js";

const GITHUB_HOSTNAME = "github.com";
export const GITHUB_CREDENTIAL_LOAD_TIMEOUT_MS = 15_000;

export interface GithubCredentialProviderInput {
  environment: NodeJS.ProcessEnv;
}

export interface GithubCredentialProvider {
  getToken(input: GithubCredentialProviderInput): Promise<string>;
}

export interface GithubCredentialCommandInput {
  executable: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputBytesCap: number;
}

export interface GithubCredentialCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorCode: string | null;
  errorPath: string | null;
  errorSyscall: string | null;
}

export interface GithubCredentialCommandRunner {
  execFile(
    input: GithubCredentialCommandInput,
  ): Promise<GithubCredentialCommandResult>;
}

export class GhAuthTokenCredentialProvider implements GithubCredentialProvider {
  private readonly commandRunner: GithubCredentialCommandRunner;

  constructor(
    commandRunner: GithubCredentialCommandRunner = new NodeGithubCredentialCommandRunner(),
  ) {
    this.commandRunner = commandRunner;
  }

  async getToken(input: GithubCredentialProviderInput): Promise<string> {
    let result: GithubCredentialCommandResult;
    try {
      result = await this.commandRunner.execFile({
        executable: "gh",
        args: ["auth", "token", "--hostname", GITHUB_HOSTNAME],
        environment: input.environment,
        timeoutMs: GITHUB_CREDENTIAL_LOAD_TIMEOUT_MS,
        outputBytesCap: GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
      });
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : undefined;
      if (isCorrelatedGhEnoent(error)) {
        throw launchEnvironmentMissingExecutableFailure(diagnostic);
      }
      throw credentialLoadTransientFailure(diagnostic);
    }

    if (result.exitCode !== 0) {
      const diagnostic = boundedGithubDiagnosticSource(result.stderr);
      if (
        result.exitCode === 127 ||
        (result.errorCode === "ENOENT" &&
          isGhSpawn(result.errorPath, result.errorSyscall))
      ) {
        throw launchEnvironmentMissingExecutableFailure(diagnostic);
      }
      if (isAuthenticationDiagnostic(diagnostic)) {
        throw authenticationFailure(diagnostic);
      }
      throw credentialLoadTransientFailure(diagnostic);
    }

    const token = result.stdout.trim();
    if (token.length === 0) {
      throw authenticationFailure(result.stderr);
    }

    return token;
  }
}

class NodeGithubCredentialCommandRunner
  implements GithubCredentialCommandRunner
{
  async execFile(
    input: GithubCredentialCommandInput,
  ): Promise<GithubCredentialCommandResult> {
    return await new Promise((resolve) => {
      execFile(
        input.executable,
        [...input.args],
        {
          encoding: "utf8",
          env: input.environment,
          maxBuffer: input.outputBytesCap,
          shell: false,
          timeout: input.timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode:
              error === null
                ? 0
                : typeof error.code === "number"
                  ? error.code
                  : null,
            stdout,
            stderr,
            errorCode:
              error !== null && typeof error.code === "string"
                ? error.code
                : null,
            errorPath: readStringProperty(error, "path"),
            errorSyscall: readStringProperty(error, "syscall"),
          });
        },
      );
    });
  }
}

function isAuthenticationDiagnostic(diagnostic: string): boolean {
  return (
    /\bHTTP(?:\/[0-9.]+)?\s+401\b|\bstatus(?:\s+code)?(?:\s*[:=]\s*|\s+)401\b/i.test(
      diagnostic,
    ) ||
    /\b(?:bad credentials|not logged in(?:to)?|not authenticated|authentication failed|requires authentication)\b/i.test(
      diagnostic,
    )
  );
}

function isCorrelatedGhEnoent(error: unknown): boolean {
  return (
    readStringProperty(error, "code") === "ENOENT" &&
    isGhSpawn(
      readStringProperty(error, "path"),
      readStringProperty(error, "syscall"),
    )
  );
}

function isGhSpawn(
  errorPath: string | null,
  errorSyscall: string | null,
): boolean {
  const hasPath = errorPath !== null && errorPath.length > 0;
  const hasSyscall = errorSyscall !== null && errorSyscall.length > 0;
  if (!hasPath && !hasSyscall) {
    return false;
  }

  const pathMatches =
    !hasPath || /^gh(?:\.exe)?$/i.test(errorPath.split(/[\\/]/).at(-1) ?? "");
  const syscallMatches =
    !hasSyscall || /^spawn(?:file)?\s+gh(?:\.exe)?$/i.test(errorSyscall.trim());
  return pathMatches && syscallMatches;
}

function readStringProperty(value: unknown, property: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" ? candidate : null;
}

function launchEnvironmentMissingExecutableFailure(
  diagnostic?: string,
): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubCliNotFound,
    message: appendGithubDiagnostic(
      "Required GitHub capability is unavailable: gh was not found in the Symphony launch environment.",
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

function credentialLoadTransientFailure(
  diagnostic?: string,
): GithubCapabilityError {
  return new GithubCapabilityError({
    code: ERROR_CODES.githubCapabilityTransient,
    message: appendGithubDiagnostic(
      "Required GitHub credential could not be loaded from gh auth token due to a transient local CLI failure.",
      diagnostic,
    ),
    deterministic: false,
  });
}
