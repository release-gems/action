import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as z from "zod";
import { type GemArtifactIndex, downloadGemArtifacts } from "./lib/artifact";
import { loadConfig } from "./lib/config";
import { getInputs } from "./lib/input";
import { pushToRegistry } from "./lib/registry";
import * as rel from "./lib/release";
import { type TagInfo, fetchMessage, parseTag } from "./lib/tag";

type Octokit = ReturnType<typeof github.getOctokit>;

async function composeRelease(
  tagInfo: TagInfo,
  octokit: Octokit,
  repo: { owner: string; repo: string },
): Promise<{ name: string; body: string }> {
  const { tagName } = tagInfo;
  const message = fetchMessage({ octokit, repo, tagName });

  const name =
    tagInfo.kind === "unified"
      ? `v${tagInfo.version}`
      : `${tagInfo.gemName} v${tagInfo.version}`;
  return { name, body: (await message) ?? `Release ${name}` };
}

async function pushToRelease({
  octokit,
  repo,
  release,
  artifact: { directory, index },
}: {
  octokit: Octokit;
  repo: { owner: string; repo: string };
  release: rel.Release;
  artifact: { directory: string; index: GemArtifactIndex };
}) {
  const files = [
    { filename: index.gem.filename, mediaType: "application/octet-stream" },
    ...index.attestations,
  ];
  for (const { filename, mediaType } of files) {
    await rel.uploadAsset({
      octokit,
      repo,
      release,
      name: filename,
      assetPath: path.join(directory, filename),
      mediaType,
    });
  }
}

function checkDuplicates(
  artifacts: { directory: string; index: GemArtifactIndex }[],
): void {
  const filenames = new Set<string>();
  for (const {
    index: { gem, attestations },
  } of artifacts) {
    for (const fn of [gem.filename, ...attestations.map((a) => a.filename)]) {
      if (filenames.has(fn)) {
        throw new Error(`Duplicate filename '${fn}' in artifacts`);
      }
      filenames.add(fn);
    }
  }
}

async function run(): Promise<void> {
  const { "github-token": token } = getInputs({
    "github-token": z.string(),
  });

  const tagInfo = parseTag(github.context.ref);
  if (tagInfo === null) {
    throw new Error("publish action must be triggered by a tag push");
  }

  const octokit = github.getOctokit(token);
  const repo = github.context.repo;

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const [releaseNote, config] = await Promise.all([
    composeRelease(tagInfo, octokit, repo),
    loadConfig(workspace, github.context, octokit),
  ]);
  const registries = config.registries;

  const artifacts = await core.group("Download gem artifacts", async () =>
    downloadGemArtifacts(),
  );
  checkDuplicates(artifacts);

  await core.group("Publish to GitHub Releases", async () => {
    const release = await rel.getOrCreate({
      octokit,
      repo,
      tag: tagInfo.tagName,
      ...releaseNote,
    });
    if (release.draft) {
      for (const artifact of artifacts) {
        pushToRelease({ octokit, repo, release, artifact });
      }

      await rel.finalize({
        octokit,
        repo,
        release,
      });
    }
  });

  for (const registry of registries) {
    await core.group(`Publish to ${registry.host}`, async () => {
      for (const { directory, index } of artifacts) {
        await pushToRegistry(
          registry,
          path.join(directory, index.gem.filename),
          index.attestations.map(({ filename }) =>
            path.join(directory, filename),
          ),
        );
      }
    });
  }
}

export const completed = run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
