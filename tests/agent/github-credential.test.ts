import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
  GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
} from "../../src/agent/github-capability.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  GITHUB_CREDENTIAL_LOAD_TIMEOUT_MS,
  GhAuthTokenCredentialProvider,
  type GithubCapabilityError,
  type GithubCredentialCommandResult,
} from "../../src/index.js";

describe("GhAuthTokenCredentialProvider", () => {
  it("loads the current github.com token through a bounded direct gh argv call", async () => {
    const environment = {
      PATH: "C:\\tools",
      GH_CONFIG_DIR: "C:\\gh-config",
    };
    const execFile = vi.fn().mockResolvedValue(result(0, "keyring-token\n"));
    const provider = new GhAuthTokenCredentialProvider({ execFile });

    await expect(provider.getToken({ environment })).resolves.toBe(
      "keyring-token",
    );

    expect(execFile).toHaveBeenCalledWith({
      executable: "gh",
      args: ["auth", "token", "--hostname", "github.com"],
      environment,
      timeoutMs: GITHUB_CREDENTIAL_LOAD_TIMEOUT_MS,
      outputBytesCap: GITHUB_CAPABILITY_OUTPUT_BYTES_CAP,
    });
  });

  it.each([
    {
      label: "missing gh",
      response: result(null, "", "", "ENOENT", "gh", "spawn gh"),
      code: ERROR_CODES.githubCliNotFound,
      deterministic: true,
      diagnostic: null,
    },
    {
      label: "exit 127",
      response: result(127, "", "gh: command not found"),
      code: ERROR_CODES.githubCliNotFound,
      deterministic: true,
      diagnostic: "gh: command not found",
    },
    {
      label: "missing login",
      response: result(
        1,
        "",
        "not logged into any GitHub hosts token=secret-value",
      ),
      code: ERROR_CODES.githubAuthInvalid,
      deterministic: true,
      diagnostic: "not logged into any GitHub hosts",
    },
    {
      label: "empty successful output",
      response: result(0, ""),
      code: ERROR_CODES.githubAuthInvalid,
      deterministic: true,
      diagnostic: null,
    },
    {
      label: "login remediation hint without auth evidence",
      response: result(
        1,
        "HTTP 401 in unrelated stdout",
        "keyring access failed; please use gh auth login",
      ),
      code: ERROR_CODES.githubCapabilityTransient,
      deterministic: false,
      diagnostic: "keyring access failed; please use gh auth login",
    },
    {
      label: "stdout auth poison with empty stderr",
      response: result(1, "HTTP 401: Bad credentials", ""),
      code: ERROR_CODES.githubCapabilityTransient,
      deterministic: false,
      diagnostic: null,
    },
    {
      label: "unclassified local failure",
      response: result(1, "", "keyring failed token=secret-value"),
      code: ERROR_CODES.githubCapabilityTransient,
      deterministic: false,
      diagnostic: "keyring failed",
    },
  ])("classifies and redacts $label", async (input) => {
    const provider = new GhAuthTokenCredentialProvider({
      execFile: vi.fn().mockResolvedValue(input.response),
    });

    const error = await captureError(provider.getToken({ environment: {} }));

    expect(error).toMatchObject({
      name: "GithubCapabilityError",
      code: input.code,
      capability: "github",
      deterministic: input.deterministic,
    } satisfies Partial<GithubCapabilityError>);
    if (input.diagnostic !== null) {
      expect(error.message).toContain(input.diagnostic);
    }
    expect(error.message).not.toContain("secret-value");
    expect(error.message).not.toContain("token=");
    expect(error.message).not.toContain("HTTP 401 in unrelated stdout");
  });

  it.each([
    {
      label: "matching path and syscall",
      response: result(null, "", "", "ENOENT", "gh", "spawn gh"),
      code: ERROR_CODES.githubCliNotFound,
    },
    {
      label: "matching Windows path and syscall",
      response: result(
        null,
        "",
        "",
        "ENOENT",
        "C:\\tools\\gh.exe",
        "spawnfile gh.exe",
      ),
      code: ERROR_CODES.githubCliNotFound,
    },
    {
      label: "matching path only",
      response: result(null, "", "", "ENOENT", "gh"),
      code: ERROR_CODES.githubCliNotFound,
    },
    {
      label: "matching syscall only",
      response: result(null, "", "", "ENOENT", null, "spawn gh"),
      code: ERROR_CODES.githubCliNotFound,
    },
    {
      label: "unrelated path only",
      response: result(
        null,
        "",
        "spawn failed",
        "ENOENT",
        "C:\\missing\\workspace",
      ),
      code: ERROR_CODES.githubCapabilityTransient,
    },
    {
      label: "unrelated syscall only",
      response: result(null, "", "spawn failed", "ENOENT", null, "spawn node"),
      code: ERROR_CODES.githubCapabilityTransient,
    },
    {
      label: "missing cwd path",
      response: result(
        null,
        "",
        "spawn failed",
        "ENOENT",
        "C:\\missing\\workspace",
        "spawn gh",
      ),
      code: ERROR_CODES.githubCapabilityTransient,
    },
    {
      label: "disagreeing syscall",
      response: result(null, "", "spawn failed", "ENOENT", "gh", "spawn node"),
      code: ERROR_CODES.githubCapabilityTransient,
    },
    {
      label: "uncorrelated ENOENT",
      response: result(null, "", "spawn failed", "ENOENT"),
      code: ERROR_CODES.githubCapabilityTransient,
    },
  ])("correlates ENOENT with the gh executable: $label", async (input) => {
    const error = await captureError(
      new GhAuthTokenCredentialProvider({
        execFile: vi.fn().mockResolvedValue(input.response),
      }).getToken({ environment: {} }),
    );

    expect(error.code).toBe(input.code);
  });

  it.each([
    {
      label: "GitHub fine-grained token",
      credential: ["github_pat_", "a".repeat(48)].join(""),
      secret: "github_pat_",
    },
    {
      label: "GH_TOKEN assignment",
      credential: "GH_TOKEN=opaque-value",
      secret: "opaque-value",
    },
    {
      label: "Authorization header",
      credential: "Authorization: Bearer opaque-value",
      secret: "opaque-value",
    },
    {
      label: "standalone bearer",
      credential: "Bearer opaque-value",
      secret: "opaque-value",
    },
  ])("redacts $label from credential-loader diagnostics", async (input) => {
    const error = await captureError(
      new GhAuthTokenCredentialProvider({
        execFile: vi
          .fn()
          .mockResolvedValue(
            result(1, "", `keyring failed; ${input.credential}`),
          ),
      }).getToken({ environment: {} }),
    );

    expect(error.message).toContain("keyring failed");
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(input.secret);
  });

  it("redacts before truncating credential-loader diagnostics", async () => {
    const longFakeToken = ["ghs_", "a".repeat(3_000)].join("");
    const sentinel = "retained-after-redaction";
    const error = await captureError(
      new GhAuthTokenCredentialProvider({
        execFile: vi
          .fn()
          .mockResolvedValue(
            result(1, "", `keyring failed ${longFakeToken}; ${sentinel}`),
          ),
      }).getToken({ environment: {} }),
    );

    expect(error.message).toContain(sentinel);
    expect(error.message).not.toContain(longFakeToken);
    expect(error.message).not.toContain("… [truncated]");
  });

  it("uses the literal diagnostic byte cap for credential-loader failures", async () => {
    const error = await captureError(
      new GhAuthTokenCredentialProvider({
        execFile: vi
          .fn()
          .mockResolvedValue(
            result(
              1,
              "",
              `keyring failed ${"🙂".repeat(
                GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP,
              )}`,
            ),
          ),
      }).getToken({ environment: {} }),
    );
    const excerpt = error.message.split("GitHub CLI diagnostic: ")[1] ?? "";

    expect(GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP).toBe(2_048);
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(2_048);
    expect(excerpt).toContain("… [truncated]");
    expect(excerpt).not.toContain("\r");
    expect(excerpt).not.toContain("\n");
    expect(excerpt).not.toContain("�");
  });

  it("redacts unexpected command-runner exceptions", async () => {
    const provider = new GhAuthTokenCredentialProvider({
      execFile: vi
        .fn()
        .mockRejectedValue(new Error("spawn failed token=secret-value")),
    });

    const error = await captureError(provider.getToken({ environment: {} }));

    expect(error.code).toBe(ERROR_CODES.githubCapabilityTransient);
    expect(error.message).toContain("spawn failed");
    expect(error.message).toContain("GitHub CLI diagnostic:");
    expect(error.message).not.toContain("secret-value");
  });

  it("recognizes a correlated rejected gh spawn as a missing executable", async () => {
    const rejected = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT",
      path: "gh",
      syscall: "spawn gh",
    });
    const error = await captureError(
      new GhAuthTokenCredentialProvider({
        execFile: vi.fn().mockRejectedValue(rejected),
      }).getToken({ environment: {} }),
    );

    expect(error.code).toBe(ERROR_CODES.githubCliNotFound);
  });
});

function result(
  exitCode: number | null,
  stdout: string,
  stderr = "",
  errorCode: string | null = null,
  errorPath: string | null = null,
  errorSyscall: string | null = null,
): GithubCredentialCommandResult {
  return {
    exitCode,
    stdout,
    stderr,
    errorCode,
    errorPath,
    errorSyscall,
  };
}

async function captureError(
  promise: Promise<unknown>,
): Promise<GithubCapabilityError> {
  try {
    await promise;
    throw new Error("Expected promise to reject.");
  } catch (error) {
    return error as GithubCapabilityError;
  }
}
