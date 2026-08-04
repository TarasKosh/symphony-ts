import {
  DEFAULT_NOTION_ENDPOINT,
  DEFAULT_NOTION_NETWORK_TIMEOUT_MS,
  DEFAULT_NOTION_PAGE_SIZE,
  DEFAULT_NOTION_VERSION,
} from "../config/defaults.js";
import type { Issue } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import { TrackerError, toTrackerRequestErrorWithCode } from "./errors.js";
import {
  type NotionIssuePropertyMap,
  type NotionPropertyDescriptor,
  normalizeNotionIssue,
  normalizeNotionIssueState,
  readNotionIssuePreview,
  readNotionRelationPropertyIds,
  relationPropertyHasMore,
} from "./notion-normalize.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
  TrackerBlockerMetadata,
  TrackerHandoffMetadata,
  TrackerIssueContext,
  TrackerIssueContextEntry,
  TrackerIssueNoteMetadata,
  TrackerIssueNoteResult,
  TrackerLifecycleConfig,
  TrackerLifecycleTransitionResult,
} from "./tracker.js";

export interface NotionTrackerAdapterOptions {
  dataSourceId: string | null;
  titleProperty: string | null;
  statusProperty: string | null;
  identifierProperty: string | null;
  descriptionProperty: string | null;
  priorityProperty: string | null;
  labelsProperty: string | null;
  blockedByProperty: string | null;
}

