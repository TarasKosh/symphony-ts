import { stripVTControlCharacters } from "node:util";

export const GITHUB_CAPABILITY_OUTPUT_BYTES_CAP = 64 * 1024;
export const GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP = 2 * 1024;

const DIAGNOSTIC_TRUNCATION_MARKER = " … [truncated]";
const REDACTED = "[REDACTED]";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spaced = (value: string): string =>
  [...value].map(escapeRegExp).join(" *");
const githubTokenPattern = new RegExp(
  `(?:${["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"]
    .map(spaced)
    .join("|")})(?:[A-Za-z0-9_]| )*`,
  "gi",
);
const credentialTailPattern = new RegExp(
  [
    ...["GH_TOKEN", "GITHUB_TOKEN", "access_token", "token"].map(
      (key) => `["']? *${spaced(key)} *["']? *[:=] *`,
    ),
    `["']? *${spaced("Authorization")} *["']? *[:=] *`,
    `${spaced("Bearer")} +`,
  ].join("|"),
  "i",
);

export function boundedGithubDiagnosticSource(raw: string): string {
  return utf8Prefix(raw, GITHUB_CAPABILITY_OUTPUT_BYTES_CAP);
}

export function sanitizeGithubDiagnostic(raw: string): string {
  return truncateDiagnostic(redactGithubDiagnostic(raw));
}

export function appendGithubDiagnostic(
  message: string,
  rawDiagnostic: string | undefined,
): string {
  const excerpt = rawDiagnostic ? sanitizeGithubDiagnostic(rawDiagnostic) : "";
  return excerpt ? `${message} GitHub CLI diagnostic: ${excerpt}` : message;
}

export function safeGithubWorkspaceLabel(workspacePath: string): string {
  const pathSegments = workspacePath.split(/[\\/]+/).filter(Boolean);
  const basename = pathSegments.at(-1) ?? "";
  const sanitized = redactGithubDiagnostic(basename);
  if (sanitized.length === 0 || sanitized === REDACTED) {
    return "unknown";
  }

  const label = sanitized.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (label.length === 0) {
    return "unknown";
  }

  return label.length <= 128 ? label : `${label.slice(0, 125)}...`;
}

function redactGithubDiagnostic(raw: string): string {
  let diagnostic = collapseSpaces(
    stripVTControlCharacters(boundedGithubDiagnosticSource(raw))
      .replace(/\p{Cf}/gu, "")
      .replace(/[\p{Cc}\p{Z}]/gu, " ")
      .replace(/\s/gu, " "),
  );
  diagnostic = diagnostic.replace(githubTokenPattern, REDACTED);
  const locator = credentialTailPattern.exec(diagnostic);
  if (locator?.index !== undefined) {
    const safePrefix = diagnostic.slice(0, locator.index).trimEnd();
    diagnostic = safePrefix ? `${safePrefix} ${REDACTED}` : REDACTED;
  }
  return collapseSpaces(diagnostic);
}

function collapseSpaces(value: string): string {
  return value.replace(/ +/g, " ").trim();
}

function truncateDiagnostic(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") <= GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP
  ) {
    return value;
  }

  const markerBytes = Buffer.byteLength(DIAGNOSTIC_TRUNCATION_MARKER, "utf8");
  const prefix = utf8Prefix(
    value,
    GITHUB_CAPABILITY_DIAGNOSTIC_BYTES_CAP - markerBytes,
  ).trimEnd();
  return `${prefix}${DIAGNOSTIC_TRUNCATION_MARKER}`;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) {
    return encoded.toString("utf8");
  }

  let end = maximumBytes;
  let nextByte = encoded[end];
  while (end > 0 && nextByte !== undefined && (nextByte & 0xc0) === 0x80) {
    end -= 1;
    nextByte = encoded[end];
  }
  return encoded.subarray(0, end).toString("utf8");
}
