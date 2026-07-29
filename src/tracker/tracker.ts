import type { Issue } from "../domain/model.js";

export interface IssueStateSnapshot {
  id: string;
  identifier: string;
  state: string;
}

export interface TrackerLifecycleConfig {
  claimState: string | null;
  handoffStates: readonly string[];
  blockedState: string | null;
  requireClaimBeforeAgent: boolean;
}

export interface TrackerHandoffMetadata {
  readyForReview: boolean;
  prUrl: string | null;
  branch: string | null;
  prNumber: string | null;
  headSha: string | null;
  validationSummary: string | null;
  risks: string | null;
}

export interface TrackerBlockerMetadata {
  title: string | null;
  questions: string[];
  details: string | null;
}

export interface TrackerIssueContextEntry {
  source: "body" | "comment";
  text: string;
  createdAt: string | null;
  author: string | null;
}

export interface TrackerIssueContextUnavailableSource {
  source: "body" | "comments";
  error: string;
}

export interface TrackerIssueContext {
  issue: IssueStateSnapshot;
  entries: TrackerIssueContextEntry[];
  unavailableSources: TrackerIssueContextUnavailableSource[];
}

export interface TrackerIssueNoteMetadata {
  title: string | null;
  body: string;
}

export interface TrackerLifecycleTransitionResult {
  issue: IssueStateSnapshot;
  state: string;
}

export type TrackerHandoffRunResult =
  | {
      status: "succeeded";
      result: TrackerLifecycleTransitionResult;
      metadata: TrackerHandoffMetadata;
    }
  | {
      status: "failed";
      error: string;
      metadata: TrackerHandoffMetadata;
    };

export type TrackerBlockerRunResult =
  | {
      status: "succeeded";
      result: TrackerLifecycleTransitionResult;
      metadata: TrackerBlockerMetadata;
    }
  | {
      status: "failed";
      error: string;
      metadata: TrackerBlockerMetadata;
    };

export interface TrackerIssueNoteResult {
  issue: IssueStateSnapshot;
  destination: "comment" | "body";
  metadata: TrackerIssueNoteMetadata;
}

export interface IssueTracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<IssueStateSnapshot[]>;
  readIssueContext?(input: { issue: Issue }): Promise<TrackerIssueContext>;
  appendIssueNote?(input: {
    issue: Issue;
    metadata: TrackerIssueNoteMetadata;
  }): Promise<TrackerIssueNoteResult>;
  claimIssue?(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
  }): Promise<TrackerLifecycleTransitionResult>;
  handoffIssue?(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
    metadata: TrackerHandoffMetadata;
  }): Promise<TrackerLifecycleTransitionResult>;
  blockIssue?(input: {
    issue: Issue;
    lifecycle: TrackerLifecycleConfig;
    metadata: TrackerBlockerMetadata;
  }): Promise<TrackerLifecycleTransitionResult>;
}

export type WriteCapableIssueTracker = IssueTracker &
  Required<Pick<IssueTracker, "claimIssue" | "handoffIssue">>;

export type BlockCapableIssueTracker = IssueTracker &
  Required<Pick<IssueTracker, "blockIssue">>;

export type IssueContextCapableIssueTracker = IssueTracker &
  Required<Pick<IssueTracker, "readIssueContext">>;

export type IssueNoteCapableIssueTracker = IssueTracker &
  Required<Pick<IssueTracker, "appendIssueNote">>;

export function supportsTrackerLifecycleWrite(
  tracker: IssueTracker,
): tracker is WriteCapableIssueTracker {
  return (
    typeof tracker.claimIssue === "function" &&
    typeof tracker.handoffIssue === "function"
  );
}

export function supportsTrackerBlockWrite(
  tracker: IssueTracker,
): tracker is BlockCapableIssueTracker {
  return typeof tracker.blockIssue === "function";
}

export function supportsTrackerIssueContextRead(
  tracker: IssueTracker,
): tracker is IssueContextCapableIssueTracker {
  return typeof tracker.readIssueContext === "function";
}

export function supportsTrackerIssueNoteWrite(
  tracker: IssueTracker,
): tracker is IssueNoteCapableIssueTracker {
  return typeof tracker.appendIssueNote === "function";
}