export interface NotionTrackerClientOptions
  extends NotionTrackerAdapterOptions {
  endpoint?: string;
  apiKey: string | null;
  activeStates: string[];
  notionVersion?: string;
  pageSize?: number;
  networkTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface NotionDataSourceResponse {
  id?: unknown;
  properties?: unknown;
}

interface NotionQueryResponse {
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionPropertyListResponse {
  object?: unknown;
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionListResponse {
  object?: unknown;
  results?: unknown;
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionPageLike {
  object?: unknown;
  id?: unknown;
  properties?: unknown;
}

interface NotionErrorBody {
  code?: unknown;
  message?: unknown;
  additional_data?: unknown;
}

interface NotionResolvedSchema {
  properties: NotionIssuePropertyMap;
}

const NOTION_RETRIABLE_STATUS_CODES = new Set([429, 529]);
const NOTION_MAX_RATE_LIMIT_RETRIES = 2;
const NOTION_FALLBACK_RETRY_AFTER_MS = 1_000;

export class NotionTrackerClient implements IssueTracker {
  private readonly endpoint: string;
  private readonly apiKey: string | null;
  private readonly activeStates: string[];
  private readonly notionVersion: string;
  private readonly pageSize: number;
  private readonly networkTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly adapterOptions: NotionTrackerAdapterOptions;
  private schemaPromise: Promise<NotionResolvedSchema> | null = null;

  constructor(options: NotionTrackerClientOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_NOTION_ENDPOINT;
    this.apiKey = options.apiKey;
    this.activeStates = [...options.activeStates];
    this.notionVersion = options.notionVersion ?? DEFAULT_NOTION_VERSION;
    this.pageSize = clampPageSize(options.pageSize ?? DEFAULT_NOTION_PAGE_SIZE);
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_NOTION_NETWORK_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.adapterOptions = {
      dataSourceId: options.dataSourceId,
      titleProperty: options.titleProperty,
      statusProperty: options.statusProperty,
      identifierProperty: options.identifierProperty ?? null,
      descriptionProperty: options.descriptionProperty ?? null,
      priorityProperty: options.priorityProperty ?? null,
      labelsProperty: options.labelsProperty ?? null,
      blockedByProperty: options.blockedByProperty ?? null,
    };
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStateNames(this.activeStates);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }

    return this.fetchIssuesByStateNames(stateNames);
  }

  async fetchIssueStatesByIds(
    issueIds: string[],
  ): Promise<IssueStateSnapshot[]> {
    if (issueIds.length === 0) {
      return [];
    }

    const schema = await this.getSchema();
    const snapshots = await Promise.all(
      issueIds.map(async (issueId) => {
        try {
          return normalizeNotionIssueState(await this.retrievePage(issueId), {
            status: schema.properties.status,
            identifier: schema.properties.identifier,
          });
        } catch (error) {
          if (isNotionMissingPageError(error)) {
            return null;
          }

          throw error;
        }
      }),
    );

    return snapshots.filter(
      (snapshot): snapshot is IssueStateSnapshot => snapshot !== null,
    );
  }

  async readIssueContext(input: {
    issue: Issue;
  }): Promise<TrackerIssueContext> {
    const entries: TrackerIssueContextEntry[] = [];
    const unavailableSources: TrackerIssueContext["unavailableSources"] = [];
    const [bodyResult, commentsResult] = await Promise.allSettled([
      this.readPageBodyEntries(input.issue.id),
      this.readPageCommentEntries(input.issue.id),
    ]);

    if (bodyResult.status === "fulfilled") {
      entries.push(...bodyResult.value);
    } else {
      unavailableSources.push({
        source: "body",
        error: toErrorMessage(
          bodyResult.reason,
          "Notion page body could not be read.",
        ),
      });
    }

    if (commentsResult.status === "fulfilled") {
      entries.push(...commentsResult.value);
    } else {
      unavailableSources.push({
        source: "comments",
        error: toErrorMessage(
          commentsResult.reason,
          "Notion comments could not be read.",
        ),
      });
    }

    entries.sort(compareContextEntries);

    return {
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier,
        state: input.issue.state,
      },
      entries,
      unavailableSources,
    };
  }

  async claimIssue(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
  }): Promise<TrackerLifecycleTransitionResult> {
    const state = requireConfiguredLifecycleState(
      input.lifecycle.claimState,
      "tracker.claim_state",
    );
    return this.transitionIssueStatus({
      issue: input.issue,
      state,
      field: "tracker.claim_state",
    });
  }

  async handoffIssue(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
    metadata: TrackerHandoffMetadata;
  }): Promise<TrackerLifecycleTransitionResult> {
    if (!input.metadata.readyForReview) {
      throw new TrackerError(
        ERROR_CODES.configInvalid,
        "symphony_handoff requires ready_for_review=true before moving the tracker ticket.",
      );
    }

    const state = await this.selectConfiguredLifecycleState({
      states: input.lifecycle.handoffStates,
      field: "tracker.handoff_states",
    });
    return this.transitionIssueStatus({
      issue: input.issue,
      state,
      field: "tracker.handoff_states",
    });
  }

  async blockIssue(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
    metadata: TrackerBlockerMetadata;
  }): Promise<TrackerLifecycleTransitionResult> {
    const state = requireConfiguredLifecycleState(
      input.lifecycle.blockedState,
      "tracker.blocked_state",
    );
    const schema = await this.getSchema();
    requireStatusOption(schema.properties.status, {
      state,
      field: "tracker.blocked_state",
    });

    await this.createBlockerComment({
      issue: input.issue,
      metadata: input.metadata,
    });
    return this.transitionIssueStatus({
      issue: input.issue,
      state,
      field: "tracker.blocked_state",
    });
  }

  async appendIssueNote(input: {
    issue: Issue;
    metadata: TrackerIssueNoteMetadata;
  }): Promise<TrackerIssueNoteResult> {
    const destination = await this.writeIssueNoteContent({
      issue: input.issue,
      content: formatIssueNote(input.metadata),
    });

    return {
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier,
        state: input.issue.state,
      },
      destination,
      metadata: input.metadata,
    };
  }

  private async fetchIssuesByStateNames(
    stateNames: string[],
  ): Promise<Issue[]> {
    const schema = await this.getSchema();
    const pages = await this.queryAllPages({
      filter: buildStateFilter(schema.properties.status, stateNames),
      sorts: [
        {
          timestamp: "created_time",
          direction: "ascending",
        },
      ],
    });
    const relationIdsByPage = await this.loadBlockedByRelations(
      pages,
      schema.properties.blockedBy,
    );
    const blockerLookup = await this.loadBlockerLookup(
      pages,
      relationIdsByPage,
      schema.properties,
    );

    return pages.map((page) => {
      const pageId = requirePageId(page);
      return normalizeNotionIssue(page, {
        properties: schema.properties,
        blockedByIds: relationIdsByPage.get(pageId) ?? [],
        blockerLookup,
      });
    });
  }

  private async selectConfiguredLifecycleState(input: {
    states: readonly string[];
    field: string;
  }): Promise<string> {
    const candidates = input.states.filter((state) => state.trim() !== "");
    if (candidates.length === 0) {
      throw new TrackerError(
        ERROR_CODES.configInvalid,
        `${input.field} must include at least one configured state.`,
      );
    }

    const schema = await this.getSchema();
    const available = readStatusOptionNames(schema.properties.status);
    const selected = candidates.find((state) => available.includes(state));
    if (selected === undefined) {
      throw new TrackerError(
        ERROR_CODES.configInvalid,
        `${input.field} did not match any Notion status option. Available options: ${formatAvailableOptions(available)}.`,
        { details: available },
      );
    }

    return selected;
  }

  private async transitionIssueStatus(input: {
    issue: Issue;
    state: string;
    field: string;
  }): Promise<TrackerLifecycleTransitionResult> {
    const schema = await this.getSchema();
    requireStatusOption(schema.properties.status, {
      state: input.state,
      field: input.field,
    });

    if (input.issue.state === input.state) {
      return {
        issue: {
          id: input.issue.id,
          identifier: input.issue.identifier,
          state: input.issue.state,
        },
        state: input.issue.state,
      };
    }

    const page = await this.requestJson<unknown>({
      method: "PATCH",
      path: `/pages/${encodeURIComponent(input.issue.id)}`,
      body: {
        properties: {
          [schema.properties.status.name]: {
            [schema.properties.status.type]: {
              name: input.state,
            },
          },
        },
      },
    });
    const snapshot = normalizeNotionIssueState(page, {
      status: schema.properties.status,
      identifier: schema.properties.identifier,
    });

    if (snapshot.state !== input.state) {
      throw new TrackerError(
        ERROR_CODES.notionUnknownPayload,
        `Notion status update returned state '${snapshot.state}' instead of '${input.state}'.`,
        { details: snapshot },
      );
    }

    return {
      issue: snapshot,
      state: snapshot.state,
    };
  }

  private async getSchema(): Promise<NotionResolvedSchema> {
    if (this.schemaPromise === null) {
      const schemaPromise = this.loadSchema().catch((error) => {
        if (this.schemaPromise === schemaPromise) {
          this.schemaPromise = null;
        }

        throw error;
      });
      this.schemaPromise = schemaPromise;
    }

    return this.schemaPromise;
  }

  private async loadSchema(): Promise<NotionResolvedSchema> {
    const dataSourceId = this.requireDataSourceId();
    const response = await this.requestJson<NotionDataSourceResponse>({
      method: "GET",
      path: `/data_sources/${encodeURIComponent(dataSourceId)}`,
    });

    if (
      !response.properties ||
      typeof response.properties !== "object" ||
      Array.isArray(response.properties)
    ) {
      throw new TrackerError(
        ERROR_CODES.notionUnknownPayload,
        "Notion data source payload was missing properties.",
        { details: response },
      );
    }

    const schemaProperties = response.properties as Record<string, unknown>;

    return {
      properties: {
        title: requireSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.titleProperty,
          field: "tracker.title_property",
          allowedTypes: ["title"],
        }),
        status: requireSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.statusProperty,
          field: "tracker.status_property",
          allowedTypes: ["status", "select"],
        }),
        identifier: resolveSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.identifierProperty,
          field: "tracker.identifier_property",
          required: false,
          allowedTypes: [
            "formula",
            "number",
            "rich_text",
            "select",
            "status",
            "title",
            "unique_id",
          ],
        }),
        description: resolveSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.descriptionProperty,
          field: "tracker.description_property",
          required: false,
          allowedTypes: ["rich_text", "title"],
        }),
        priority: resolveSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.priorityProperty,
          field: "tracker.priority_property",
          required: false,
          allowedTypes: ["formula", "number", "select", "status"],
        }),
        labels: resolveSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.labelsProperty,
          field: "tracker.labels_property",
          required: false,
          allowedTypes: ["multi_select", "select"],
        }),
        blockedBy: resolveSchemaProperty(schemaProperties, {
          configured: this.adapterOptions.blockedByProperty,
          field: "tracker.blocked_by_property",
          required: false,
          allowedTypes: ["relation"],
        }),
      },
    };
  }

  private async queryAllPages(input: {
    filter: Record<string, unknown>;
    sorts: readonly Record<string, unknown>[];
  }): Promise<unknown[]> {
    const results: unknown[] = [];
    let startCursor: string | null = null;

    while (true) {
      const response: NotionQueryResponse = await this.requestJson({
        method: "POST",
        path: `/data_sources/${encodeURIComponent(this.requireDataSourceId())}/query`,
        body: {
          filter: input.filter,
          sorts: input.sorts,
          page_size: this.pageSize,
          ...(startCursor === null ? {} : { start_cursor: startCursor }),
        },
      });

      if (!Array.isArray(response.results)) {
        throw new TrackerError(
          ERROR_CODES.notionUnknownPayload,
          "Notion query payload was missing results.",
          { details: response },
        );
      }

      results.push(
        ...response.results.filter(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === "object" &&
            (entry as NotionPageLike).object === "page",
        ),
      );

      if (response.has_more !== true) {
        break;
      }

      if (
        typeof response.next_cursor !== "string" ||
        response.next_cursor.trim() === ""
      ) {
        throw new TrackerError(
          ERROR_CODES.notionMissingNextCursor,
          "Notion pagination indicated more results without a next_cursor.",
          { details: response },
        );
      }

      startCursor = response.next_cursor;
    }

    return results;
  }

  private async loadBlockedByRelations(
    pages: readonly unknown[],
    blockedByProperty: NotionPropertyDescriptor | null,
  ): Promise<Map<string, string[]>> {
    const relationIdsByPage = new Map<string, string[]>();
    if (blockedByProperty === null) {
      return relationIdsByPage;
    }

    await Promise.all(
      pages.map(async (page) => {
        const pageId = requirePageId(page);
        const propertyValue = getPagePropertyValue(page, blockedByProperty);
        if (propertyValue === null) {
          relationIdsByPage.set(pageId, []);
          return;
        }

        const relationIds = relationPropertyHasMore(propertyValue)
          ? await this.retrieveRelationPropertyIds(pageId, blockedByProperty.id)
          : readNotionRelationPropertyIds(propertyValue);
        relationIdsByPage.set(pageId, relationIds);
      }),
    );

    return relationIdsByPage;
  }

  private async loadBlockerLookup(
    pages: readonly unknown[],
    relationIdsByPage: ReadonlyMap<string, readonly string[]>,
    properties: NotionIssuePropertyMap,
  ): Promise<Map<string, { identifier: string | null; state: string | null }>> {
    const lookup = new Map<
      string,
      { identifier: string | null; state: string | null }
    >();

    for (const page of pages) {
      const preview = readNotionIssuePreview(page, {
        status: properties.status,
        identifier: properties.identifier,
      });
      lookup.set(preview.id, {
        identifier: preview.identifier,
        state: preview.state,
      });
    }

    const missingIds = new Set<string>();
    for (const relationIds of relationIdsByPage.values()) {
      for (const relationId of relationIds) {
        if (!lookup.has(relationId)) {
          missingIds.add(relationId);
        }
      }
    }

    // Hydrate missing blockers sequentially to avoid bursting past
    // Notion's per-connection rate limits when a page references many blockers.
    for (const relationId of missingIds) {
      try {
        const preview = readNotionIssuePreview(
          await this.retrievePage(relationId),
          {
            status: properties.status,
            identifier: properties.identifier,
          },
        );
        lookup.set(relationId, {
          identifier: preview.identifier,
          state: preview.state,
        });
      } catch {
        lookup.set(relationId, {
          identifier: null,
          state: null,
        });
      }
    }

    return lookup;
  }

  private async retrieveRelationPropertyIds(
    pageId: string,
    propertyId: string,
  ): Promise<string[]> {
    const relationIds: string[] = [];
    let startCursor: string | null = null;

    while (true) {
      const response: NotionPropertyListResponse = await this.requestJson({
        method: "GET",
        path: `/pages/${encodeURIComponent(pageId)}/properties/${toNotionPathSegment(propertyId)}`,
        query:
          startCursor === null
            ? {
                page_size: String(this.pageSize),
              }
            : {
                page_size: String(this.pageSize),
                start_cursor: startCursor,
              },
      });

      if (!Array.isArray(response.results)) {
        throw new TrackerError(
          ERROR_CODES.notionUnknownPayload,
          "Notion relation property payload was missing results.",
          { details: response },
        );
      }

      relationIds.push(
        ...response.results
          .map((entry: unknown) => {
            if (
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              "relation" in entry
            ) {
              const relation = (entry as { relation?: { id?: unknown } })
                .relation;
              return typeof relation?.id === "string" ? relation.id : null;
            }

            return null;
          })
          .filter((entry: string | null): entry is string => entry !== null),
      );

      if (response.has_more !== true) {
        break;
      }

      if (
        typeof response.next_cursor !== "string" ||
        response.next_cursor.trim() === ""
      ) {
        throw new TrackerError(
          ERROR_CODES.notionMissingNextCursor,
          "Notion relation property pagination was missing next_cursor.",
          { details: response },
        );
      }

      startCursor = response.next_cursor;
    }

    return relationIds;
  }

  private async retrievePage(pageId: string): Promise<unknown> {
    return this.requestJson({
      method: "GET",
      path: `/pages/${encodeURIComponent(pageId)}`,
    });
  }

  private async createBlockerComment(input: {
    issue: Issue;
    metadata: TrackerBlockerMetadata;
  }): Promise<void> {
    await this.writeIssueNoteContent({
      issue: input.issue,
      content: formatBlockerComment(input.metadata),
    });
  }

  private async writeIssueNoteContent(input: {
    issue: Issue;
    content: string;
  }): Promise<"comment" | "body"> {
    try {
      await this.requestJson<unknown>({
        method: "POST",
        path: "/comments",
        body: {
          parent: {
            page_id: input.issue.id,
          },
          rich_text: buildRichText(input.content),
        },
      });
      return "comment";
    } catch (error) {
      if (!isNotionInsufficientPermissionsError(error)) {
        throw error;
      }

      await this.appendIssuePageContent({
        issue: input.issue,
        content: input.content,
      });
      return "body";
    }
  }

  private async appendIssuePageContent(input: {
    issue: Issue;
    content: string;
  }): Promise<void> {
    await this.requestJson<unknown>({
      method: "PATCH",
      path: `/blocks/${encodeURIComponent(input.issue.id)}/children`,
      body: {
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: buildRichText(input.content),
            },
          },
        ],
      },
    });
  }

  private async readPageBodyEntries(
    pageId: string,
  ): Promise<TrackerIssueContextEntry[]> {
    const entries: TrackerIssueContextEntry[] = [];
    let startCursor: string | null = null;

    while (true) {
      const response: NotionListResponse = await this.requestJson({
        method: "GET",
        path: `/blocks/${encodeURIComponent(pageId)}/children`,
        query:
          startCursor === null
            ? {
                page_size: String(this.pageSize),
              }
            : {
                page_size: String(this.pageSize),
                start_cursor: startCursor,
              },
      });

      if (!Array.isArray(response.results)) {
        throw new TrackerError(
          ERROR_CODES.notionUnknownPayload,
          "Notion page body payload was missing results.",
          { details: response },
        );
      }

      for (const block of response.results) {
        const text = readNotionBlockPlainText(block);
        if (text === null) {
          continue;
        }

        entries.push({
          source: "body",
          id: readObjectString(block, "id"),
          text,
          createdAt: readObjectString(block, "created_time"),
          author: readNotionUserLabel(readObjectValue(block, "created_by")),
        });
      }

      if (response.has_more !== true) {
        break;
      }

      if (
        typeof response.next_cursor !== "string" ||
        response.next_cursor.trim() === ""
      ) {
        throw new TrackerError(
          ERROR_CODES.notionMissingNextCursor,
          "Notion page body pagination was missing next_cursor.",
          { details: response },
        );
      }

      startCursor = response.next_cursor;
    }

    return entries;
  }

  private async readPageCommentEntries(
    pageId: string,
  ): Promise<TrackerIssueContextEntry[]> {
    const entries: TrackerIssueContextEntry[] = [];
    let startCursor: string | null = null;

    while (true) {
      const response: NotionListResponse = await this.requestJson({
        method: "GET",
        path: "/comments",
        query:
          startCursor === null
            ? {
                block_id: pageId,
                page_size: String(this.pageSize),
              }
            : {
                block_id: pageId,
                page_size: String(this.pageSize),
                start_cursor: startCursor,
              },
      });

      if (!Array.isArray(response.results)) {
        throw new TrackerError(
          ERROR_CODES.notionUnknownPayload,
          "Notion comments payload was missing results.",
          { details: response },
        );
      }

      for (const comment of response.results) {
        const text = readRichTextArray(readObjectValue(comment, "rich_text"));
        if (text === null) {
          continue;
        }

        entries.push({
          source: "comment",
          id: readObjectString(comment, "id"),
          text,
          createdAt: readObjectString(comment, "created_time"),
          author: readNotionUserLabel(readObjectValue(comment, "created_by")),
        });
      }

      if (response.has_more !== true) {
        break;
      }

      if (
        typeof response.next_cursor !== "string" ||
        response.next_cursor.trim() === ""
      ) {
        throw new TrackerError(
          ERROR_CODES.notionMissingNextCursor,
          "Notion comments pagination was missing next_cursor.",
          { details: response },
        );
      }

      startCursor = response.next_cursor;
    }

    return entries;
  }

  private async requestJson<T>(input: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<T> {
    let response: Response | null = null;
    for (
      let attempt = 0;
      attempt <= NOTION_MAX_RATE_LIMIT_RETRIES;
      attempt += 1
    ) {
      response = await this.fetchWithTimeout(input);
      if (
        !NOTION_RETRIABLE_STATUS_CODES.has(response.status) ||
        attempt === NOTION_MAX_RATE_LIMIT_RETRIES
      ) {
        break;
      }

      await sleep(readRetryAfterMs(response) ?? NOTION_FALLBACK_RETRY_AFTER_MS);
    }

    if (response === null) {
      throw new TrackerError(
        ERROR_CODES.notionApiRequest,
        "Notion request did not produce a response.",
      );
    }

    const body = await parseNotionResponseBody(response);

    if (!response.ok) {
      const errorBody =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as NotionErrorBody)
          : null;
      const message =
        typeof errorBody?.message === "string"
          ? `Notion API request failed with HTTP ${response.status}: ${errorBody.message}`
          : `Notion API request failed with HTTP ${response.status}.`;
      throw new TrackerError(ERROR_CODES.notionApiStatus, message, {
        status: response.status,
        details: body,
      });
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new TrackerError(
        ERROR_CODES.notionUnknownPayload,
        "Notion API returned a malformed JSON payload.",
        { details: body },
      );
    }

    return body as T;
  }

  private async fetchWithTimeout(input: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  }): Promise<Response> {
    const apiKey = this.requireApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.networkTimeoutMs);

    try {
      return await this.fetchFn(
        buildNotionUrl(this.endpoint, input.path, input.query),
        {
          method: input.method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "notion-version": this.notionVersion,
          },
          ...(input.body === undefined
            ? {}
            : {
                body: JSON.stringify(input.body),
              }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw toTrackerRequestErrorWithCode(
        error,
        ERROR_CODES.notionApiRequest,
        "Notion request failed before a valid response was received.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new TrackerError(
        ERROR_CODES.missingTrackerApiKey,
        "Notion tracker API key is required.",
      );
    }

    return this.apiKey;
  }

  private requireDataSourceId(): string {
    if (
      !this.adapterOptions.dataSourceId ||
      this.adapterOptions.dataSourceId.trim() === ""
    ) {
      throw new TrackerError(
        ERROR_CODES.missingTrackerDataSourceId,
        "Notion tracker data source ID is required.",
      );
    }

    return this.adapterOptions.dataSourceId;
  }
}

