import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attestProvenance } from "@actions/attest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as z from "zod";
import { uploadGemArtifact } from "./lib/artifact";
import {
  type HookConfig,
  type RegistryConfig,
  loadConfigLocal,
} from "./lib/config";
import { type GemBuildResult, type Gemspec, buildGem } from "./lib/gem";
import { runHook } from "./lib/hook";
import { getInputs } from "./lib/input";
import { type Target, resolveTargets, selectTargets } from "./lib/project";
import { parseTag } from "./lib/tag";

type BuildResult = GemBuildResult & {
  gemspec: Gemspec;
  provenancePath: string;
};

async function build({
  target,
  ruby,
  token,
}: {
  target: Target;
  ruby: string;
  token: string;
}): Promise<BuildResult> {
  const gemDir = path.dirname(target.gemspecPath);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-"));
  const hookEnv = {
    RELEASE_GEMS_GEM_NAME: target.gemspec.name,
    RELEASE_GEMS_GEM_VERSION: target.gemspec.version,
    RELEASE_GEMS_GEMSPEC_PATH: target.gemspecPath,
  };

  await core.group(`Run prebuild hook for ${target.gemspec.name}`, async () =>
    runHook(target.gemConfig.hooks?.prebuild, gemDir, hookEnv),
  );

  const result = await core.group(`Pack ${target.gemspec.name}`, async () => {
    return buildGem(ruby, target.gemspecPath, outDir);
  });

  const provenancePath = await core.group(
    `Attest provenance for ${target.gemspec.name}`,
    async () => {
      const sha256 = createHash("sha256")
        .update(fs.readFileSync(result.path))
        .digest("hex");
      const attestation = await attestProvenance({
        subjects: [{ name: path.basename(result.path), digest: { sha256 } }],
        token,
      });

      const provenancePath = `${result.path}.sigstore.json`;
      fs.writeFileSync(provenancePath, JSON.stringify(attestation.bundle));

      return provenancePath;
    },
  );

  await core.group(`Run postbuild hook for ${target.gemspec.name}`, async () =>
    runHook(target.gemConfig.hooks?.postbuild, gemDir, hookEnv),
  );

  return { ...result, gemspec: target.gemspec, provenancePath };
}

async function* buildTargets({
  globalHooks,
  workspace,
  targets,
  ruby,
  token,
}: {
  globalHooks: HookConfig | undefined;
  workspace: string;
  targets: Target[];
  ruby: string;
  token: string;
}): AsyncGenerator<BuildResult> {
  await core.group("Run global prebuild hook", async () =>
    runHook(globalHooks?.prebuild, workspace),
  );

  for (const target of targets) {
    yield await build({ target, ruby, token });
  }

  await core.group("Run global postbuild hook", async () =>
    runHook(globalHooks?.postbuild, workspace),
  );
}

async function uploadArtifacts({
  results,
  retentionDays,
}: {
  results: BuildResult[];
  retentionDays: number | undefined;
}): Promise<void> {
  await Promise.all(
    results.map((result) => {
      const directory = path.dirname(result.path);

      return uploadGemArtifact({
        gemspec: result.gemspec,
        directory,
        index: {
          gem: {
            filename: path.relative(directory, result.path),
          },
          attestations: [
            {
              filename: path.relative(directory, result.provenancePath),
              mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            },
          ],
        },
        retentionDays,
      });
    }),
  );
}

function checkAllowedPushHosts(
  targets: Target[],
  registries: RegistryConfig[],
): void {
  for (const target of targets) {
    const allowedPushHost = target.gemspec.metadata.allowed_push_host;
    if (allowedPushHost === undefined) continue;

    const allowedHost = new URL(allowedPushHost).host;
    const mismatched = registries.filter(
      (r) => new URL(r.host).host !== allowedHost,
    );
    if (mismatched.length > 0) {
      throw new Error(
        `Gem ${target.gemspec.name} has allowed_push_host '${allowedPushHost}' but configured to push to ${mismatched.map((r) => `'${r.host}'`).join(", ")}`,
      );
    }
  }
}

async function run(): Promise<void> {
  const {
    "github-token": token,
    "retention-days": retentionDays,
    ruby,
  } = getInputs({
    "github-token": z.string(),
    "retention-days": z.number().optional(),
    ruby: z.string().default("ruby"),
  });

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const config = await loadConfigLocal(workspace);
  const tagInfo = parseTag(github.context.ref);

  const candidates = await resolveTargets(workspace, config, ruby);
  const targets = selectTargets(candidates, tagInfo);
  checkAllowedPushHosts(targets, config.registries);
  const results = await Array.fromAsync(
    buildTargets({
      globalHooks: config.hooks,
      workspace,
      targets,
      ruby,
      token,
    }),
  );

  await core.group("Upload artifacts", async () => {
    await uploadArtifacts({ results, retentionDays });
  });
}

export const completed = run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
