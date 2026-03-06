import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryConfig } from "./config";
import { exchangeOidcToken, pushToRegistry } from "./registry";

const { mockGetIDToken } = vi.hoisted(() => ({
  mockGetIDToken: vi.fn<() => Promise<string>>(),
}));

vi.mock("@actions/core", () => ({
  getIDToken: mockGetIDToken,
}));

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => {
      try {
        return Promise.resolve(JSON.parse(body));
      } catch {
        return Promise.resolve(null);
      }
    },
  } as unknown as Response;
}

describe("exchangeOidcToken", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetIDToken.mockReset();
  });

  it("calls getIDToken with audience 'rubygems.org'", async () => {
    mockGetIDToken.mockResolvedValue("oidc-token");
    mockFetch.mockResolvedValue(
      makeResponse(200, JSON.stringify({ api_key: "abc" })),
    );

    await exchangeOidcToken();

    expect(mockGetIDToken).toHaveBeenCalledWith("rubygems.org");
  });

  it("posts to the correct URL", async () => {
    mockGetIDToken.mockResolvedValue("oidc-token");
    mockFetch.mockResolvedValue(
      makeResponse(200, JSON.stringify({ api_key: "abc" })),
    );

    await exchangeOidcToken();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token",
      expect.anything(),
    );
  });

  it("sends the OIDC token as jwt in the JSON body", async () => {
    mockGetIDToken.mockResolvedValue("my-oidc-jwt");
    mockFetch.mockResolvedValue(
      makeResponse(200, JSON.stringify({ api_key: "key" })),
    );

    await exchangeOidcToken();

    const [, options] = mockFetch.mock.calls[0];
    expect(options?.body).toBe(JSON.stringify({ jwt: "my-oidc-jwt" }));
  });

  it("sends Content-Type and Accept: application/json headers", async () => {
    mockGetIDToken.mockResolvedValue("my-oidc-jwt");
    mockFetch.mockResolvedValue(
      makeResponse(200, JSON.stringify({ api_key: "key" })),
    );

    await exchangeOidcToken();

    const [, options] = mockFetch.mock.calls[0];
    expect(options?.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
  });

  it("returns the api_key field from the response JSON", async () => {
    mockGetIDToken.mockResolvedValue("token");
    mockFetch.mockResolvedValue(
      makeResponse(200, JSON.stringify({ api_key: "short-lived-key" })),
    );

    const result = await exchangeOidcToken();

    expect(result).toBe("short-lived-key");
  });

  it("throws on a non-2xx HTTP response", async () => {
    mockGetIDToken.mockResolvedValue("token");
    mockFetch.mockResolvedValue(makeResponse(401, "Unauthorized"));

    await expect(exchangeOidcToken()).rejects.toThrow(/HTTP 401/);
  });

  it("throws on a 5xx HTTP response", async () => {
    mockGetIDToken.mockResolvedValue("token");
    mockFetch.mockResolvedValue(makeResponse(500, "Internal Server Error"));

    await expect(exchangeOidcToken()).rejects.toThrow(/HTTP 500/);
  });
});

