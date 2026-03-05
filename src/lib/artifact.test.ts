import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadGemArtifacts, uploadGemArtifact } from "./artifact";

const { mockUploadArtifact, mockListArtifacts, mockDownloadArtifact } =
  vi.hoisted(() => ({
    mockUploadArtifact: vi.fn(),
    mockListArtifacts: vi.fn(),
    mockDownloadArtifact: vi.fn(),
  }));

vi.mock("@actions/artifact", () => ({
  default: {
    uploadArtifact: mockUploadArtifact,
    listArtifacts: mockListArtifacts,
    downloadArtifact: mockDownloadArtifact,
  },
}));

describe("uploadGemArtifact", () => {
  let tempDir: string;

  beforeEach(() => {
    mockUploadArtifact.mockReset();
    mockUploadArtifact.mockResolvedValue({});
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("calls uploadArtifact with the correct artifact name", async () => {
    await uploadGemArtifact({
      gemspec: { name: "my-gem", version: "1.0.0", platform: "ruby" },
      directory: tempDir,
      index: {
        gem: { filename: "my-gem-1.0.0.gem" },
        attestations: [],
      },
    });

    const [name] = mockUploadArtifact.mock.calls[0];
    expect(name).toBe("release-gems-my-gem-ruby");
  });

  it("calls uploadArtifact with index, gem, and attestation files", async () => {
    await uploadGemArtifact({
      gemspec: { name: "my-gem", version: "1.0.0", platform: "ruby" },
      directory: tempDir,
      index: {
        gem: { filename: "my-gem-1.0.0.gem" },
        attestations: [
          {
            filename: "my-gem-1.0.0.gem.sigstore.json",
            mediaType: "application/json",
          },
        ],
      },
    });

    const [, files] = mockUploadArtifact.mock.calls[0];
    expect(files).toEqual([
      path.join(tempDir, "index.json"),
      path.join(tempDir, "my-gem-1.0.0.gem"),
      path.join(tempDir, "my-gem-1.0.0.gem.sigstore.json"),
    ]);
  });

  it("uses directory as rootDirectory", async () => {
    await uploadGemArtifact({
      gemspec: { name: "my-gem", version: "1.0.0", platform: "ruby" },
      directory: tempDir,
      index: { gem: { filename: "my-gem-1.0.0.gem" }, attestations: [] },
    });

    const [, , rootDirectory] = mockUploadArtifact.mock.calls[0];
    expect(rootDirectory).toBe(tempDir);
  });

  it("passes retentionDays in options when provided", async () => {
    await uploadGemArtifact({
      gemspec: { name: "my-gem", version: "1.0.0", platform: "ruby" },
      directory: tempDir,
      index: { gem: { filename: "my-gem-1.0.0.gem" }, attestations: [] },
      retentionDays: 30,
    });

    const [, , , options] = mockUploadArtifact.mock.calls[0];
    expect(options).toEqual({ retentionDays: 30 });
  });

  it("uses 0 as retentionDays when not provided", async () => {
    await uploadGemArtifact({
      gemspec: { name: "my-gem", version: "1.0.0", platform: "ruby" },
      directory: tempDir,
      index: { gem: { filename: "my-gem-1.0.0.gem" }, attestations: [] },
    });

    const [, , , options] = mockUploadArtifact.mock.calls[0];
    expect(options).toEqual({ retentionDays: 0 });
  });

  it("constructs artifact name as release-gems-{gemspec.name}-{gemspec.platform}", async () => {
    await uploadGemArtifact({
      gemspec: { name: "awesome-lib", version: "2.0.0", platform: "java" },
      directory: tempDir,
      index: { gem: { filename: "awesome-lib-2.0.0.gem" }, attestations: [] },
    });

    const [name] = mockUploadArtifact.mock.calls[0];
    expect(name).toBe("release-gems-awesome-lib-java");
  });
});

describe("downloadGemArtifacts", () => {
  const tempDirs: string[] = [];

  function makeArtifactDir(gemFilename: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-dl-test-"));
    tempDirs.push(dir);
    const attestFilename = `${gemFilename}.sigstore.json`;
    fs.writeFileSync(path.join(dir, gemFilename), "fake gem");
    fs.writeFileSync(path.join(dir, attestFilename), "{}");
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        gem: { filename: gemFilename },
        attestations: [
          {
            filename: attestFilename,
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          },
        ],
      }),
    );
    return dir;
  }

  beforeEach(() => {
    mockListArtifacts.mockReset();
    mockDownloadArtifact.mockReset();
    tempDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty array when no artifacts match release-gems- prefix", async () => {
    mockListArtifacts.mockResolvedValue({
      artifacts: [
        { id: 1, name: "other-artifact" },
        { id: 2, name: "unrelated" },
      ],
    });

    const result = await Array.fromAsync(downloadGemArtifacts());

    expect(result).toEqual([]);
    expect(mockDownloadArtifact).not.toHaveBeenCalled();
  });

  it("downloads only artifacts whose names start with release-gems-", async () => {
    const dir10 = makeArtifactDir("my-gem-1.0.0.gem");
    const dir30 = makeArtifactDir("another-gem-2.0.0.gem");

    mockListArtifacts.mockResolvedValue({
      artifacts: [
        { id: 10, name: "release-gems-my-gem-ruby" },
        { id: 20, name: "other-artifact" },
        { id: 30, name: "release-gems-another-gem-ruby" },
      ],
    });
    mockDownloadArtifact
      .mockResolvedValueOnce({ downloadPath: dir10 })
      .mockResolvedValueOnce({ downloadPath: dir30 });

    const result = await Array.fromAsync(downloadGemArtifacts());

    expect(mockDownloadArtifact).toHaveBeenCalledTimes(2);
    const calledIds = mockDownloadArtifact.mock.calls.map(
      ([id]) => id as number,
    );
    expect(calledIds).toContain(10);
    expect(calledIds).toContain(30);
    expect(result.map((r) => r.directory)).toEqual([dir10, dir30]);
  });

  it("yields directory and index for each downloaded artifact", async () => {
    const dir = makeArtifactDir("cool-gem-1.0.0.gem");

    mockListArtifacts.mockResolvedValue({
      artifacts: [{ id: 5, name: "release-gems-abc-cool-gem" }],
    });
    mockDownloadArtifact.mockResolvedValue({ downloadPath: dir });

    const result = await Array.fromAsync(downloadGemArtifacts());

    expect(result).toHaveLength(1);
    expect(result[0].directory).toBe(dir);
    expect(result[0].index.gem.filename).toBe("cool-gem-1.0.0.gem");
  });

  it("calls listArtifacts with latest: true", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [] });

    await Array.fromAsync(downloadGemArtifacts());

    expect(mockListArtifacts).toHaveBeenCalledWith({ latest: true });
  });

  it("does not download artifacts that contain release-gems- but do not start with it", async () => {
    mockListArtifacts.mockResolvedValue({
      artifacts: [
        { id: 1, name: "not-release-gems-artifact" },
        { id: 2, name: "prefix-release-gems-suffix" },
      ],
    });

    const result = await Array.fromAsync(downloadGemArtifacts());

    expect(result).toEqual([]);
    expect(mockDownloadArtifact).not.toHaveBeenCalled();
  });
});
