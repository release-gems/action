import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, GemConfig } from "./config";
import { type Gemspec, loadGemspec } from "./gem";
import type { TagInfo } from "./tag";

export interface Target {
  gemConfig: GemConfig;
  gemspecPath: string;
  gemspec: Gemspec;
}

function findGemspec(workspace: string, gemConfig: GemConfig): string {
  const dir = path.join(workspace, gemConfig.directory ?? ".");

  if (gemConfig.gemspec) {
    const gemspecPath = path.join(dir, gemConfig.gemspec);
    return gemspecPath;
  }

  const gemspecs = fs.readdirSync(dir).filter((f) => f.endsWith(".gemspec"));

  if (gemspecs.length === 0) {
    throw new Error(`No .gemspec files found in ${dir}`);
  }
  if (gemspecs.length > 1) {
    throw new Error(
      `Multiple .gemspec files found in ${dir}: ${gemspecs.join(", ")}`,
    );
  }

  return path.join(dir, gemspecs[0]);
}

export function resolveTargets(
  workspace: string,
  config: Config,
  ruby: string,
): Target[] {
  // Explicit empty array means "build nothing"; absent key or null means auto-detect.
  const gemConfigs: GemConfig[] =
    config.gems !== undefined ? config.gems : [{}];

  const candidates: Target[] = [];
  for (const gemConfig of gemConfigs) {
    const gemspecPath = findGemspec(workspace, gemConfig);
    const gemspec = loadGemspec(ruby, gemspecPath);
    candidates.push({ gemConfig, gemspecPath, gemspec });
  }
  return candidates;
}

export function selectTargets(
  candidates: Target[],
  tagInfo: TagInfo | null,
): Target[] {
  if (tagInfo === null) {
    return candidates;
  }

  let targets: Target[];
  if (tagInfo.kind === "per-gem") {
    const matched = candidates.filter(
      (t) => t.gemspec.name === tagInfo.gemName,
    );
    if (matched.length === 0) {
      throw new Error(
        `No gem named "${tagInfo.gemName}" found for per-gem tag`,
      );
    }
    targets = matched;
  } else {
    targets = candidates;
  }

  for (const target of targets) {
    if (target.gemspec.version !== tagInfo.version) {
      throw new Error(
        `Version mismatch for gem "${target.gemspec.name}": gemspec has "${target.gemspec.version}" but tag specifies "${tagInfo.version}"`,
      );
    }
  }

  return targets;
}
