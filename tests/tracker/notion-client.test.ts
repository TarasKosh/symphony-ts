import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import { NotionTrackerClient, type TrackerError } from "../../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotionTrackerClient", () => {
  it("fetches candidate issues via data source queries, pagination, sorts, and blocker lookups", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          dataSourceSchema({
            blockedById: "f%5C%5C%3Ap",
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            notionPage({
              id: "page-1",
              key: "NOTION-1",
              title: "First task",
              state: "Todo",
              blockedBy: {
                relation: [{ id: "blocker-1" }],
                has_more: true,
              },
              createdTime: "2026-03-01T00:00:00.000Z",
            }),
          ],
          has_more: true,
          next_cursor: "cursor-1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            notionPage({
              id: "page-2",
              key: "NOTION-2",
              title: "Second task",
              state: "In Progress",
              createdTime: "2026-03-02T00:00:00.000Z",
            }),
          ],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            {
              object: "property_item",
              id: "blocked-by-id",
              type: "relation",
              relation: {
                id: "blocker-1",
              },
            },
          ],
          has_more: false,
          next_cursor: null,
          type: "property_item",
          property_item: {
            id: "f%5C%5C%3Ap",
            type: "relation",
            next_url: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "blocker-1",
            key: "NOTION-0",
            title: "Blocking task",
            state: "Done",
          }),
        ),
      );

    const client = createClient({ fetchFn });
    const issues = await client.fetchCandidateIssues();

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "NOTION-1",
      "NOTION-2",
    ]);
    expect(issues[0]?.blockedBy).toEqual([
      {
        id: "blocker-1",
        identifier: "NOTION-0",
        state: "Done",
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(5);

    const schemaCall = fetchFn.mock.calls[0];
    expect(schemaCall?.[0]).toBe(
      "https://api.notion.com/v1/data_sources/data-source-1",
    );
    expect(getHeader(schemaCall?.[1], "authorization")).toBe(
      "Bearer notion-token",
    );
    expect(getHeader(schemaCall?.[1], "notion-version")).toBe("2026-03-11");

    const firstQuery = parseRequestBody(fetchFn.mock.calls[1]?.[1]);
    expect(firstQuery).toEqual({
      filter: {
        property: "status-id",
        status: {
          equals: ["Todo", "In Progress"],
        },
      },
      sorts: [
        {
          timestamp: "created_time",
          direction: "ascending",
        },
      ],
      page_size: 100,
    });

    const secondQuery = parseRequestBody(fetchFn.mock.calls[2]?.[1]);
    expect(secondQuery).toEqual({
      filter: {
        property: "status-id",
        status: {
          equals: ["Todo", "In Progress"],
        },
      },
      sorts: [
        {
          timestamp: "created_time",
          direction: "ascending",
        },
      ],
      page_size: 100,
      start_cursor: "cursor-1",
    });

    const relationUrl = new URL(fetchFn.mock.calls[3]?.[0] as string);
    expect(relationUrl.pathname).toBe(
      "/v1/pages/page-1/properties/f%5C%5C%3Ap",
    );
    expect(relationUrl.searchParams.get("page_size")).toBe("100");
  });

  it("hydrates missing blocker pages sequentially", async () => {
    let step = 0;
    let firstBlockerResolved = false;
    let hasFirstBlockerResolver = false;
    let secondCalledBeforeFirstResolved = false;
    let resolveFirstBlocker!: (response: Response) => void;

    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      step += 1;

      switch (step) {
        case 1:
          return jsonResponse(dataSourceSchema());
        case 2:
          return jsonResponse({
            object: "list",
            results: [
              notionPage({
                id: "page-1",
                key: "NOTION-1",
                title: "Task with two blockers",
                state: "Todo",
                blockedBy: {
                  relation: [{ id: "blocker-1" }, { id: "blocker-2" }],
                  has_more: false,
                },
              }),
            ],
            has_more: false,
            next_cursor: null,
          });
        case 3:
          return await new Promise<Response>((resolve) => {
            hasFirstBlockerResolver = true;
            resolveFirstBlocker = (response) => {
              firstBlockerResolved = true;
              resolve(response);
            };
          });
        case 4:
          secondCalledBeforeFirstResolved = !firstBlockerResolved;
          return jsonResponse(
            notionPage({
              id: "blocker-2",
              key: "NOTION-3",
              title: "Second blocker",
              state: "Done",
            }),
          );
        default:
          throw new Error(`Unexpected fetch step ${step} for ${String(input)}`);
      }
    });

    const client = createClient({ fetchFn });
    const issuesPromise = client.fetchCandidateIssues();

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(step).toBe(3);
    if (!hasFirstBlockerResolver) {
      throw new Error("Expected first blocker request to be pending.");
    }

    resolveFirstBlocker(
      jsonResponse(
        notionPage({
          id: "blocker-1",
          key: "NOTION-2",
          title: "First blocker",
          state: "Done",
        }),
      ),
    );

    const issues = await issuesPromise;

    expect(step).toBe(4);
    expect(secondCalledBeforeFirstResolved).toBe(false);
    expect(issues[0]?.blockedBy).toEqual([
      {
        id: "blocker-1",
        identifier: "NOTION-2",
        state: "Done",
      },
      {
        id: "blocker-2",
        identifier: "NOTION-3",
        state: "Done",
      },
    ]);
  });

  it("retries rate-limited blocker lookups using Retry-After", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            notionPage({
              id: "page-1",
              key: "NOTION-1",
              title: "Task with one blocker",
              state: "Todo",
              blockedBy: {
                relation: [{ id: "blocker-1" }],
                has_more: false,
              },
            }),
          ],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "rate_limited",
            message: "Back off a little.",
          },
          429,
          {
            "retry-after": "0",
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "blocker-1",
            key: "NOTION-0",
            title: "Blocking task",
            state: "Done",
          }),
        ),
      );

    const client = createClient({ fetchFn });

    await expect(client.fetchCandidateIssues()).resolves.toEqual([
      expect.objectContaining({
        identifier: "NOTION-1",
        blockedBy: [
          {
            id: "blocker-1",
            identifier: "NOTION-0",
            state: "Done",
          },
        ],
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("returns empty immediately when fetchIssuesByStates receives no states", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createClient({ fetchFn });

    await expect(client.fetchIssuesByStates([])).resolves.toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retrieves issue states by page ids", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-1",
            key: "NOTION-1",
            state: "Done",
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-2",
            key: "NOTION-2",
            state: "Canceled",
          }),
        ),
      );

    const client = createClient({ fetchFn });

    await expect(
      client.fetchIssueStatesByIds(["page-1", "page-2"]),
    ).resolves.toEqual([
      {
        id: "page-1",
        identifier: "NOTION-1",
        state: "Done",
      },
      {
        id: "page-2",
        identifier: "NOTION-2",
        state: "Canceled",
      },
    ]);
  });

  it("reads Notion page body and comments as ticket context", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            {
              object: "block",
              id: "block-1",
              type: "paragraph",
              created_time: "2026-07-02T08:00:00.000Z",
              created_by: {
                object: "user",
                id: "user-1",
                name: "Operator",
              },
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    plain_text:
                      "Implement Symphony ticket context reads before blocking.",
                    text: {
                      content:
                        "Implement Symphony ticket context reads before blocking.",
                    },
                  },
                ],
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            {
              object: "comment",
              id: "comment-1",
              created_time: "2026-07-02T08:01:00.000Z",
              created_by: {
                object: "user",
                id: "user-2",
                name: "Reviewer",
              },
              rich_text: [
                {
                  type: "text",
                  plain_text:
                    "Acceptance: the agent can ask questions and write notes in the ticket.",
                  text: {
                    content:
                      "Acceptance: the agent can ask questions and write notes in the ticket.",
                  },
                },
              ],
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.readIssueContext({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
      }),
    ).resolves.toEqual({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "In Progress",
      },
      entries: [
        {
          source: "body",
          id: "block-1",
          text: "Implement Symphony ticket context reads before blocking.",
          createdAt: "2026-07-02T08:00:00.000Z",
          author: "Operator",
        },
        {
          source: "comment",
          id: "comment-1",
          text: "Acceptance: the agent can ask questions and write notes in the ticket.",
          createdAt: "2026-07-02T08:01:00.000Z",
          author: "Reviewer",
        },
      ],
      unavailableSources: [],
    });

    const bodyUrl = new URL(fetchFn.mock.calls[0]?.[0] as string);
    expect(bodyUrl.pathname).toBe("/v1/blocks/page-1/children");
    expect(bodyUrl.searchParams.get("page_size")).toBe("100");

    const commentsUrl = new URL(fetchFn.mock.calls[1]?.[0] as string);
    expect(commentsUrl.pathname).toBe("/v1/comments");
    expect(commentsUrl.searchParams.get("block_id")).toBe("page-1");
    expect(commentsUrl.searchParams.get("page_size")).toBe("100");
  });

  it("omits missing or inaccessible pages during state refresh", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "object_not_found",
            message: "Page is gone.",
          },
          404,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-2",
            key: "NOTION-2",
            state: "Done",
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "restricted_resource",
            message: "No access to this page.",
          },
          403,
        ),
      );

    const client = createClient({ fetchFn });

    await expect(
      client.fetchIssueStatesByIds(["page-1", "page-2", "page-3"]),
    ).resolves.toEqual([
      {
        id: "page-2",
        identifier: "NOTION-2",
        state: "Done",
      },
    ]);
  });

  it("claims a Notion status property by patching the configured state option", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-1",
            key: "NOTION-1",
            state: "In Progress",
          }),
        ),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.claimIssue({
        issue: createIssue({ id: "page-1", state: "Todo" }),
        lifecycle: {
          ...createLifecycle(),
          handoffStates: ["Review", "In Review"],
        },
      }),
    ).resolves.toEqual({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "In Progress",
      },
      state: "In Progress",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const patchCall = fetchFn.mock.calls[1];
    expect(patchCall?.[0]).toBe("https://api.notion.com/v1/pages/page-1");
    expect(patchCall?.[1]?.method).toBe("PATCH");
    expect(parseRequestBody(patchCall?.[1])).toEqual({
      properties: {
        Status: {
          status: {
            name: "In Progress",
          },
        },
      },
    });
  });

  it("updates select-backed status properties with the select payload shape", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(dataSourceSchema({ statusType: "select" })),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-1",
            key: "NOTION-1",
            state: "Review",
            statusType: "select",
          }),
        ),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.handoffIssue({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
        lifecycle: {
          ...createLifecycle(),
          handoffStates: ["Review", "In Review"],
        },
        metadata: {
          readyForReview: true,
          prUrl: "https://github.com/acme/repo/pull/12",
          prNumber: "12",
          headSha: "abc123",
          validationSummary: "pnpm test passed",
          risks: null,
        },
      }),
    ).resolves.toMatchObject({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "Review",
      },
      state: "Review",
    });

    expect(parseRequestBody(fetchFn.mock.calls[1]?.[1])).toEqual({
      properties: {
        Status: {
          select: {
            name: "Review",
          },
        },
      },
    });
  });

  it("posts blocker questions before moving the page to the configured blocked state", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          dataSourceSchema({
            statusOptions: ["Todo", "In Progress", "Blocked"],
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ object: "comment", id: "comment-1" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-1",
            key: "NOTION-1",
            state: "Blocked",
          }),
        ),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.blockIssue({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
        lifecycle: {
          ...createLifecycle(),
          blockedState: "Blocked",
        },
        metadata: {
          title: null,
          details: "The task is missing acceptance criteria.",
          questions: [
            "Which user flow should this change affect?",
            "What observable acceptance check proves this is done?",
          ],
        },
      }),
    ).resolves.toEqual({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "Blocked",
      },
      state: "Blocked",
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      "https://api.notion.com/v1/comments",
    );
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(parseRequestBody(fetchFn.mock.calls[1]?.[1])).toEqual({
      parent: {
        page_id: "page-1",
      },
      rich_text: [
        {
          type: "text",
          text: {
            content:
              "Blocked: clarification needed\n\nThe task is missing acceptance criteria.\n\n1. Which user flow should this change affect?\n2. What observable acceptance check proves this is done?",
          },
        },
      ],
    });
    expect(parseRequestBody(fetchFn.mock.calls[2]?.[1])).toEqual({
      properties: {
        Status: {
          status: {
            name: "Blocked",
          },
        },
      },
    });
  });

  it("falls back to appending blocker questions to the page when Notion comments are forbidden", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          dataSourceSchema({
            statusOptions: ["Todo", "In Progress", "Blocked"],
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "restricted_resource",
            message: "Insufficient permissions for this endpoint.",
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ object: "list", results: [], has_more: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          notionPage({
            id: "page-1",
            key: "NOTION-1",
            state: "Blocked",
          }),
        ),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.blockIssue({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
        lifecycle: {
          ...createLifecycle(),
          blockedState: "Blocked",
        },
        metadata: {
          title: "Blocked: task needs implementation context",
          details: "The task has no usable description.",
          questions: ["What exact behavior should change?"],
        },
      }),
    ).resolves.toMatchObject({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "Blocked",
      },
      state: "Blocked",
    });

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(
      "https://api.notion.com/v1/comments",
    );
    expect(fetchFn.mock.calls[2]?.[0]).toBe(
      "https://api.notion.com/v1/blocks/page-1/children",
    );
    expect(fetchFn.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(parseRequestBody(fetchFn.mock.calls[2]?.[1])).toEqual({
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content:
                    "Blocked: task needs implementation context\n\nThe task has no usable description.\n\n1. What exact behavior should change?",
                },
              },
            ],
          },
        },
      ],
    });
    expect(parseRequestBody(fetchFn.mock.calls[3]?.[1])).toEqual({
      properties: {
        Status: {
          status: {
            name: "Blocked",
          },
        },
      },
    });
  });

  it("appends ordinary issue notes through the Notion ticket write path", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ object: "comment", id: "comment-1" }),
      );
    const client = createClient({ fetchFn });

    await expect(
      client.appendIssueNote({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
        metadata: {
          title: "Implementation checkpoint",
          body: "Read the ticket context and started implementation.",
        },
      }),
    ).resolves.toEqual({
      issue: {
        id: "page-1",
        identifier: "NOTION-1",
        state: "In Progress",
      },
      destination: "comment",
      metadata: {
        title: "Implementation checkpoint",
        body: "Read the ticket context and started implementation.",
      },
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      "https://api.notion.com/v1/comments",
    );
    expect(parseRequestBody(fetchFn.mock.calls[0]?.[1])).toEqual({
      parent: {
        page_id: "page-1",
      },
      rich_text: [
        {
          type: "text",
          text: {
            content:
              "Implementation checkpoint\n\nRead the ticket context and started implementation.",
          },
        },
      ],
    });
  });

  it("rejects missing configured lifecycle options with the available Notion options", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        dataSourceSchema({
          statusOptions: ["Todo", "In Progress"],
        }),
      ),
    );
    const client = createClient({ fetchFn });

    await expect(
      client.handoffIssue({
        issue: createIssue({ id: "page-1", state: "In Progress" }),
        lifecycle: {
          ...createLifecycle(),
          handoffStates: ["In Review", "Review"],
        },
        metadata: {
          readyForReview: true,
          prUrl: null,
          prNumber: null,
          headSha: null,
          validationSummary: null,
          risks: null,
        },
      }),
    ).rejects.toThrow(
      "tracker.handoff_states did not match any Notion status option. Available options: Todo, In Progress.",
    );
  });

  it("retries schema loading after a transient schema fetch failure", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "internal_server_error",
            message: "Notion hiccuped.",
          },
          500,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
      .mockResolvedValueOnce(
        jsonResponse({
          object: "list",
          results: [
            notionPage({
              id: "page-1",
              key: "NOTION-1",
              title: "Recovered task",
              state: "Todo",
            }),
          ],
          has_more: false,
          next_cursor: null,
        }),
      );

    const client = createClient({ fetchFn });

    await expect(client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.notionApiStatus,
        status: 500,
      }),
    );
    await expect(client.fetchCandidateIssues()).resolves.toEqual([
      expect.objectContaining({
        id: "page-1",
        identifier: "NOTION-1",
        state: "Todo",
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("maps missing auth and missing data source configuration to typed errors", async () => {
    const missingAuthClient = createClient({
      apiKey: null,
      fetchFn: vi.fn<typeof fetch>(),
    });
    const missingDataSourceClient = createClient({
      dataSourceId: null,
      fetchFn: vi.fn<typeof fetch>(),
    });

    await expect(missingAuthClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerApiKey,
      }),
    );
    await expect(
      missingDataSourceClient.fetchCandidateIssues(),
    ).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.missingTrackerDataSourceId,
      }),
    );
  });

  it("maps non-200 responses, malformed pagination, and transport failures", async () => {
    const non200Client = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
        .mockImplementation(async () =>
          jsonResponse(
            {
              code: "rate_limited",
              message: "You have been rate limited.",
            },
            429,
            {
              "retry-after": "0",
            },
          ),
        ),
    });
    await expect(non200Client.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.notionApiStatus,
        status: 429,
      }),
    );

    const malformedCursorClient = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(dataSourceSchema()))
        .mockResolvedValueOnce(
          jsonResponse({
            object: "list",
            results: [],
            has_more: true,
            next_cursor: null,
          }),
        ),
    });
    await expect(malformedCursorClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.notionMissingNextCursor,
      }),
    );

    const transportClient = createClient({
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network down")),
    });
    await expect(transportClient.fetchCandidateIssues()).rejects.toThrow(
      expect.objectContaining<Partial<TrackerError>>({
        code: ERROR_CODES.notionApiRequest,
      }),
    );
  });
});

