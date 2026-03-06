import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetInput,
  mockSetFailed,
  mockGetIDToken,
  mockGetOctokit,
  mockGetReleaseByTag,
  mockCreateRelease,
  mockUploadReleaseAsset,
  mockUpdateRelease,
  mockGetContent,
  mockGetRef,
  mockGetTag,
  mockListArtifacts,
  mockDownloadArtifact,
  mockFetch,
  mockOctokit,
} = vi.hoisted(() => {
  const mockGetReleaseByTag = vi.fn();
  const mockCreateRelease = vi.fn();
  const mockUploadReleaseAsset = vi.fn();
  const mockUpdateRelease = vi.fn();
  const mockGetContent = vi.fn();
  const mockGetRef = vi.fn();
  const mockGetTag = vi.fn();
  const mockListArtifacts = vi.fn();
  const mockDownloadArtifact = vi.fn();
  const mockFetch = vi.fn();

  const mockOctokit = {
    rest: {
      repos: {
        getReleaseByTag: mockGetReleaseByTag,
        createRelease: mockCreateRelease,
        uploadReleaseAsset: mockUploadReleaseAsset,
        updateRelease: mockUpdateRelease,
        getContent: mockGetContent,
      },
      git: {
        getRef: mockGetRef,
        getTag: mockGetTag,
      },
    },
  };

  return {
    mockGetInput:
      vi.fn<(name: string, options?: { required?: boolean }) => string>(),
    mockSetFailed: vi.fn(),
    mockGetIDToken: vi.fn<() => Promise<string>>(),
    mockGetOctokit: vi.fn(),
    mockGetReleaseByTag,
    mockCreateRelease,
    mockUploadReleaseAsset,
    mockUpdateRelease,
    mockGetContent,
    mockGetRef,
    mockGetTag,
    mockListArtifacts,
    mockDownloadArtifact,
    mockFetch,
    mockOctokit,
  };
});

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  getIDToken: mockGetIDToken,
}));

vi.mock("@actions/github", async (importOriginal) => {
  const original = await importOriginal<typeof import("@actions/github")>();
  const context = Object.create(original.context);
  Object.defineProperty(context, "ref", {
    get: () => process.env.GITHUB_REF ?? "",
    configurable: true,
  });
  return { ...original, context, getOctokit: mockGetOctokit };
});

vi.mock("@actions/artifact", () => ({
  default: {
    listArtifacts: mockListArtifacts,
    downloadArtifact: mockDownloadArtifact,
  },
}));

// Helpers

async function loadPublish(): Promise<void> {
  vi.resetModules();
  const mod = (await import("./publish")) as { completed: Promise<void> };
  await mod.completed;
}

function makeRelease(
  id: number,
  draft: boolean,
  assets: Array<{ name: string }> = [],
) {
  return {
    id,
    draft,
    assets,
    upload_url: `https://uploads.github.com/repos/test-owner/test-repo/releases/${id}/assets{?name,label}`,
  };
}

// Setup / teardown

let workspace: string;
let downloadDir1: string;
let downloadDir2: string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockGetOctokit.mockReturnValue(mockOctokit);

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-pub-test-"));
  fs.mkdirSync(path.join(workspace, ".github"), { recursive: true });

  downloadDir1 = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-gems-dl-test-"),
  );
  downloadDir2 = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-gems-dl-test-"),
  );

  // Populate download dirs with fake .gem, .sigstore.json, and index.json files.
  fs.writeFileSync(path.join(downloadDir1, "foo-1.0.0.gem"), "fake gem");
  fs.writeFileSync(
    path.join(downloadDir1, "foo-1.0.0.gem.sigstore.json"),
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  );
  fs.writeFileSync(
    path.join(downloadDir1, "index.json"),
    JSON.stringify({
      gem: { filename: "foo-1.0.0.gem" },
      attestations: [
        {
          filename: "foo-1.0.0.gem.sigstore.json",
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(downloadDir2, "bar-2.0.0.gem"), "fake gem");
  fs.writeFileSync(
    path.join(downloadDir2, "bar-2.0.0.gem.sigstore.json"),
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  );
  fs.writeFileSync(
    path.join(downloadDir2, "index.json"),
    JSON.stringify({
      gem: { filename: "bar-2.0.0.gem" },
      attestations: [
        {
          filename: "bar-2.0.0.gem.sigstore.json",
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        },
      ],
    }),
  );

  process.env.GITHUB_WORKSPACE = workspace;
  process.env.GITHUB_REF = "refs/tags/v1.0.0";
  process.env.GITHUB_REPOSITORY = "test-owner/test-repo";

  mockGetInput.mockImplementation((name: string) =>
    name === "github-token" ? "gha-token" : "",
  );

  // Two downloaded artifacts by default.
  mockListArtifacts.mockResolvedValue({
    artifacts: [
      { id: 1, name: "release-gems-default-foo" },
      { id: 2, name: "release-gems-default-bar" },
    ],
  });
  mockDownloadArtifact
    .mockResolvedValueOnce({ downloadPath: downloadDir1 })
    .mockResolvedValueOnce({ downloadPath: downloadDir2 });

  // Default: lightweight tag → no annotated message, fallback body used.
  mockGetRef.mockResolvedValue({
    data: { object: { type: "commit", sha: "abc123" } },
  });
  mockGetTag.mockResolvedValue({ data: { message: "" } });

  // No existing release by default.
  mockGetReleaseByTag.mockRejectedValue({ status: 404 });
  mockCreateRelease.mockResolvedValue({ data: makeRelease(42, true) });
  mockUploadReleaseAsset.mockResolvedValue({ data: {} });
  mockUpdateRelease.mockResolvedValue({ data: {} });

  // No config on GitHub API by default → falls back to rubygems.org.
  mockGetContent.mockRejectedValue({ status: 404 });

  // OIDC token exchange for rubygems.org trusted publisher flow.
  mockGetIDToken.mockResolvedValue("mock-oidc-token");

  // fetch: handle OIDC exchange then gem push.
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("exchange_token")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ api_key: "mock-api-key" }),
        text: async () => "",
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => "success",
    });
  });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(downloadDir1, { recursive: true, force: true });
  fs.rmSync(downloadDir2, { recursive: true, force: true });
  delete process.env.GITHUB_WORKSPACE;
  delete process.env.GITHUB_REF;
  vi.unstubAllGlobals();
});