export function readNotionTrackerAdapterOptions(
  adapterOptions: Readonly<Record<string, unknown>>,
): NotionTrackerAdapterOptions {
  return {
    dataSourceId: readAdapterOptionString(
      adapterOptions,
      "data_source_id",
      "dataSourceId",
    ),
    titleProperty: readAdapterOptionString(
      adapterOptions,
      "title_property",
      "titleProperty",
    ),
    statusProperty: readAdapterOptionString(
      adapterOptions,
      "status_property",
      "statusProperty",
    ),
    identifierProperty: readAdapterOptionString(
      adapterOptions,
      "identifier_property",
      "identifierProperty",
    ),
    descriptionProperty: readAdapterOptionString(
      adapterOptions,
      "description_property",
      "descriptionProperty",
    ),
    priorityProperty: readAdapterOptionString(
      adapterOptions,
      "priority_property",
      "priorityProperty",
    ),
    labelsProperty: readAdapterOptionString(
      adapterOptions,
      "labels_property",
      "labelsProperty",
    ),
    blockedByProperty: readAdapterOptionString(
      adapterOptions,
      "blocked_by_property",
      "blockedByProperty",
    ),
  };
}

function requireSchemaProperty(
  schemaProperties: Record<string, unknown>,
  input: {
    configured: string | null;
    field: string;
    allowedTypes: readonly string[];
  },
): NotionPropertyDescriptor {
  return resolveSchemaProperty(schemaProperties, {
    ...input,
    required: true,
  }) as NotionPropertyDescriptor;
}