function createClient(
  overrides: Partial<ConstructorParameters<typeof NotionTrackerClient>[0]> = {},
): NotionTrackerClient {
  return new NotionTrackerClient({
    endpoint: "https://api.notion.com/v1",
    apiKey: "notion-token",
    activeStates: ["Todo", "In Progress"],
    dataSourceId: "data-source-1",
    titleProperty: "Name",
    statusProperty: "Status",
    identifierProperty: "Key",
    descriptionProperty: "Description",
    priorityProperty: "Priority",
    labelsProperty: "Labels",
    blockedByProperty: "Blocked by",
    fetchFn: overrides.fetchFn ?? vi.fn<typeof fetch>(),
    ...overrides,
  });
}

function dataSourceSchema(
  overrides: {
    blockedById?: string;
    statusType?: "status" | "select";
    statusOptions?: string[];
  } = {},
): unknown {
  const statusType = overrides.statusType ?? "status";
  const statusOptions = overrides.statusOptions ?? [
    "Todo",
    "In Progress",
    "In Review",
    "Review",
    "Done",
  ];
  return {
    object: "data_source",
    id: "data-source-1",
    properties: {
      Name: {
        id: "title",
        type: "title",
      },
      Status: {
        id: "status-id",
        type: statusType,
        [statusType]: {
          options: statusOptions.map((name) => ({ name })),
        },
      },
      Key: {
        id: "key-id",
        type: "rich_text",
      },
      Description: {
        id: "description-id",
        type: "rich_text",
      },
      Priority: {
        id: "priority-id",
        type: "select",
      },
      Labels: {
        id: "labels-id",
        type: "multi_select",
      },
      "Blocked by": {
        id: overrides.blockedById ?? "blocked-id",
        type: "relation",
      },
    },
  };
}