// Tests

describe("publish action", () => {
  it("unified tag: creates draft release, uploads assets, publishes, and pushes gems", async () => {
    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tag_name: "v1.0.0",
        name: "v1.0.0",
        body: "Release v1.0.0",
        draft: true,
      }),
    );
    // 2 gems + 2 attestations = 4 asset uploads.
    expect(mockUploadReleaseAsset).toHaveBeenCalledTimes(4);
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "foo-1.0.0.gem",
        headers: expect.objectContaining({
          "content-type": "application/octet-stream",
          "content-length": 8,
        }),
      }),
    );
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "foo-1.0.0.gem.sigstore.json",
        headers: expect.objectContaining({
          "content-type": "application/vnd.dev.sigstore.bundle.v0.3+json",
          "content-length": 61,
        }),
      }),
    );
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bar-2.0.0.gem",
        headers: expect.objectContaining({
          "content-type": "application/octet-stream",
          "content-length": 8,
        }),
      }),
    );
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "bar-2.0.0.gem.sigstore.json",
        headers: expect.objectContaining({
          "content-type": "application/vnd.dev.sigstore.bundle.v0.3+json",
          "content-length": 61,
        }),
      }),
    );
    expect(mockUpdateRelease).toHaveBeenCalledWith(
      expect.objectContaining({ release_id: 42, draft: false }),
    );
    // 2 gems pushed to rubygems.org.
    const pushCalls = mockFetch.mock.calls.filter(
      ([url]) =>
        typeof url === "string" && url.includes("rubygems.org/api/v1/gems"),
    );
    expect(pushCalls).toHaveLength(2);
  });

  it("per-gem tag: creates release with gem-specific title and body", async () => {
    process.env.GITHUB_REF = "refs/tags/my-gem/v2.0.0";
    mockListArtifacts.mockResolvedValue({
      artifacts: [{ id: 1, name: "release-gems-default-foo" }],
    });
    mockDownloadArtifact.mockReset();
    mockDownloadArtifact.mockResolvedValue({ downloadPath: downloadDir1 });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "test-owner",
        repo: "test-repo",
        tag_name: "my-gem/v2.0.0",
        name: "my-gem v2.0.0",
        body: "Release my-gem v2.0.0",
      }),
    );
  });

  it("branch push fails immediately without touching GitHub", async () => {
    process.env.GITHUB_REF = "refs/heads/main";

    await loadPublish();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("tag push"),
    );
    expect(mockCreateRelease).not.toHaveBeenCalled();
  });

  it("duplicate gem filenames across artifacts fails before creating release", async () => {
    // Override downloadDir2's index to declare the same gem filename as downloadDir1.
    fs.writeFileSync(path.join(downloadDir2, "foo-1.0.0.gem"), "duplicate");
    fs.writeFileSync(
      path.join(downloadDir2, "foo-1.0.0.gem.sigstore.json"),
      "{}",
    );
    fs.writeFileSync(
      path.join(downloadDir2, "index.json"),
      JSON.stringify({
        gem: { filename: "foo-1.0.0.gem" },
        attestations: [
          {
            filename: "foo-1.0.0.gem.sigstore.json",
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          },
        ],
      }),
    );

    await loadPublish();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate"),
    );
    expect(mockCreateRelease).not.toHaveBeenCalled();
  });

  it("reuses an existing draft release without creating a new one", async () => {
    mockGetReleaseByTag.mockResolvedValue({ data: makeRelease(99, true) });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).not.toHaveBeenCalled();
    expect(mockUploadReleaseAsset).toHaveBeenCalled();
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "foo-1.0.0.gem",
        headers: expect.objectContaining({
          "content-type": "application/octet-stream",
          "content-length": 8,
        }),
      }),
    );
    expect(mockUploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "foo-1.0.0.gem.sigstore.json",
        headers: expect.objectContaining({
          "content-type": "application/vnd.dev.sigstore.bundle.v0.3+json",
          "content-length": 61,
        }),
      }),
    );
    expect(mockUpdateRelease).toHaveBeenCalledWith(
      expect.objectContaining({ release_id: 99, draft: false }),
    );
  });

  it("skips asset upload and finalize when release is already published", async () => {
    mockGetReleaseByTag.mockResolvedValue({ data: makeRelease(99, false) });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).not.toHaveBeenCalled();
    expect(mockUploadReleaseAsset).not.toHaveBeenCalled();
    expect(mockUpdateRelease).not.toHaveBeenCalled();
  });

  it("still pushes gems when release is already published", async () => {
    mockGetReleaseByTag.mockResolvedValue({ data: makeRelease(99, false) });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    const pushCalls = mockFetch.mock.calls.filter(
      ([url]) =>
        typeof url === "string" && url.includes("rubygems.org/api/v1/gems"),
    );
    expect(pushCalls).toHaveLength(2);
  });

  it("skips uploading assets that already exist on the release", async () => {
    mockGetReleaseByTag.mockResolvedValue({
      data: makeRelease(99, true, [
        { name: "foo-1.0.0.gem" },
        { name: "foo-1.0.0.gem.sigstore.json" },
      ]),
    });
    mockListArtifacts.mockResolvedValue({
      artifacts: [{ id: 1, name: "release-gems-default-foo" }],
    });
    mockDownloadArtifact.mockReset();
    mockDownloadArtifact.mockResolvedValue({ downloadPath: downloadDir1 });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    // Both foo assets already exist on release; nothing uploaded.
    expect(mockUploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("fetches config from GitHub API when absent locally", async () => {
    // Simulate a job without a local checkout by removing the .github directory.
    fs.rmSync(path.join(workspace, ".github"), { recursive: true });

    const configYaml = "registries:\n- host: https://rubygems.org\n";
    mockGetContent.mockResolvedValue({
      data: {
        type: "file",
        content: Buffer.from(configYaml).toString("base64"),
      },
    });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockGetContent).toHaveBeenCalled();
  });

  it("defaults to rubygems.org when config is absent both locally and on GitHub API", async () => {
    mockGetContent.mockRejectedValue({ status: 404 });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    const pushCalls = mockFetch.mock.calls.filter(
      ([url]) =>
        typeof url === "string" && url.includes("rubygems.org/api/v1/gems"),
    );
    expect(pushCalls.length).toBeGreaterThan(0);
  });

  it("annotated unified tag: uses tag message as release body", async () => {
    mockGetRef.mockResolvedValue({
      data: { object: { type: "tag", sha: "tagobj123" } },
    });
    mockGetTag.mockResolvedValue({
      data: { message: "Bumped to 1.0.0\n\nFull changelog here.\n" },
    });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tag_name: "v1.0.0",
        name: "v1.0.0",
        body: "Bumped to 1.0.0\n\nFull changelog here.",
      }),
    );
  });

  it("annotated tag with PGP signature: strips signature from release body", async () => {
    const signed =
      "Release notes\n\n-----BEGIN PGP SIGNATURE-----\nabc123\n-----END PGP SIGNATURE-----\n";
    mockGetRef.mockResolvedValue({
      data: { object: { type: "tag", sha: "tagobj456" } },
    });
    mockGetTag.mockResolvedValue({ data: { message: signed } });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Release notes",
      }),
    );
  });

  it("annotated per-gem tag: uses tag message as release body", async () => {
    process.env.GITHUB_REF = "refs/tags/my-gem/v2.0.0";
    mockListArtifacts.mockResolvedValue({
      artifacts: [{ id: 1, name: "release-gems-default-foo" }],
    });
    mockDownloadArtifact.mockReset();
    mockDownloadArtifact.mockResolvedValue({ downloadPath: downloadDir1 });
    mockGetRef.mockResolvedValue({
      data: { object: { type: "tag", sha: "tagobjpg" } },
    });
    mockGetTag.mockResolvedValue({
      data: { message: "my-gem release notes\n" },
    });

    await loadPublish();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockCreateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tag_name: "my-gem/v2.0.0",
        name: "my-gem v2.0.0",
        body: "my-gem release notes",
      }),
    );
  });
});