function resolveSchemaProperty(
  schemaProperties: Record<string, unknown>,
  input: {
    configured: string | null;
    field: string;
    required: boolean;
    allowedTypes: readonly string[];
  },
): NotionPropertyDescriptor | null {
  if (input.configured === null || input.configured.trim() === "") {
    if (input.required) {
      throw new TrackerError(
        ERROR_CODES.configInvalid,
        `${input.field} must be configured for tracker.kind: notion.`,
      );
    }

    return null;
  }

  const descriptor = findSchemaProperty(schemaProperties, input.configured);
  if (descriptor === null) {
    throw new TrackerError(
      ERROR_CODES.configInvalid,
      `${input.field} '${input.configured}' was not found in the Notion data source schema.`,
      { details: Object.keys(schemaProperties) },
    );
  }

  if (!input.allowedTypes.includes(descriptor.type)) {
    throw new TrackerError(
      ERROR_CODES.configInvalid,
      `${input.field} '${descriptor.name}' must have one of these Notion property types: ${input.allowedTypes.join(", ")}.`,
      { details: descriptor },
    );
  }

  return descriptor;
}

function findSchemaProperty(
  schemaProperties: Record<string, unknown>,
  configured: string,
): NotionPropertyDescriptor | null {
  for (const [name, value] of Object.entries(schemaProperties)) {
    const descriptor = toSchemaDescriptor(name, value);
    if (
      descriptor !== null &&
      (descriptor.name === configured || descriptor.id === configured)
    ) {
      return descriptor;
    }
  }

  return null;
}