function notionPage(input: {
  id: string;
  key?: string;
  title?: string;
  state: string;
  statusType?: "status" | "select";
  blockedBy?: {
    relation: Array<{ id: string }>;
    has_more: boolean;
  };
  createdTime?: string;
}): unknown {
  const statusType = input.statusType ?? "status";
  return {
    object: "page",
    id: input.id,
    url: `https://www.notion.so/${input.id}`,
    created_time: input.createdTime ?? "2026-03-01T00:00:00.000Z",
    last_edited_time: "2026-03-02T00:00:00.000Z",
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: input.title === undefined ? [] : [{ plain_text: input.title }],
      },
      Status: {
        id: "status-id",
        type: statusType,
        [statusType]: {
          name: input.state,
        },
      },
      Key:
        input.key === undefined
          ? {
              id: "key-id",
              type: "rich_text",
              rich_text: [],
            }
          : {
              id: "key-id",
              type: "rich_text",
              rich_text: [{ plain_text: input.key }],
            },
      Description: {
        id: "description-id",
        type: "rich_text",
        rich_text: [],
      },
      Priority: {
        id: "priority-id",
        type: "select",
        select: null,
      },
      Labels: {
        id: "labels-id",
        type: "multi_select",
        multi_select: [],
      },
      "Blocked by": {
        id: "blocked-id",
        type: "relation",
        relation: input.blockedBy?.relation ?? [],
        has_more: input.blockedBy?.has_more ?? false,
      },
    },
  };
}

function createIssue(
  overrides: Partial<import("../../src/domain/model.js").Issue> = {},
) {
  return {
    id: "page-1",
    identifier: "NOTION-1",
    title: "Task",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function createLifecycle() {
  return {
    claimState: "In Progress",
    handoffStates: ["In Review", "Review"],
    blockedState: "Needs decision",
    requireClaimBeforeAgent: true,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  expect(init?.body).toBeTypeOf("string");
  return JSON.parse(init?.body as string) as unknown;
}

function getHeader(
  init: RequestInit | undefined,
  headerName: string,
): string | null {
  return new Headers(init?.headers).get(headerName);
}