describe("pushToRegistry", () => {
  let tmpDir: string;
  let gemPath: string;
  let attestationPath: string;

  const rubygemsRegistry: RegistryConfig = {
    host: "https://rubygems.org",
  };
  const otherRegistry: RegistryConfig = {
    host: "https://gems.example.com",
  };

  const GEM_CONTENT = Buffer.from("fake gem binary content");
  const ATTESTATION_BUNDLE = {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: {},
  };

  // For rubygems.org tests, pushToRegistry makes two fetch calls: first to
  // exchange the OIDC token, then to push the gem. This helper queues both.
  function setupRubygemsFetch(pushStatus: number, pushBody = "") {
    mockGetIDToken.mockResolvedValue("oidc-token");
    mockFetch
      .mockResolvedValueOnce(
        makeResponse(200, JSON.stringify({ api_key: "rubygems_api_key" })),
      )
      .mockResolvedValueOnce(makeResponse(pushStatus, pushBody));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gems-reg-test-"));
    gemPath = path.join(tmpDir, "my-gem-1.0.0.gem");
    attestationPath = `${gemPath}.sigstore.json`;
    fs.writeFileSync(gemPath, GEM_CONTENT);
    fs.writeFileSync(attestationPath, JSON.stringify(ATTESTATION_BUNDLE));

    mockFetch.mockReset();
    mockGetIDToken.mockReset();
    process.env.GEM_HOST_API_KEY = "";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.GEM_HOST_API_KEY = "";
  });

  it("calls exchangeOidcToken for rubygems.org", async () => {
    setupRubygemsFetch(200);

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    expect(mockGetIDToken).toHaveBeenCalledWith("rubygems.org");
  });

  it("sends the exchanged API key as the Authorization header for rubygems.org", async () => {
    mockGetIDToken.mockResolvedValue("oidc-token");
    mockFetch
      .mockResolvedValueOnce(
        makeResponse(200, JSON.stringify({ api_key: "rubygems_secret_key" })),
      )
      .mockResolvedValueOnce(makeResponse(200));

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    const [, options] = mockFetch.mock.lastCall!;
    expect(options?.headers).toMatchObject({
      Authorization: "rubygems_secret_key",
    });
  });

  it("posts to https://rubygems.org/api/v1/gems", async () => {
    setupRubygemsFetch(200);

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    const [url] = mockFetch.mock.lastCall!;
    expect(url).toBe("https://rubygems.org/api/v1/gems");
  });

  it("does not call exchangeOidcToken for a non-rubygems.org registry", async () => {
    process.env.GEM_HOST_API_KEY = "env-api-key";
    mockFetch.mockResolvedValue(makeResponse(200));

    await pushToRegistry(otherRegistry, gemPath, [attestationPath]);

    expect(mockGetIDToken).not.toHaveBeenCalled();
  });

  it("uses GEM_HOST_API_KEY from environment for a non-rubygems.org registry", async () => {
    process.env.GEM_HOST_API_KEY = "env-api-key";
    mockFetch.mockResolvedValue(makeResponse(200));

    await pushToRegistry(otherRegistry, gemPath, [attestationPath]);

    const [, options] = mockFetch.mock.calls[0];
    expect(options?.headers).toMatchObject({ Authorization: "env-api-key" });
  });

  it("throws if GEM_HOST_API_KEY is unset for a non-rubygems.org registry", async () => {
    await expect(
      pushToRegistry(otherRegistry, gemPath, [attestationPath]),
    ).rejects.toThrow(/GEM_HOST_API_KEY/);
  });

  it("posts to the correct host URL for a non-rubygems.org registry", async () => {
    process.env.GEM_HOST_API_KEY = "env-api-key";
    mockFetch.mockResolvedValue(makeResponse(200));

    await pushToRegistry(otherRegistry, gemPath, [attestationPath]);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gems.example.com/api/v1/gems");
  });

  it("sends a FormData body", async () => {
    setupRubygemsFetch(200);

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    const [, options] = mockFetch.mock.lastCall!;
    expect(options?.body).toBeInstanceOf(FormData);
  });

  it("includes the gem file with correct filename in the form data", async () => {
    setupRubygemsFetch(200);

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    const [, options] = mockFetch.mock.lastCall!;
    const body = options?.body as FormData;
    const gemField = body.get("gem") as File;
    expect(gemField).toBeInstanceOf(File);
    expect(gemField.name).toBe("my-gem-1.0.0.gem");
  });

  it("includes the attestation as a JSON array with application/json content type", async () => {
    setupRubygemsFetch(200);

    await pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]);

    const [, options] = mockFetch.mock.lastCall!;
    const body = options?.body as FormData;
    const attestationsField = body.get("attestations") as Blob;
    expect(attestationsField).toBeInstanceOf(Blob);
    expect(attestationsField.type).toBe("application/json");
    expect(await attestationsField.text()).toBe(
      JSON.stringify([ATTESTATION_BUNDLE]),
    );
  });

  it("resolves on HTTP 200", async () => {
    setupRubygemsFetch(200);

    await expect(
      pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]),
    ).resolves.toBeUndefined();
  });

  it("resolves on HTTP 409 (already published)", async () => {
    setupRubygemsFetch(409);

    await expect(
      pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]),
    ).resolves.toBeUndefined();
  });

  it("throws on HTTP 422", async () => {
    setupRubygemsFetch(422, "Unprocessable Entity");

    await expect(
      pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]),
    ).rejects.toThrow(/HTTP 422/);
  });

  it("throws on HTTP 500", async () => {
    setupRubygemsFetch(500, "Internal Server Error");

    await expect(
      pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("includes the response body in the error message on failure", async () => {
    setupRubygemsFetch(403, "Forbidden: invalid API key");

    await expect(
      pushToRegistry(rubygemsRegistry, gemPath, [attestationPath]),
    ).rejects.toThrow("Forbidden: invalid API key");
  });
});
