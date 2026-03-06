import { describe, expect, it, vi } from "vitest";
import { fetchMessage, parseTag } from "./tag";

describe("parseTag", () => {
  describe("unified tags", () => {
    it("parses refs/tags/v1.2.3", () => {
      expect(parseTag("refs/tags/v1.2.3")).toEqual({
        kind: "unified",
        tagName: "v1.2.3",
        version: "1.2.3",
        prerelease: false,
      });
    });

    it("parses refs/tags/v0.0.1", () => {
      expect(parseTag("refs/tags/v0.0.1")).toEqual({
        kind: "unified",
        tagName: "v0.0.1",
        version: "0.0.1",
        prerelease: false,
      });
    });

    it("parses refs/tags/v10.20.30", () => {
      expect(parseTag("refs/tags/v10.20.30")).toEqual({
        kind: "unified",
        tagName: "v10.20.30",
        version: "10.20.30",
        prerelease: false,
      });
    });

    it("parses refs/tags/v1.0.0.alpha1", () => {
      expect(parseTag("refs/tags/v1.0.0.alpha1")).toEqual({
        kind: "unified",
        tagName: "v1.0.0.alpha1",
        version: "1.0.0.alpha1",
        prerelease: true,
      });
    });
  });

  describe("per-gem tags", () => {
    it("parses refs/tags/my-gem/v1.0.0", () => {
      expect(parseTag("refs/tags/my-gem/v1.0.0")).toEqual({
        kind: "per-gem",
        tagName: "my-gem/v1.0.0",
        gemName: "my-gem",
        version: "1.0.0",
        prerelease: false,
      });
    });

    it("parses refs/tags/foo-bar/v2.3.4", () => {
      expect(parseTag("refs/tags/foo-bar/v2.3.4")).toEqual({
        kind: "per-gem",
        tagName: "foo-bar/v2.3.4",
        gemName: "foo-bar",
        version: "2.3.4",
        prerelease: false,
      });
    });

    it("parses refs/tags/some_gem/v0.1.0", () => {
      expect(parseTag("refs/tags/some_gem/v0.1.0")).toEqual({
        kind: "per-gem",
        tagName: "some_gem/v0.1.0",
        gemName: "some_gem",
        version: "0.1.0",
        prerelease: false,
      });
    });

    it("parses refs/tags/my-gem/v1.0.0.beta1 as prerelease", () => {
      expect(parseTag("refs/tags/my-gem/v1.0.0.beta1")).toEqual({
        kind: "per-gem",
        tagName: "my-gem/v1.0.0.beta1",
        gemName: "my-gem",
        version: "1.0.0.beta1",
        prerelease: true,
      });
    });
  });

  describe("branch refs", () => {
    it("parses refs/heads/master as branch", () => {
      expect(parseTag("refs/heads/master")).toEqual(null);
    });

    it("parses refs/heads/main as branch", () => {
      expect(parseTag("refs/heads/main")).toEqual(null);
    });

    it("parses refs/heads/feature/branch as branch", () => {
      expect(parseTag("refs/heads/feature/branch")).toEqual(null);
    });

    it("parses refs/heads/release/v1.0 as branch", () => {
      expect(parseTag("refs/heads/release/v1.0")).toEqual(null);
    });
  });

  describe("edge cases / unrecognized refs fall back to branch", () => {
    it("treats an empty string as branch", () => {
      expect(parseTag("")).toEqual(null);
    });

    it("treats refs/pull/1/head as branch", () => {
      expect(parseTag("refs/pull/1/head")).toEqual(null);
    });

    it("treats refs/tags/ (no version) as branch", () => {
      expect(parseTag("refs/tags/")).toEqual(null);
    });

    it("treats a bare tag name without refs/tags/ prefix as branch", () => {
      expect(parseTag("v1.2.3")).toEqual(null);
    });

    it("treats refs/tags/no-version-prefix as branch", () => {
      expect(parseTag("refs/tags/no-version-prefix")).toEqual(null);
    });
  });
});

describe("fetchMessage", () => {
  function makeOctokit(refType: "tag" | "commit", tagMessage = "") {
    return {
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({
            data: { object: { type: refType, sha: "deadbeef" } },
          }),
          getTag: vi.fn().mockResolvedValue({
            data: { message: tagMessage },
          }),
        },
      },
    };
  }

  const repo = { owner: "test-owner", repo: "test-repo" };

  it("returns null for a lightweight tag", async () => {
    const octokit = makeOctokit("commit");
    const result = await fetchMessage({
      // biome-ignore lint/suspicious/noExplicitAny: mock object
      octokit: octokit as any,
      repo,
      tagName: "v1.0.0",
    });
    expect(result).toBeNull();
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      ...repo,
      ref: "tags/v1.0.0",
    });
    expect(octokit.rest.git.getTag).not.toHaveBeenCalled();
  });

  it("returns the message for an annotated tag", async () => {
    const octokit = makeOctokit("tag", "My release notes\n");
    const result = await fetchMessage({
      // biome-ignore lint/suspicious/noExplicitAny: mock object
      octokit: octokit as any,
      repo,
      tagName: "v2.0.0",
    });
    expect(result).toBe("My release notes");
    expect(octokit.rest.git.getTag).toHaveBeenCalledWith({
      ...repo,
      tag_sha: "deadbeef",
    });
  });

  it("strips a PGP signature from the tag message", async () => {
    const signed =
      "Signed release\n\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n";
    const octokit = makeOctokit("tag", signed);
    const result = await fetchMessage({
      // biome-ignore lint/suspicious/noExplicitAny: mock object
      octokit: octokit as any,
      repo,
      tagName: "v3.0.0",
    });
    expect(result).toBe("Signed release");
  });

  it("strips an SSH signature from the tag message", async () => {
    const signed =
      "My release\n\n-----BEGIN SSH SIGNATURE-----\nxyz\n-----END SSH SIGNATURE-----\n";
    const octokit = makeOctokit("tag", signed);
    const result = await fetchMessage({
      // biome-ignore lint/suspicious/noExplicitAny: mock object
      octokit: octokit as any,
      repo,
      tagName: "v4.0.0",
    });
    expect(result).toBe("My release");
  });

  it("uses full tag name including gem prefix for per-gem tags", async () => {
    const octokit = makeOctokit("tag", "gem release\n");
    await fetchMessage({
      // biome-ignore lint/suspicious/noExplicitAny: mock object
      octokit: octokit as any,
      repo,
      tagName: "my-gem/v1.0.0",
    });
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      ...repo,
      ref: "tags/my-gem/v1.0.0",
    });
  });
});
