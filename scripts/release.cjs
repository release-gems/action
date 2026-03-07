// @ts-check

/**
 * @param {{
 *   github: ReturnType<import('@actions/github').getOctokit>,
 *   context: import('@actions/github').context,
 * }} [params]
 */
export default async function (params) {
  if (!params) return;
  const { github, context } = params;

  const ref = (await github.rest.git.getRef({
    ...context.repo,
    ref: context.ref.replace(/^refs\//, ""),
  })).data;
  if (ref.object.type !== "tag") {
    throw new Error("ref is not an annotated tag");
  }

  const tag = (await github.rest.git.getTag({ ...context.repo, tag_sha: ref.object.sha })).data;
  if (!tag.verification?.verified) {
    throw new Error(`tag is not verified: ${tag.verification?.reason}`);
  }

  const tagName = tag.tag;
  const prerelease = !!tagName.replace(/^v/, "").match(/[a-z]/i);
  await github.rest.repos.createRelease({
    ...context.repo,
    tag_name: tagName,
    name: tagName,
    prerelease,
    draft: false,
  });

  if (!prerelease) {
    await github.rest.git.updateRef({
      ...context.repo,
      ref: ref.ref.replace(/^refs\//, "").split(".")[0],
      sha: tag.sha,
    });
  }
};
