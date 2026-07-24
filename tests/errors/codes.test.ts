import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";

describe("ERROR_CODES", () => {
  it("contains the typed workflow parsing failures required by the spec", () => {
    expect(ERROR_CODES.missingWorkflowFile).toBe("missing_workflow_file");
    expect(ERROR_CODES.workflowParseError).toBe("workflow_parse_error");
    expect(ERROR_CODES.workflowFrontMatterNotAMap).toBe(
      "workflow_front_matter_not_a_map",
    );
    expect(ERROR_CODES.workflowNotFound).toBe("workflow_not_found");
    expect(ERROR_CODES.workflowYamlInvalid).toBe("workflow_yaml_invalid");
    expect(ERROR_CODES.workflowFrontmatterNotMap).toBe(
      "workflow_frontmatter_not_map",
    );
  });

  it("contains the mandatory workspace and codex failure families", () => {
    expect(ERROR_CODES.workspaceRootEscape).toBe("workspace_root_escape");
    expect(ERROR_CODES.invalidWorkspaceCwd).toBe("invalid_workspace_cwd");
    expect(ERROR_CODES.hookTimedOut).toBe("hook_timed_out");
    expect(ERROR_CODES.missingTrackerApiKey).toBe("missing_tracker_api_key");
    expect(ERROR_CODES.missingTrackerProjectSlug).toBe(
      "missing_tracker_project_slug",
    );
    expect(ERROR_CODES.missingTrackerDataSourceId).toBe(
      "missing_tracker_data_source_id",
    );
    expect(ERROR_CODES.linearApiRequest).toBe("linear_api_request");
    expect(ERROR_CODES.linearApiStatus).toBe("linear_api_status");
    expect(ERROR_CODES.linearGraphqlErrors).toBe("linear_graphql_errors");
    expect(ERROR_CODES.linearUnknownPayload).toBe("linear_unknown_payload");
    expect(ERROR_CODES.linearMissingEndCursor).toBe(
      "linear_missing_end_cursor",
    );
    expect(ERROR_CODES.notionApiRequest).toBe("notion_api_request");
    expect(ERROR_CODES.notionApiStatus).toBe("notion_api_status");
    expect(ERROR_CODES.notionUnknownPayload).toBe("notion_unknown_payload");
    expect(ERROR_CODES.notionMissingNextCursor).toBe(
      "notion_missing_next_cursor",
    );
    expect(ERROR_CODES.codexReadTimeout).toBe("codex_read_timeout");
    expect(ERROR_CODES.codexTurnTimeout).toBe("codex_turn_timeout");
    expect(ERROR_CODES.githubCliNotFound).toBe("github_cli_not_found");
    expect(ERROR_CODES.githubAuthInvalid).toBe("github_auth_invalid");
    expect(ERROR_CODES.githubRemoteMissing).toBe("github_remote_missing");
    expect(ERROR_CODES.githubPermissionDenied).toBe("github_permission_denied");
    expect(ERROR_CODES.githubCapabilityTransient).toBe(
      "github_capability_transient",
    );
    expect(ERROR_CODES.requiredCommandNotFound).toBe(
      "required_command_not_found",
    );
    expect(ERROR_CODES.requiredCommandExecutionDenied).toBe(
      "required_command_execution_denied",
    );
    expect(ERROR_CODES.requiredCommandCapabilityTransient).toBe(
      "required_command_capability_transient",
    );
  });
});
