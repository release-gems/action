import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  attest as attestGeneric,
  attestProvenance as attestProvenanceLib,
} from "@actions/attest";
import * as core from "@actions/core";
import * as github from "@actions/github";
import * as z from "zod";
import { uploadGemArtifact } from "#/artifact";
import * as codec from "#/codec";
import {
  type HookConfig,
  loadConfigLocal,
  type RegistryConfig,
} from "#/config";
import { formatError } from "#/error";
import { buildGem, type GemBuildResult, type Gemspec } from "#/gem";
import { runHook } from "#/hook";
import { booleanInput, getInputs } from "#/input";
import { resolveTargets, selectTargets, type Target } from "#/project";
import { applySandbox, type SandboxConfig } from "#/sandbox";
import { loadSbom } from "#/sbom";
import { parseTag, verifyTag } from "#/tag";

const ATTESTATION_HASH_DIGITS = 8;

type BuildResult = GemBuildResult & {
  gemspec: Gemspec;
  sha256: string;
};
type Attestation = {
  name: string;
  bundle: Buffer;
  sha256: string;
};

async function build({
  target,
  ruby,
  sandboxConfig,
}: {
  target: Target;
  ruby: string;
  sandboxConfig: SandboxConfig;
}): Promise<BuildResult> {
  const gemDir = path.dirname(target.gemspecPath);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-"));
  const hookEnv = {
    RELEASE_GEMS_GEM_NAME: target.gemspec.name,
    RELEASE_GEMS_GEM_VERSION: target.gemspec.version,
    RELEASE_GEMS_GEMSPEC_PATH: target.gemspecPath,
  };

  await core.group(`Run prebuild hook for ${target.gemspec.name}`, async () =>
    runHook(target.gemConfig.hooks?.prebuild, gemDir, hookEnv, sandboxConfig),
  );

  const result = await core.group(`Pack ${target.gemspec.name}`, async () => {
    const buildSandboxConfig: SandboxConfig = {
      ...sandboxConfig,
      writablePaths: [...sandboxConfig.writablePaths, path.resolve(outDir)],
    };
    return buildGem(ruby, target.gemspecPath, outDir, buildSandboxConfig);
  });

  await core.group(`Run postbuild hook for ${target.gemspec.name}`, async () =>
    runHook(target.gemConfig.hooks?.postbuild, gemDir, hookEnv, sandboxConfig),
  );

  const sha256 = sha256hex(await fs.promises.readFile(result.path));
  return { ...result, gemspec: target.gemspec, sha256 };
}

async function* buildTargets({
  globalHooks,
  workspace,
  targets,
  ruby,
  sandboxConfig,
}: {
  globalHooks: HookConfig | undefined;
  workspace: string;
  targets: Target[];
  ruby: string;
  sandboxConfig: SandboxConfig;
}): AsyncGenerator<BuildResult> {
  await core.group("Run global prebuild hook", async () =>
    runHook(globalHooks?.prebuild, workspace, undefined, sandboxConfig),
  );

  for (const target of targets) {
    yield await build({ target, ruby, sandboxConfig });
  }

  await core.group("Run global postbuild hook", async () =>
    runHook(globalHooks?.postbuild, workspace, undefined, sandboxConfig),
  );
}

