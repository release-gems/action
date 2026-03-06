import * as fs from "node:fs";
import type * as github from "@actions/github";

type Octokit = ReturnType<typeof github.getOctokit>;

export interface Release {
  id: number;
  draft: boolean;
  assets: Array<{ name: string }>;
  upload_url: string;
}

export async function getOrCreate({
  octokit,
  repo,
  tag,
  name,
  body,
}: {
  octokit: Octokit;
  repo: { owner: string; repo: string };
  tag: string;
  name: string;
  body: string;
}): Promise<Release> {
  try {
    const existing = await octokit.rest.repos.getReleaseByTag({ ...repo, tag });
    return existing.data;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      throw err;
    }
    const created = await octokit.rest.repos.createRelease({
      ...repo,
      tag_name: tag,
      name,
      body,
      draft: true,
    });
    return created.data;
  }
}

export async function finalize({
  octokit,
  repo,
  release,
}: {
  octokit: Octokit;
  repo: { owner: string; repo: string };
  release: Release;
}): Promise<Release> {
  const updated = await octokit.rest.repos.updateRelease({
    ...repo,
    release_id: release.id,
    draft: false,
  });
  return updated.data;
}

export async function uploadAsset({
  octokit,
  repo,
  release,
  name,
  assetPath,
  mediaType = "application/octet-stream",
}: {
  octokit: Octokit;
  repo: { owner: string; repo: string };
  release: Release;
  name: string;
  assetPath: string;
  mediaType: string;
}): Promise<undefined> {
  const existingAssetNames = new Set(release.assets.map((a) => a.name));
  if (existingAssetNames.has(name)) {
    console.log(
      `Release #${release.id} already has an asset with name '${name}'.`,
    );
    return;
  }

  await using handle = await fs.promises.open(assetPath);
  const stat = await handle.stat();

  const asset = await octokit.rest.repos.uploadReleaseAsset({
    ...repo,
    release_id: release.id,
    url: release.upload_url,
    name,
    // biome-ignore lint/suspicious/noExplicitAny: octokit type mismatch
    data: handle.createReadStream() as any,
    headers: {
      "content-type": mediaType,
      "content-length": stat.size,
    },
  });
  console.log(`Uploaded '${name}' to release #${release.id}.`);

  release.assets.push(asset.data);
}
