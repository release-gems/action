import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetInput,
  mockSetFailed,
  mockAttestProvenance,
  mockUploadArtifact,
} = vi.hoisted(() => {
  const mockUploadArtifact = vi.fn();
  return {
    mockGetInput:
      vi.fn<(name: string, options?: { required?: boolean }) => string>(),
    mockSetFailed: vi.fn(),
    mockAttestProvenance: vi.fn(),
    mockUploadArtifact,
  };
});

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  getInput: mockGetInput,
  setFailed: mockSetFailed,
}));

vi.mock("@actions/attest", () => ({
  attestProvenance: mockAttestProvenance,
}));

vi.mock("@actions/artifact", () => ({
  default: {
    uploadArtifact: mockUploadArtifact,
  },
}));

vi.mock("@actions/github", async (importOriginal) => {
  const original = await importOriginal<typeof import("@actions/github")>();
  const context = Object.create(original.context);
  Object.defineProperty(context, "ref", {
    get: () => process.env.GITHUB_REF ?? "",
    configurable: true,
  });
  return { ...original, context };
});

// Helpers

function gemspecContent(
  name: string,
  version: string,
  metadata: Record<string, string> = {},
): string {
  const metadataLines = Object.entries(metadata).map(
    ([k, v]) => `  s.metadata["${k}"] = "${v}"`,
  );
  return [
    "Gem::Specification.new do |s|",
    `  s.name = "${name}"`,
    `  s.version = "${version}"`,
    '  s.summary = "Test gem"',
    '  s.authors = ["Test"]',
    "  s.files = []",
    ...metadataLines,
    "end",
  ].join("\n");
}

async function loadBuild(): Promise<void> {
  vi.resetModules();
  const mod = (await import("./build")) as { completed: Promise<void> };
  await mod.completed;
}

// Setup / teardown

let workspace: string;

beforeEach(() => {
  vi.resetAllMocks();

  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-test-"));
  fs.mkdirSync(path.join(workspace, ".github"), { recursive: true });

  process.env.GITHUB_WORKSPACE = workspace;
  process.env.GITHUB_REF = "refs/heads/main";
  process.env.GITHUB_REPOSITORY = "test-owner/test-repo";

  mockGetInput.mockImplementation((name: string) => {
    switch (name) {
      case "github-token":
        return "gha-token";
      case "job":
        return "default";
      case "retention-days":
        return "";
      case "ruby":
        return "ruby";
      default:
        return "";
    }
  });

  mockAttestProvenance.mockResolvedValue({
    bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" },
  });
  mockUploadArtifact.mockResolvedValue({ id: 1, size: 0 });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  process.env.GITHUB_WORKSPACE = undefined;
  process.env.GITHUB_REF = undefined;
});

// Tests

describe("build action", () => {
  it("branch push with auto-detected single gemspec builds and uploads gem", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalledOnce();
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      "release-gems-foo-ruby",
      [
        expect.stringContaining("index.json"),
        expect.stringContaining("foo-1.0.0.gem"),
        expect.stringContaining("foo-1.0.0.gem.sigstore.json"),
      ],
      expect.any(String),
      { retentionDays: 0 },
    );
  });

  it("auto-detect with zero gemspecs fails", async () => {
    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("No .gemspec files found"),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it("auto-detect with multiple gemspecs fails", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );
    fs.writeFileSync(
      path.join(workspace, "bar.gemspec"),
      gemspecContent("bar", "1.0.0"),
    );

    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Multiple .gemspec files found"),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it("unified tag with matching version succeeds", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "2.0.0"),
    );
    process.env.GITHUB_REF = "refs/tags/v2.0.0";

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalledOnce();
  });

  it("unified tag with version mismatch fails", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );
    process.env.GITHUB_REF = "refs/tags/v2.0.0";

    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Version mismatch"),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it("per-gem tag builds only the matching gem", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );
    fs.writeFileSync(
      path.join(workspace, "bar.gemspec"),
      gemspecContent("bar", "2.0.0"),
    );
    fs.writeFileSync(
      path.join(workspace, ".github", "release-gems.yml"),
      "gems:\n- gemspec: foo.gemspec\n- gemspec: bar.gemspec\n",
    );
    process.env.GITHUB_REF = "refs/tags/bar/v2.0.0";

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalledTimes(1);
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      "release-gems-bar-ruby",
      [
        expect.stringContaining("index.json"),
        expect.stringContaining("bar-2.0.0.gem"),
        expect.any(String),
      ],
      expect.any(String),
      { retentionDays: 0 },
    );
  });

  it("per-gem tag with no matching gem fails", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );
    fs.writeFileSync(
      path.join(workspace, ".github", "release-gems.yml"),
      "gems:\n- gemspec: foo.gemspec\n",
    );
    process.env.GITHUB_REF = "refs/tags/nonexistent/v1.0.0";

    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("No gem named"),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it("allowed_push_host matches the only configured registry succeeds", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0", {
        allowed_push_host: "https://rubygems.org",
      }),
    );

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalledOnce();
  });

  it("allowed_push_host matches one of multiple registries fails", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0", {
        allowed_push_host: "https://rubygems.org",
      }),
    );
    fs.writeFileSync(
      path.join(workspace, ".github", "release-gems.yml"),
      "registries:\n- host: https://rubygems.org\n- host: https://gems.example.com\n",
    );

    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("allowed_push_host"),
    );
  });

  it("allowed_push_host does not match the only registry fails", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0", {
        allowed_push_host: "https://gems.example.com",
      }),
    );

    await loadBuild();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("allowed_push_host"),
    );
    expect(mockUploadArtifact).not.toHaveBeenCalled();
  });

  it("allowed_push_host matches a non-default single registry succeeds", async () => {
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0", {
        allowed_push_host: "https://gems.example.com",
      }),
    );
    fs.writeFileSync(
      path.join(workspace, ".github", "release-gems.yml"),
      "registries:\n- host: https://gems.example.com\n",
    );

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockUploadArtifact).toHaveBeenCalledOnce();
  });

  it("per-gem prebuild hook receives gem environment variables", async () => {
    const hookOutputFile = path.join(workspace, "hook_output.txt");
    fs.writeFileSync(
      path.join(workspace, "foo.gemspec"),
      gemspecContent("foo", "1.0.0"),
    );
    fs.writeFileSync(
      path.join(workspace, ".github", "release-gems.yml"),
      [
        "gems:",
        "- gemspec: foo.gemspec",
        "  hooks:",
        `    prebuild: echo $RELEASE_GEMS_GEM_NAME > ${hookOutputFile}`,
      ].join("\n"),
    );

    await loadBuild();

    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(fs.readFileSync(hookOutputFile, "utf8").trim()).toBe("foo");
  });
});