function toSchemaDescriptor(
  name: string,
  value: unknown,
): NotionPropertyDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const descriptor = value as { id?: unknown; type?: unknown };
  if (
    typeof descriptor.id !== "string" ||
    typeof descriptor.type !== "string"
  ) {
    return null;
  }

  return {
    id: descriptor.id,
    name,
    type: descriptor.type,
    options: readSchemaOptionNames(value, descriptor.type),
  };
}

function readSchemaOptionNames(value: unknown, type: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const typedValue = (value as Record<string, unknown>)[type];
  if (
    !typedValue ||
    typeof typedValue !== "object" ||
    Array.isArray(typedValue)
  ) {
    return [];
  }

  const options = (typedValue as { options?: unknown }).options;
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((option) =>
      option &&
      typeof option === "object" &&
      !Array.isArray(option) &&
      typeof (option as { name?: unknown }).name === "string"
        ? ((option as { name: string }).name ?? "").trim()
        : "",
    )
    .filter((name) => name !== "");
}

function requireConfiguredLifecycleState(
  state: string | null,
  field: string,
): string {
  if (state === null || state.trim() === "") {
    throw new TrackerError(
      ERROR_CODES.configInvalid,
      `${field} must be configured before tracker lifecycle write-back can run.`,
    );
  }

  return state;
}

