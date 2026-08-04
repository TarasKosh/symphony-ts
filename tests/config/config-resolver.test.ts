import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveWorkflowConfig,
  validateDispatchConfig,
} from "../../src/config/config-resolver.js";
import {
  DEFAULT_CODEX_COMMAND,
  DEFAULT_COMMAND_CAPABILITIES,
  DEFAULT_GITHUB_CAPABILITY_REQUIRED,
  DEFAULT_GITHUB_CREDENTIAL_SOURCE,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS,
  DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_NOTION_ENDPOINT,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TRACKER_BLOCKED_STATE,
  DEFAULT_TRACKER_CLAIM_STATE,
  DEFAULT_TRACKER_HANDOFF_STATES,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS,
  DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS,
  DEFAULT_WORKSPACE_RETENTION_STATES,
  DEFAULT_WORKSPACE_ROOT,
} from "../../src/config/defaults.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

describe("config-resolver", () => {
  it("applies spec defaults when workflow config is empty", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {},
      promptTemplate: "Prompt",
    });

    expect(resolved.tracker.kind).toBe("linear");
    expect(resolved.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(resolved.tracker.adapterOptions).toEqual({});
    expect(resolved.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(resolved.tracker.claimState).toBe(DEFAULT_TRACKER_CLAIM_STATE);
    expect(resolved.tracker.handoffStates).toEqual(
      DEFAULT_TRACKER_HANDOFF_STATES,
    );
    expect(resolved.tracker.blockedState).toBe(DEFAULT_TRACKER_BLOCKED_STATE);
    expect(resolved.tracker.requireClaimBeforeAgent).toBe(
      DEFAULT_REQUIRE_CLAIM_BEFORE_AGENT,
    );
    expect(resolved.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(resolved.polling.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolved.polling.issueCommentsBetweenTurns).toBe(
      DEFAULT_ISSUE_COMMENTS_BETWEEN_TURNS,
    );
    expect(resolved.polling.issueCommentIgnoredAuthors).toEqual(
      DEFAULT_ISSUE_COMMENT_IGNORED_AUTHORS,
    );
    expect(resolved.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(resolved.workspace.retention).toEqual({
      states: DEFAULT_WORKSPACE_RETENTION_STATES,
      staleAfterMs: DEFAULT_WORKSPACE_RETENTION_STALE_AFTER_MS,
      checkIntervalMs: DEFAULT_WORKSPACE_RETENTION_CHECK_INTERVAL_MS,
    });
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(
      DEFAULT_MAX_CONCURRENT_AGENTS,
    );
    expect(resolved.agent.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(resolved.agent.maxRetryBackoffMs).toBe(DEFAULT_MAX_RETRY_BACKOFF_MS);
    expect(resolved.codex.command).toBe(DEFAULT_CODEX_COMMAND);
    expect(resolved.codex.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolved.codex.readTimeoutMs).toBe(DEFAULT_READ_TIMEOUT_MS);
    expect(resolved.codex.stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS);
    expect(resolved.capabilities.commands).toBe(DEFAULT_COMMAND_CAPABILITIES);
    expect(resolved.capabilities.github.required).toBe(
      DEFAULT_GITHUB_CAPABILITY_REQUIRED,
    );
    expect(resolved.capabilities.github.credentialSource).toBe(
      DEFAULT_GITHUB_CREDENTIAL_SOURCE,
    );
    expect(resolved.observability.dashboardEnabled).toBe(
      DEFAULT_OBSERVABILITY_ENABLED,
    );
    expect(resolved.observability.refreshMs).toBe(
      DEFAULT_OBSERVABILITY_REFRESH_MS,
    );
    expect(resolved.observability.renderIntervalMs).toBe(
      DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    );
  });

  it("coerces env-backed fields, path-like roots, and state limits", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            api_key: "$LINEAR_TOKEN",
            project_slug: "ENG",
            board_id: "future-adapter-option",
            active_states: "Todo, In Progress, Ready for QA",
            claim_state: "In Progress",
            handoff_states: "In Review, Review",
            blocked_state: "Needs decision",
            require_claim_before_agent: "false",
          },
          polling: {
            interval_ms: "15000",
            issue_comments_between_turns: "true",
            issue_comment_ignored_authors: "Symphony Bot, Hermes_Connectio",
          },
          workspace: {
            root: "./tmp/workspaces",
            retention: {
              states: "Blocked, In Review, Human Review",
              stale_after_days: "30",
              check_interval_ms: "7200000",
            },
          },
          hooks: {
            timeout_ms: "0",
            before_run: "pnpm test",
          },
          agent: {
            max_concurrent_agents: "4",
            max_turns: "8",
            max_retry_backoff_ms: "120000",
            max_concurrent_agents_by_state: {
              " In Progress ": "2",
              Done: 0,
            },
          },
          codex: {
            command: "codex app-server --stdio",
            turn_timeout_ms: "90000",
            read_timeout_ms: "2500",
            stall_timeout_ms: "-1",
          },
          capabilities: {
            github: {
              required: "true",
              credential_source: "gh_auth_token",
            },
          },
          server: {
            port: "8080",
          },
          observability: {
            dashboard_enabled: "false",
            refresh_ms: "2500",
            render_interval_ms: "33",
          },
        },
      },
      {
        LINEAR_TOKEN: "secret-token",
      },
    );

    expect(resolved.tracker.apiKey).toBe("secret-token");
    expect(resolved.tracker.projectSlug).toBe("ENG");
    expect(resolved.tracker.adapterOptions).toEqual({
      board_id: "future-adapter-option",
    });
    expect(resolved.tracker.activeStates).toEqual([
      "Todo",
      "In Progress",
      "Ready for QA",
    ]);
    expect(resolved.tracker.claimState).toBe("In Progress");
    expect(resolved.tracker.handoffStates).toEqual(["In Review", "Review"]);
    expect(resolved.tracker.blockedState).toBe("Needs decision");
    expect(resolved.tracker.requireClaimBeforeAgent).toBe(false);
    expect(resolved.polling.intervalMs).toBe(15_000);
    expect(resolved.polling.issueCommentsBetweenTurns).toBe(true);
    expect(resolved.polling.issueCommentIgnoredAuthors).toEqual([
      "Symphony Bot",
      "Hermes_Connectio",
    ]);
    expect(resolved.workspace.root).toBe(resolve("/repo/tmp/workspaces"));
    expect(resolved.workspace.retention).toEqual({
      states: ["Blocked", "In Review", "Human Review"],
      staleAfterMs: 30 * 86_400_000,
      checkIntervalMs: 7_200_000,
    });
    expect(resolved.hooks.beforeRun).toBe("pnpm test");
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(4);
    expect(resolved.agent.maxTurns).toBe(8);
    expect(resolved.agent.maxRetryBackoffMs).toBe(120_000);
    expect(resolved.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
    expect(resolved.codex.command).toBe("codex app-server --stdio");
    expect(resolved.codex.turnTimeoutMs).toBe(90_000);
    expect(resolved.codex.readTimeoutMs).toBe(2_500);
    expect(resolved.codex.stallTimeoutMs).toBe(-1);
    expect(resolved.capabilities.github.required).toBe(true);
    expect(resolved.capabilities.github.credentialSource).toBe("gh_auth_token");
    expect(resolved.server.port).toBe(8080);
    expect(resolved.observability.dashboardEnabled).toBe(false);
    expect(resolved.observability.refreshMs).toBe(2_500);
    expect(resolved.observability.renderIntervalMs).toBe(33);
  });

  it("accepts server.port zero for ephemeral listener binding", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: 0,
        },
      },
    });

    expect(resolved.server.port).toBe(0);
  });

  it("resolves the opt-in GitHub capability and credential source settings", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        capabilities: {
          github: {
            required: true,
            credential_source: "gh_auth_token",
          },
        },
      },
    });

    expect(resolved.capabilities.github.required).toBe(true);
    expect(resolved.capabilities.github.credentialSource).toBe("gh_auth_token");
  });

  it("parses hook-only, agent-only, and dual-boundary command capabilities", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        capabilities: {
          commands: {
            node: {
              hooks: ["after_create"],
            },
            rg: {
              agent: true,
              probe_args: ["--version"],
            },
            git: {
              hooks: ["before_run", "after_run", "before_remove"],
              agent: true,
              probe_args: ["--version", "--build-options"],
            },
          },
        },
      },
    });

    expect(resolved.capabilities.commands).toEqual({
      node: {
        hooks: ["afterCreate"],
        agent: false,
        probeArgs: [],
      },
      rg: {
        hooks: [],
        agent: true,
        probeArgs: ["--version"],
      },
      git: {
        hooks: ["beforeRun", "afterRun", "beforeRemove"],
        agent: true,
        probeArgs: ["--version", "--build-options"],
      },
    });
  });

  it("keeps omitted capability declarations on the frozen empty no-op default", () => {
    const omitted = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });
    const emptyCapabilities = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        capabilities: {},
      },
    });
    const emptyCommands = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        capabilities: {
          commands: {},
        },
      },
    });

    expect(omitted.capabilities.commands).toBe(DEFAULT_COMMAND_CAPABILITIES);
    expect(emptyCapabilities.capabilities).toEqual(omitted.capabilities);
    expect(emptyCommands.capabilities).toEqual(omitted.capabilities);
  });

  it.each([
    {
      label: "null capabilities",
      capabilities: null,
    },
    {
      label: "scalar capabilities",
      capabilities: "commands",
    },
    {
      label: "null command map",
      capabilities: { commands: null },
    },
    {
      label: "list command map",
      capabilities: { commands: [] },
    },
    {
      label: "scalar command map",
      capabilities: { commands: "rg" },
    },
    {
      label: "null command declaration",
      capabilities: { commands: { rg: null } },
    },
    {
      label: "list command declaration",
      capabilities: { commands: { rg: ["--version"] } },
    },
    {
      label: "unsafe whitespace in executable name",
      capabilities: {
        commands: { "rg command": { agent: true } },
      },
    },
    {
      label: "path separator in executable name",
      capabilities: {
        commands: { "../rg": { agent: true } },
      },
    },
    {
      label: "shell metacharacter in executable name",
      capabilities: {
        commands: { "rg;rm": { agent: true } },
      },
    },
    {
      label: "unknown hook",
      capabilities: {
        commands: { rg: { hooks: ["during_run"] } },
      },
    },
    {
      label: "duplicate hook",
      capabilities: {
        commands: { rg: { hooks: ["before_run", "before_run"] } },
      },
    },
    {
      label: "non-list hooks",
      capabilities: {
        commands: { rg: { hooks: "before_run" } },
      },
    },
    {
      label: "non-boolean agent",
      capabilities: {
        commands: { rg: { agent: "true" } },
      },
    },
    {
      label: "non-list probe args",
      capabilities: {
        commands: { rg: { agent: true, probe_args: "--version" } },
      },
    },
    {
      label: "non-string probe arg",
      capabilities: {
        commands: { rg: { agent: true, probe_args: ["--version", 1] } },
      },
    },
    {
      label: "control character in probe arg",
      capabilities: {
        commands: { rg: { agent: true, probe_args: ["--token\nsecret"] } },
      },
    },
    {
      label: "NUL in probe arg",
      capabilities: {
        commands: { rg: { agent: true, probe_args: ["--token=\0secret"] } },
      },
    },
    {
      label: "unknown declaration field",
      capabilities: {
        commands: { rg: { agent: true, shell: "powershell" } },
      },
    },
    {
      label: "no enabled boundary",
      capabilities: {
        commands: {
          rg: { hooks: [], agent: false, probe_args: ["--version"] },
        },
      },
    },
  ])("rejects malformed command capability config: $label", (input) => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig({
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            kind: "linear",
            api_key: "token",
            project_slug: "ENG",
          },
          capabilities: input.capabilities,
        },
      }),
    );

    expect(validation.ok).toBe(false);
    if (validation.ok) {
      return;
    }
    expect(validation.error.code).toBe(ERROR_CODES.configInvalid);
    expect(validation.error.message).toContain("capabilities");
  });

  it("preserves malformed-command validation through CLI-style config copies", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "ENG",
        },
        capabilities: {
          commands: {
            "../rg": {
              agent: true,
            },
          },
        },
      },
    });
    const copied = {
      ...resolved,
      server: {
        ...resolved.server,
        port: 8080,
      },
    };

    expect(validateDispatchConfig(copied)).toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
      },
    });
  });

  it("rejects malformed programmatic command capabilities at dispatch", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        tracker: {
          kind: "linear",
          api_key: "token",
          project_slug: "ENG",
        },
      },
    });
    resolved.capabilities.commands = {
      "rg;whoami": {
        hooks: [],
        agent: true,
        probeArgs: ["--version"],
      },
    };

    expect(validateDispatchConfig(resolved)).toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
      },
    });
  });

  it("falls back to environment credentials for unknown GitHub credential sources", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        capabilities: {
          github: {
            required: true,
            credential_source: "write-token-to-disk",
          },
        },
      },
    });

    expect(resolved.capabilities.github.credentialSource).toBe("environment");
  });

  it("ignores invalid negative or non-integer server.port values", () => {
    const negative = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: -1,
        },
      },
    });
    const invalidString = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: "eight-thousand",
        },
      },
    });

    expect(negative.server.port).toBeNull();
    expect(invalidString.server.port).toBeNull();
  });

  it("uses the canonical LINEAR_API_KEY env var fallback", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            project_slug: "ENG",
          },
        },
      },
      {
        LINEAR_API_KEY: "canonical-secret",
      },
    );

    expect(resolved.tracker.apiKey).toBe("canonical-secret");
  });

  it("resolves notion defaults, canonical auth, and adapter options", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            kind: "notion",
            data_source_id: "$NOTION_DATA_SOURCE_ID",
            title_property: "Name",
            status_property: "Status",
            identifier_property: "Key",
            description_property: "Description",
            priority_property: "Priority",
            labels_property: "Labels",
            blocked_by_property: "Blocked by",
          },
        },
      },
      {
        NOTION_API_KEY: "notion-secret",
        NOTION_DATA_SOURCE_ID: "data-source-1",
      },
    );

    expect(resolved.tracker.endpoint).toBe(DEFAULT_NOTION_ENDPOINT);
    expect(resolved.tracker.apiKey).toBe("notion-secret");
    expect(resolved.tracker.adapterOptions).toEqual({
      data_source_id: "data-source-1",
      title_property: "Name",
      status_property: "Status",
      identifier_property: "Key",
      description_property: "Description",
      priority_property: "Priority",
      labels_property: "Labels",
      blocked_by_property: "Blocked by",
    });
  });

  it("resolves env-backed workspace roots and expands the home directory", () => {
    const envBacked = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          workspace: {
            root: "$WORKSPACE_ROOT",
          },
        },
      },
      {
        WORKSPACE_ROOT: "~/symphony-workspaces",
      },
    );

    expect(envBacked.workspace.root).toBe(
      join(homedir(), "symphony-workspaces"),
    );
  });

  it("blocks dispatch when required tracker settings are missing", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {},
      },
      {},
    );

    const validation = validateDispatchConfig(resolved);
    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.trackerCredentialsMissing,
        message: "tracker.api_key must be configured before dispatch.",
      },
    });
  });

  it("rejects unsupported tracker kinds during dispatch validation", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "jira",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.unsupportedTrackerKind,
        message:
          "tracker.kind 'jira' is not supported. Supported adapters: linear, notion.",
      },
    });
  });

  it("accepts dispatch when tracker and codex prerequisites are present", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({ ok: true });
  });

  it("requires notion data_source_id during dispatch validation", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "notion",
              api_key: "token",
              title_property: "Name",
              status_property: "Status",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message: "tracker.data_source_id must be configured before dispatch.",
      },
    });
  });

  it("requires notion title_property and status_property during dispatch validation", () => {
    const missingTitle = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "notion",
              api_key: "token",
              data_source_id: "data-source-1",
              status_property: "Status",
            },
          },
        },
        {},
      ),
    );
    const missingStatus = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "notion",
              api_key: "token",
              data_source_id: "data-source-1",
              title_property: "Name",
            },
          },
        },
        {},
      ),
    );

    expect(missingTitle).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message: "tracker.title_property must be configured before dispatch.",
      },
    });
    expect(missingStatus).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message: "tracker.status_property must be configured before dispatch.",
      },
    });
  });

  it("accepts dispatch when notion prerequisites are present", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "notion",
              api_key: "token",
              data_source_id: "data-source-1",
              title_property: "Name",
              status_property: "Status",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({ ok: true });
  });

  it("requires workspace retention states and age to be configured together", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
            workspace: {
              retention: {
                states: ["In Review"],
              },
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message:
          "workspace.retention.states and workspace.retention.stale_after_days must be configured together.",
      },
    });
  });

  it("rejects retention states that could delete active or terminal workspaces", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
            workspace: {
              retention: {
                states: ["In Progress"],
                stale_after_days: 30,
              },
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.configInvalid,
        message:
          "workspace.retention.states must not overlap active or terminal tracker states.",
      },
    });
  });
});
