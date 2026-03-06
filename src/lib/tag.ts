import type * as github from "@actions/github";

type Octokit = ReturnType<typeof github.getOctokit>;

export type TagInfo =
  | { kind: "unified"; tagName: string; version: string }
  | { kind: "per-gem"; tagName: string; gemName: string; version: string };

/**
 * Parse a git ref string into TagInfo.
 *
 * - refs/tags/v1.2.3        → unified tag, version "1.2.3"
 * - refs/tags/my-gem/v1.0.0 → per-gem tag, gemName "my-gem", version "1.0.0"
 * - anything else           → null
 */
export function parseTag(ref: string): TagInfo | null {
  // Unified tag: refs/tags/v{version} where version contains no slash
  const unifiedMatch = ref.match(/^refs\/tags\/v([^/]+)$/);
  if (unifiedMatch) {
    const version = unifiedMatch[1];
    return { kind: "unified", tagName: `v${version}`, version };
  }

  // Per-gem tag: refs/tags/{name}/v{version}
  const perGemMatch = ref.match(/^refs\/tags\/(.+)\/v([^/]+)$/);
  if (perGemMatch) {
    const gemName = perGemMatch[1];
    const version = perGemMatch[2];
    return {
      kind: "per-gem",
      tagName: `${gemName}/v${version}`,
      gemName,
      version,
    };
  }

  return null;
}

/**
 * Strip a GPG or SSH signature from a git tag message.
 * Returns the message trimmed of trailing whitespace before the signature block.
 */
function stripSignature(message: string): string {
  const idx = message.search(/-----BEGIN (PGP|SSH) SIGNATURE-----/);
  return (idx === -1 ? message : message.slice(0, idx)).trimEnd();
}

/**
 * Fetch the message of an annotated tag via the GitHub REST API.
 * Returns null if the tag is a lightweight (non-annotated) tag.
 * The returned message has any cryptographic signature stripped.
 */
export async function fetchMessage({
  octokit,
  repo,
  tagName,
}: {
  octokit: Octokit;
  repo: { owner: string; repo: string };
  tagName: string;
}): Promise<string | null> {
  const ref = await octokit.rest.git.getRef({
    ...repo,
    ref: `tags/${tagName}`,
  });
  if (ref.data.object.type !== "tag") {
    return null;
  }
  const tag = await octokit.rest.git.getTag({
    ...repo,
    tag_sha: ref.data.object.sha,
  });
  return stripSignature(tag.data.message);
}