function requireStatusOption(
  statusProperty: NotionPropertyDescriptor,
  input: {
    state: string;
    field: string;
  },
): void {
  const available = readStatusOptionNames(statusProperty);
  if (available.includes(input.state)) {
    return;
  }

  throw new TrackerError(
    ERROR_CODES.configInvalid,
    `${input.field} '${input.state}' did not match any Notion status option. Available options: ${formatAvailableOptions(available)}.`,
    { details: available },
  );
}

function readStatusOptionNames(
  statusProperty: NotionPropertyDescriptor,
): string[] {
  return statusProperty.options ?? [];
}

function formatAvailableOptions(options: readonly string[]): string {
  return options.length === 0 ? "(none)" : options.join(", ");
}

function formatBlockerComment(metadata: TrackerBlockerMetadata): string {
  const title = metadata.title ?? "Blocked: clarification needed";
  const lines = [title, ""];

  if (metadata.details !== null) {
    lines.push(metadata.details, "");
  }

  lines.push(
    ...metadata.questions.map((question, index) => `${index + 1}. ${question}`),
  );

  return lines.join("\n");
}

function formatIssueNote(metadata: TrackerIssueNoteMetadata): string {
  const lines = metadata.title === null ? [] : [metadata.title, ""];
  lines.push(metadata.body);
  return lines.join("\n");
}