async function uploadArtifacts({
  results,
  attestations,
  retentionDays,
}: {
  results: BuildResult[];
  attestations: Attestation[];
  retentionDays: number | undefined;
}): Promise<void> {
  await Promise.all(
    results.map(async (result) => {
      const directory = path.dirname(result.path);

      const attestationIndex = await Promise.all(
        attestations.map(async (attestation) => {
          const hash = attestation.sha256.slice(0, ATTESTATION_HASH_DIGITS);
          const filename = `${attestation.name}-${hash}.sigstore.json`;
          await fs.promises.writeFile(
            path.join(directory, filename),
            attestation.bundle,
          );
          return {
            filename,
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            sha256: attestation.sha256,
          };
        }),
      );

      const index = {
        gem: {
          filename: path.relative(directory, result.path),
        },
        attestations: attestationIndex,
      };

      return uploadGemArtifact({
        gemspec: result.gemspec,
        directory,
        index,
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

function sha256hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

type Subject = { name: string; digest: { sha256: string } };

async function attestProvenance({
  subjects,
  token,
}: {
  subjects: Subject[];
  token: string;
}): Promise<Attestation> {
  core.info(`subjects: ${JSON.stringify(subjects)}`);

  const attestation = await attestProvenanceLib({ subjects, token });

  core.info(`attestationID: ${attestation.attestationID}`);
  core.info(`tlogID: ${attestation.tlogID}`);

  const bundle = Buffer.from(JSON.stringify(attestation.bundle));
  const sha256 = sha256hex(bundle);
  return { name: "provenance", bundle, sha256 };
}

async function attestSbom({
  subjects,
  sbomPath,
  predicateTypeOverride,
  token,
}: {
  subjects: Subject[];
  sbomPath: string;
  predicateTypeOverride: string | undefined;
  token: string;
}): Promise<Attestation> {
  const { predicate, predicateType } = await loadSbom(
    sbomPath,
    predicateTypeOverride,
  );
  const attestation = await attestGeneric({
    subjects,
    predicateType,
    predicate,
    token,
  });

  core.info(`attestationID: ${attestation.attestationID}`);
  core.info(`tlogID: ${attestation.tlogID}`);

  const bundle = Buffer.from(JSON.stringify(attestation.bundle));
  const sha256 = sha256hex(bundle);
  return { name: "sbom", bundle, sha256 };
}

async function setupBubblewrap(sandboxConfig: SandboxConfig): Promise<void> {
  if (!fs.existsSync("/usr/bin/apt-get")) {
    throw new Error(
      "install-bubblewrap requires a Debian/Ubuntu runner with apt-get available",
    );
  }

  core.info("Installing bubblewrap...");
  await new Promise<void>((resolve, reject) => {
    const script = [
      "apt-get update",
      "apt-get install -y bubblewrap",
      "if [ ! -e /etc/apparmor.d/bwrap-userns-restrict ] && [ ! -L /etc/apparmor.d/bwrap-userns-restrict ]; then apt-get install -y apparmor-profiles; ln -s /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/; fi",
      "systemctl reload apparmor",
    ].join("\n");
    const child = childProcess.spawn("sudo", ["bash", "-uexs"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin!.end(script);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`bubblewrap installation exited with code ${code}`));
    });
  });

  core.info("Verifying bubblewrap...");
  const { cmd, args, extraFds } = await applySandbox({
    cmd: "/bin/echo",
    args: ["It works!"],
    cwd: process.cwd(),
    config: sandboxConfig,
  });
  await new Promise<void>((resolve, reject) => {
    const child = (() => {
      try {
        return childProcess.spawn(cmd, args, {
          stdio: ["inherit", "inherit", "inherit", ...extraFds],
        });
      } finally {
        for (const fd of extraFds) fd.close();
      }
    })();
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bwrap verification exited with code ${code}`));
    });
  });

  core.info("Bubblewrap verification passed.");
}

async function run(): Promise<void> {
  const {
    "github-token": token,
    "retention-days": retentionDays,
    ruby,
    sbom: sbomPath,
    "sbom-predicate-type": predicateTypeOverride,
    "verify-tag": verifyTagInput,
    sandbox,
    "sandbox-isolate-network": sandboxIsolateNetwork,
    "sandbox-writable-paths": sandboxWritablePaths,
    "install-bubblewrap": installBubblewrap,
  } = getInputs({
    "github-token": z.string(),
    "retention-days": codec.stringToInt.optional(),
    ruby: z.string().default("ruby"),
    sbom: z.string().optional(),
    "sbom-predicate-type": z.string().optional(),
    "verify-tag": booleanInput.default(true),
    sandbox: z
      .union([z.literal("bubblewrap"), booleanInput])
      .transform<SandboxConfig["backend"]>((v) => {
        if (v === "bubblewrap") return "bubblewrap";
        return v ? "bubblewrap" : null;
      })
      .default(null),
    "sandbox-isolate-network": booleanInput.default(true),
    "sandbox-writable-paths": codec
      .newlineSeparatedString(
        z
          .string()
          .refine((p) => !p.includes("\0"), "path must not contain null bytes")
          .refine((p) => path.isAbsolute(p), "path must be absolute")
          .transform((p) => path.resolve(p)),
      )
      .default([]),
    "install-bubblewrap": booleanInput.optional(),
  });

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  const sandboxConfig: SandboxConfig = {
    backend: sandbox,
    isolateNetwork: sandboxIsolateNetwork,
    writablePaths: [path.resolve(workspace), ...sandboxWritablePaths],
  };

  if (installBubblewrap ?? sandbox === "bubblewrap") {
    await core.group("Set up bubblewrap", () => setupBubblewrap(sandboxConfig));
  }

  const config = await loadConfigLocal(workspace);
  const tagInfo = parseTag(github.context.ref);

  if (verifyTagInput && tagInfo !== null) {
    const octokit = github.getOctokit(token);
    await verifyTag({
      octokit,
      repo: github.context.repo,
      tagName: tagInfo.tagName,
    });
  }

  const candidates = await resolveTargets(
    workspace,
    config,
    ruby,
    sandboxConfig,
  );
  const targets = selectTargets(candidates, tagInfo);
  checkAllowedPushHosts(targets, config.registries);
  const results = await Array.fromAsync(
    buildTargets({
      globalHooks: config.hooks,
      workspace,
      targets,
      ruby,
      sandboxConfig,
    }),
  );

  const subjects = results.map((r) => ({
    name: path.basename(r.path),
    digest: { sha256: r.sha256 },
  }));

  const attestations: Attestation[] = [];

  const isFork =
    github.context.eventName === "pull_request" &&
    github.context.payload.pull_request?.head?.repo?.full_name !==
      github.context.payload.pull_request?.base?.repo?.full_name;

  if (isFork) {
    core.info("Attestation skipped: pull request from a forked repository.");
  } else {
    attestations.push(
      await core.group("Attest provenance", async () =>
        attestProvenance({ subjects, token }),
      ),
    );

    if (sbomPath != null) {
      attestations.push(
        await core.group("Attest SBOM", async () =>
          attestSbom({
            subjects,
            sbomPath,
            predicateTypeOverride,
            token,
          }),
        ),
      );
    }
  }

  await core.group("Upload artifacts", async () => {
    await uploadArtifacts({
      results,
      attestations,
      retentionDays,
    });
  });
}

export const completed = run().catch((err) => {
  core.setFailed(formatError(err));
});
