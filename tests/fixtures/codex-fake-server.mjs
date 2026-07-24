import { realpathSync, writeFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "happy";
const scenarioArgument = process.argv[3];
const shutdownEvidencePath = process.argv[4];
const requests = [];
let turnCount = 0;

if (scenario === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 10_000);
}

if (scenario === "record-start") {
  if (scenarioArgument === undefined) {
    throw new Error("record-start scenario requires an output path");
  }
  writeFileSync(scenarioArgument, "started\n", "utf8");
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on("close", () => {
  if (shutdownEvidencePath !== undefined) {
    writeFileSync(
      shutdownEvidencePath,
      `${JSON.stringify(requests.map((request) => request.method))}\n`,
      "utf8",
    );
  }
});

rl.on("line", async (line) => {
  if (line.trim().length === 0) {
    return;
  }

  const message = JSON.parse(line);
  requests.push(message);

  try {
    await handleMessage(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

async function handleMessage(message) {
  if (
    scenario === "delayed-session" &&
    ["initialize", "thread/start", "turn/start"].includes(message.method)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  if (
    [
      "command-401",
      "external-command-not-found",
      "external-command-denied",
      "external-command-transient",
    ].includes(scenario) &&
    (message.method === "thread/start" || message.method === "turn/start")
  ) {
    throw new Error(
      "failed capability preflight must stop before thread/start or turn/start",
    );
  }

  if (message.method === "initialize") {
    if (scenario === "read-timeout") {
      return;
    }

    if (scenario === "handshake") {
      assertEqual(
        message.params.clientInfo?.name,
        "symphony-ts",
        "initialize must include clientInfo.name",
      );
      assertEqual(
        message.params.clientInfo?.version,
        "0.1.0",
        "initialize must include clientInfo.version",
      );
      assertEqual(
        typeof message.params.capabilities,
        "object",
        "initialize must include a capabilities object",
      );
      assertEqual(
        message.params.capabilities.experimentalApi,
        true,
        "initialize must opt into experimentalApi",
      );
      assertEqual(
        message.params.capabilities.requestAttestation,
        false,
        "initialize must disable attestation requests by default",
      );
    }

    writeJson({
      id: message.id,
      result: {
        serverInfo: {
          name: "fake-codex",
        },
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "command-only") {
      throw new Error("command-only scenario must not start a thread");
    }
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "spawn cwd must equal request cwd",
    );
    if (scenario === "linear-tool") {
      assertEqual(
        message.params.dynamicTools?.[0]?.name,
        "linear_graphql",
        "thread/start must advertise linear_graphql through dynamicTools",
      );
      assertEqual(
        message.params.dynamicTools?.[0]?.description,
        "Execute one GraphQL query or mutation against the configured Linear workspace using Symphony-managed auth.",
        "dynamic tool specs must include descriptions",
      );
      assertEqual(
        message.params.dynamicTools?.[0]?.inputSchema?.type,
        "object",
        "dynamic tool specs must include input schemas",
      );
    }
    if (scenario === "handshake") {
      assertEqual(
        message.params.approvalPolicy,
        "full-auto",
        "thread/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandbox,
        "workspace-write",
        "thread/start must include thread sandbox policy",
      );
    }
    writeJson({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
        },
      },
    });
    return;
  }

  if (message.method === "command/exec") {
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "command/exec cwd must equal app-server cwd",
    );
    assertEqual(
      message.params.timeoutMs,
      process.platform === "win32" ? 60_000 : 15_000,
      "command/exec must use the bounded GitHub probe timeout",
    );
    if (process.platform === "win32") {
      assertEqual(
        Object.hasOwn(message.params, "outputBytesCap"),
        false,
        "Windows command/exec must use the app-server default output cap",
      );
    } else {
      assertEqual(
        message.params.outputBytesCap,
        64 * 1024,
        "command/exec must bound each output stream",
      );
    }
    assertEqual(
      Object.hasOwn(message.params, "env"),
      false,
      "command/exec must not override the inherited environment",
    );
    assertEqual(
      message.params.sandboxPolicy?.type,
      "workspaceWrite",
      "command/exec must use the prepared turn sandbox policy",
    );
    assertEqual(
      message.params.sandboxPolicy?.writableRoots?.includes(message.params.cwd),
      true,
      "command/exec sandbox must include the workspace root",
    );

    if (scenario === "command-401") {
      assertEqual(
        process.env.GH_TOKEN,
        "inherited-secret",
        "GitHub command/exec must inherit the app-server credential environment",
      );
      writeJson({
        id: message.id,
        result: {
          exitCode: 1,
          stdout: "",
          stderr: "gh: HTTP 401: Bad credentials (secret was redacted)",
        },
      });
      return;
    }

    const command = message.params.command;
    if (
      [
        "external-command-success",
        "external-command-not-found",
        "external-command-denied",
        "external-command-transient",
      ].includes(scenario)
    ) {
      const expectedCommand =
        process.platform === "win32" &&
        scenarioArgument !== undefined &&
        !scenarioArgument.includes(".")
          ? `${scenarioArgument}.exe`
          : scenarioArgument;
      assertEqual(
        command?.[0],
        expectedCommand,
        "generic command/exec must use the declared executable basename",
      );
      assertEqual(
        command?.[1],
        "--version",
        "generic command/exec must append declared probe arguments",
      );
      assertEqual(
        process.env.SYMPHONY_TEST_CREDENTIAL,
        "inherited-secret",
        "generic command/exec must inherit the app-server environment",
      );
      writeJson({
        id: message.id,
        result:
          scenario === "external-command-success"
            ? { exitCode: 0, stdout: "test tool 1.0\n", stderr: "" }
            : scenario === "external-command-not-found"
              ? {
                  exitCode: 127,
                  stdout: "",
                  stderr:
                    "raw missing output C:\\private\\tools token=fixture-secret",
                }
              : scenario === "external-command-denied"
                ? {
                    exitCode: 1,
                    stdout: "",
                    stderr:
                      "raw denied output C:\\private\\tools token=fixture-secret: permission denied",
                  }
                : {
                    exitCode: 75,
                    stdout: "",
                    stderr:
                      "raw transient output C:\\private\\tools token=fixture-secret: try again later",
                  },
      });
      return;
    }

    assertEqual(
      process.env.GH_TOKEN,
      "inherited-secret",
      "GitHub command/exec must inherit the app-server credential environment",
    );
    let stdout = "";
    if (
      command?.[0] === "gh" &&
      command?.[1] === "api" &&
      command?.[2] === "user"
    ) {
      stdout = "octocat\n";
    } else if (
      command?.[0] === "gh" &&
      command?.[1] === "repo" &&
      command?.[2] === "view"
    ) {
      stdout = "example/project\n";
    } else if (
      command?.[0] === "gh" &&
      command?.[1] === "api" &&
      command?.[2] === "repos/example/project"
    ) {
      stdout = "true\n";
    } else {
      throw new Error(
        `unexpected command/exec argv: ${JSON.stringify(command)}`,
      );
    }

    writeJson({
      id: message.id,
      result: { exitCode: 0, stdout, stderr: "" },
    });
    return;
  }

  if (message.method === "turn/start") {
    turnCount += 1;
    assertEqual(message.params.threadId, "thread-1", "threadId must be reused");
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "turn cwd must equal workspace path",
    );
    assertEqual(
      message.params.input?.[0]?.type,
      "text",
      "turn input must contain a single text item",
    );
    if (scenario === "handshake") {
      assertEqual(
        message.params.approvalPolicy,
        "full-auto",
        "turn/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandboxPolicy?.type,
        "workspace-write",
        "turn/start must include per-turn sandbox policy",
      );
    }

    writeJson({
      id: message.id,
      result: {
        turn: {
          id: `turn-${turnCount}`,
        },
      },
    });

    if (scenario === "turn-timeout") {
      return;
    }

    if (scenario === "user-input") {
      setTimeout(() => {
        writeJson({
          method: "turn/input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "user-input-variant") {
      setTimeout(() => {
        writeJson({
          method: "turn/user_input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (turnCount === 1) {
      setTimeout(() => {
        process.stderr.write("diagnostic from stderr\n");

        writePartialJson({
          method: "turn/update",
          params: {
            total_token_usage: {
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
            },
          },
        });

        setTimeout(() => {
          writeJson({
            id: "approval-1",
            method:
              scenario === "payload-variants"
                ? "turn/approval_required"
                : "approval/request",
            params: {
              kind: "command_execution",
            },
          });
        }, 10);
      }, 10);
      return;
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "Second turn finished",
          result:
            scenario === "payload-variants"
              ? {
                  telemetry: {
                    usage: {
                      input_tokens: 20,
                      output_tokens: 10,
                      total_tokens: 30,
                    },
                  },
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                }
              : {
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                },
          ...(scenario === "payload-variants"
            ? {}
            : {
                usage: {
                  inputTokens: 20,
                  outputTokens: 10,
                  totalTokens: 30,
                },
              }),
        },
      });
    }, 10);
    return;
  }

  if (message.id === "approval-1") {
    assertEqual(
      message.result?.approved,
      true,
      "approval must be auto-approved",
    );

    setTimeout(() => {
      writeJson({
        id: scenario === "linear-tool" ? 0 : "tool-1",
        method: "item/tool/call",
        params:
          scenario === "linear-tool"
            ? {
                threadId: "thread-1",
                turnId: `turn-${turnCount}`,
                callId: "tool-1",
                namespace: null,
                tool: "linear_graphql",
                arguments: {
                  query: "query Viewer { viewer { id name } }",
                  variables: {
                    includeArchived: false,
                  },
                },
              }
            : {
                toolName: "not_supported",
              },
      });
    }, 10);
    return;
  }

  if (message.id === "tool-1" || message.id === 0) {
    if (scenario === "linear-tool") {
      assertEqual(
        message.result?.success,
        true,
        "supported linear_graphql tool call must succeed",
      );
      assertEqual(
        message.result?.contentItems?.[0]?.type,
        "inputText",
        "dynamic tool responses must use official contentItems",
      );
      const toolResult = JSON.parse(message.result?.contentItems?.[0]?.text);
      assertEqual(
        toolResult.response?.body?.data?.viewer?.id,
        "viewer-1",
        "linear_graphql tool must return the GraphQL response body",
      );
    } else {
      assertEqual(
        message.result?.success,
        false,
        "unsupported tool calls must return success=false",
      );
      assertEqual(
        message.result?.contentItems?.[0]?.type,
        "inputText",
        "unsupported tool calls must still return official contentItems",
      );
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "First turn finished",
          usage: {
            inputTokens: 14,
            outputTokens: 9,
            totalTokens: 23,
          },
          rateLimits: {
            requestsRemaining: 10,
            tokensRemaining: 1000,
          },
        },
      });
    }, 10);
  }
}

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writePartialJson(message) {
  const encoded = `${JSON.stringify(message)}\n`;
  const halfway = Math.floor(encoded.length / 2);
  process.stdout.write(encoded.slice(0, halfway));
  setTimeout(() => {
    process.stdout.write(encoded.slice(halfway));
  }, 5);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}