function compareContextEntries(
  left: TrackerIssueContextEntry,
  right: TrackerIssueContextEntry,
): number {
  if (left.createdAt === null && right.createdAt === null) {
    return left.source.localeCompare(right.source);
  }

  if (left.createdAt === null) {
    return 1;
  }

  if (right.createdAt === null) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function buildRichText(content: string): Array<{
  type: "text";
  text: { content: string };
}> {
  const chunks = chunkText(content, 1800);
  return chunks.map((chunk) => ({
    type: "text",
    text: {
      content: chunk,
    },
  }));
}

function chunkText(content: string, size: number): string[] {
  if (content.length <= size) {
    return [content];
  }

  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }

  return chunks;
}

function getPagePropertyValue(
  page: unknown,
  descriptor: NotionPropertyDescriptor,
): unknown {
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    return null;
  }

  const properties = (page as NotionPageLike).properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return null;
  }

  const record = properties as Record<string, unknown>;
  if (descriptor.name in record) {
    return record[descriptor.name];
  }

  for (const value of Object.values(record)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "id" in value &&
      (value as { id?: unknown }).id === descriptor.id
    ) {
      return value;
    }
  }

  return null;
}

function readNotionBlockPlainText(block: unknown): string | null {
  const type = readObjectString(block, "type");
  if (type === null) {
    return null;
  }

  const typedBlock = readObjectValue(block, type);
  const richText = readRichTextArray(readObjectValue(typedBlock, "rich_text"));
  if (richText !== null) {
    return richText;
  }

  const title = readObjectString(typedBlock, "title");
  if (title !== null) {
    return title;
  }

  return readRichTextArray(readObjectValue(typedBlock, "caption"));
}

function readRichTextArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const text = value
    .map((entry) => {
      const plainText = readObjectString(entry, "plain_text");
      if (plainText !== null) {
        return plainText;
      }

      return readObjectString(readObjectValue(entry, "text"), "content") ?? "";
    })
    .join("")
    .trim();

  return text === "" ? null : text;
}

function readObjectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return (value as Record<string, unknown>)[key] ?? null;
}

function readObjectString(value: unknown, key: string): string | null {
  const rawValue = readObjectValue(value, key);
  return typeof rawValue === "string" && rawValue.trim() !== ""
    ? rawValue.trim()
    : null;
}

function readNotionUserLabel(value: unknown): string | null {
  return (
    readObjectString(value, "name") ??
    readObjectString(readObjectValue(value, "person"), "email") ??
    readObjectString(value, "id")
  );
}

function buildStateFilter(
  statusProperty: NotionPropertyDescriptor,
  stateNames: string[],
): Record<string, unknown> {
  const normalizedStateNames = stateNames.filter(
    (state) => state.trim() !== "",
  );
  return {
    property: statusProperty.id,
    [statusProperty.type]: {
      equals:
        normalizedStateNames.length === 1
          ? normalizedStateNames[0]
          : normalizedStateNames,
    },
  };
}

function buildNotionUrl(
  endpoint: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(
    path.replace(/^\//, ""),
    endpoint.endsWith("/") ? endpoint : `${endpoint}/`,
  );

  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function clampPageSize(pageSize: number): number {
  return Math.max(1, Math.min(pageSize, 100));
}

function isNotionMissingPageError(error: unknown): boolean {
  if (
    !(error instanceof TrackerError) ||
    error.code !== ERROR_CODES.notionApiStatus
  ) {
    return false;
  }

  const errorCode =
    error.details &&
    typeof error.details === "object" &&
    !Array.isArray(error.details) &&
    typeof (error.details as { code?: unknown }).code === "string"
      ? ((error.details as { code: string }).code ?? null)
      : null;

  return (
    errorCode === "object_not_found" || errorCode === "restricted_resource"
  );
}

function isNotionInsufficientPermissionsError(error: unknown): boolean {
  return (
    error instanceof TrackerError &&
    error.code === ERROR_CODES.notionApiStatus &&
    error.status === 403
  );
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function toNotionPathSegment(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readAdapterOptionString(
  adapterOptions: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = readString(adapterOptions[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function requirePageId(page: unknown): string {
  if (
    page &&
    typeof page === "object" &&
    !Array.isArray(page) &&
    typeof (page as NotionPageLike).id === "string"
  ) {
    return (page as NotionPageLike).id as string;
  }

  throw new TrackerError(
    ERROR_CODES.notionUnknownPayload,
    "Notion page payload was missing id.",
    { details: page },
  );
}

async function parseNotionResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new TrackerError(
      ERROR_CODES.notionUnknownPayload,
      "Notion API returned a non-JSON payload.",
      { cause: error },
    );
  }
}

function readRetryAfterMs(response: Response): number | null {
  const rawValue = response.headers.get("retry-after");
  if (rawValue === null) {
    return null;
  }

  const seconds = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return seconds * 1_000;
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
