import { describe, test, expect } from "bun:test";
import { isSensitiveEnvKey, isSensitiveHeaderKey } from "../src/mcp/validation.ts";
import { splitSecrets, envStoreKey, headerStoreKey } from "../src/mcp/secure-helpers.ts";
import type { McpServerConfig } from "../src/mcp/types.ts";

describe("isSensitiveEnvKey", () => {
  test("classifies common credentials as sensitive (previously stored plaintext)", () => {
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MYSQL_PWD", "PASSPHRASE", "API_KEY", "CLOUDFLARE_AUTH_TOKEN", "SIGNING_KEY", "ENCRYPTION_KEY", "DB_PASSWORD"]) {
      expect(isSensitiveEnvKey(k), k).toBe(true);
    }
  });
  test("does not classify non-secrets as sensitive", () => {
    for (const k of ["DEBUG", "PATH", "HOME", "LOG_LEVEL", "EDITOR", "PORT"]) {
      expect(isSensitiveEnvKey(k), k).toBe(false);
    }
  });
});

describe("isSensitiveHeaderKey", () => {
  test("classifies auth/credential headers as sensitive", () => {
    for (const k of ["Authorization", "X-Api-Key", "Set-Cookie", "Proxy-Authorization"]) {
      expect(isSensitiveHeaderKey(k), k).toBe(true);
    }
  });
  test("does not classify benign headers as sensitive", () => {
    for (const k of ["Content-Type", "Accept", "User-Agent"]) {
      expect(isSensitiveHeaderKey(k), k).toBe(false);
    }
  });
});

describe("splitSecrets", () => {
  const config: McpServerConfig = {
    id: "svc",
    name: "Svc",
    transport: "stdio",
    stdio: { command: "node", env: { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", DEBUG: "1" } },
  };

  test("moves new credentials into the secure store and redacts them in plain config", () => {
    const { plain, secrets } = splitSecrets(config);
    expect(secrets[envStoreKey("svc", "AWS_ACCESS_KEY_ID")]).toBe("AKIAEXAMPLE");
    expect(plain.stdio!.env!["AWS_ACCESS_KEY_ID"]).toBe("***");
    // Non-secret env stays plain (unencrypted), so health checks and hydration still see it.
    expect(plain.stdio!.env!["DEBUG"]).toBe("1");
    expect(secrets[envStoreKey("svc", "DEBUG")]).toBeUndefined();
  });

  test("redacts sensitive http headers into the store", () => {
    const httpConfig: McpServerConfig = {
      id: "srv",
      name: "Srv",
      transport: "http",
      http: { url: "http://127.0.0.1:3000/mcp", headers: { Authorization: "Bearer abc", "Content-Type": "application/json" } },
    };
    const { plain, secrets } = splitSecrets(httpConfig);
    expect(secrets[headerStoreKey("srv", "Authorization")]).toBe("Bearer abc");
    expect(plain.http!.headers!["Authorization"]).toBe("***");
    expect(plain.http!.headers!["Content-Type"]).toBe("application/json");
  });
});
