import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { z } from "zod";
import type { RegistryConfig } from "./config";

const ExchangeTokenResponseSchema = z.object({ api_key: z.string() });

export const RUBYGEMS_ORG = "rubygems.org";

/**
 * Exchange a GitHub Actions OIDC token for a RubyGems.org short-lived API key
 * via the trusted publisher API.
 */
export async function exchangeOidcToken(): Promise<string> {
  const oidcToken = await core.getIDToken("rubygems.org");

  const response = await fetch(
    "https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jwt: oidcToken }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to exchange OIDC token: HTTP ${response.status} - ${body}`,
    );
  }

  return ExchangeTokenResponseSchema.parse(await response.json()).api_key;
}

/**
 * Push a gem to the given registry via its HTTP API.
 *
 * For rubygems.org: exchanges a GitHub Actions OIDC token for a short-lived
 * API key via the trusted publisher API.
 * For other registries: reads the API key from the GEM_HOST_API_KEY environment
 * variable (user's responsibility to set).
 *
 * Sends a multipart POST to /api/v1/gems with the gem binary and its Sigstore
 * attestation bundle. HTTP 409 (version already published) is treated as success.
 *
 * @param registry        Registry configuration.
 * @param gemPath         Path to the .gem file.
 * @param attestationPath Path to the .sigstore.json bundle.
 */
export async function pushToRegistry(
  registry: RegistryConfig,
  gemPath: string,
  attestationPaths: string[],
): Promise<void> {
  let apiKey: string;
  if (new URL(registry.host).hostname === RUBYGEMS_ORG) {
    apiKey = await exchangeOidcToken();
  } else {
    apiKey = process.env.GEM_HOST_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        `GEM_HOST_API_KEY is not set for registry ${registry.host}`,
      );
    }
  }

  const body = new FormData();
  body.append(
    "gem",
    await fs.openAsBlob(gemPath, { type: "application/octet-stream" }),
    path.basename(gemPath),
  );

  body.append(
    "attestations",
    new Blob(
      [
        JSON.stringify(
          await Promise.all(
            attestationPaths.map(async (path) =>
              JSON.parse(await fs.promises.readFile(path, "utf8")),
            ),
          ),
        ),
      ],
      { type: "application/json" },
    ),
  );

  const response = await fetch(apiUrl(registry, "api/v1/gems"), {
    method: "POST",
    headers: { Authorization: apiKey },
    body,
  });

  if (response.status === 409) {
    return;
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Failed to push gem to ${registry.host}: HTTP ${response.status} - ${responseBody}`,
    );
  }
}

function apiUrl({ host }: RegistryConfig, path: string): string {
  return new URL(`${host}/${path}`).toString();
}
