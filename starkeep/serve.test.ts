// @vitest-environment node
/**
 * Smoke test for the local Starkeep server (AI-617): a real Starkeep-mode
 * build of the SPA, served by `startServer` on a free loopback port, driven
 * over `node:http` the way a browser or MCP client reaches it.
 *
 * `node:http` rather than `fetch`: `fetch` will not set a `Host` header, and
 * the global `fetch` is stubbed for the data server, which would also catch
 * the test's own requests.
 */
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIALIZE, mcpHeaders, TEST_CREDS } from "./test-support.js";
import { assertStarkeepMainChunk, buildStarkeepSpa, mainChunkPath } from "./spa-build.js";

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

// After the mock: `serve.ts` loads `server.ts`, which must see it.
const { portFromArgv, startServer } = await import("./serve.js");

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_TIMEOUT = 180_000;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

let tempDir: string;
let outDir: string;
let server: { port: number; close: () => Promise<void> } | undefined;

function request(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, path, method: opts.method ?? "GET", headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          done({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8") });
        });
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "exercise-serve-"));
  outDir = join(tempDir, "dist");
  await buildStarkeepSpa(
    { root: APP_DIR, logLevel: "warn", build: { outDir, emptyOutDir: true } },
    { marker: true },
  );
  // The marker is written and the build is newer than its sources, so this does not rebuild.
  server = await startServer({ distDir: outDir, port: 0 });
}, BUILD_TIMEOUT);

afterAll(async () => {
  await server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Requests that reached the (stubbed) data server. */
let dataHits: number;
beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  dataHits = 0;
  vi.stubGlobal("fetch", async () => {
    dataHits += 1;
    return Response.json({ rows: [], truncated: false, page_token: null });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startServer (real Starkeep build)", () => {
  it("binds a real port when asked for port 0", () => {
    expect(server!.port).toBeGreaterThan(0);
  });

  it("GET / answers the shell; client routes and missing assets fall back to it", async () => {
    const root = await request("/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(root.text).toContain('<div id="root">');

    const route = await request("/some/client/route");
    expect(route.status).toBe(200);
    expect(route.text).toBe(root.text);

    const missing = await request("/assets/nonexistent.js");
    expect(missing.status).toBe(200);
    expect(missing.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(missing.text).toBe(root.text);
  });

  it("GET /mcp-login answers the shell, and the main chunk is a Starkeep build served byte-identical", async () => {
    const login = await request("/mcp-login");
    expect(login.status).toBe(200);
    expect(login.text).toContain('<div id="root">');

    expect(() => assertStarkeepMainChunk(outDir)).not.toThrow();
    const chunk = mainChunkPath(outDir);
    const urlPath = "/" + relative(outDir, chunk).split(sep).join("/");
    const served = await request(urlPath);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(served.body.equals(readFileSync(chunk))).toBe(true);
  });

  it("GET /mcp is 405 with Allow: POST", async () => {
    const res = await request("/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("POST /mcp from a loopback client without a token answers initialize", async () => {
    const res = await request("/mcp", { method: "POST", headers: mcpHeaders(), body: JSON.stringify(INITIALIZE) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ result: { serverInfo: { name: "exercise" } } });
  });

  it("POST /mcp sent by a page on another site is 401", async () => {
    const res = await request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders(), "sec-fetch-site": "cross-site" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
  });

  it("the data proxy from a foreign Origin is 403 forbidden_origin", async () => {
    const res = await request("/api/local-data/app-data/db/programs", { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: "forbidden_origin" });
    expect(dataHits).toBe(0);
  });

  it("a non-loopback Host is 403", async () => {
    const res = await request("/", { headers: { host: "not-loopback.example" } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({ error: "Exercise answers on its loopback address only" });
  });

  it("GET /starkeep-runtime-config is 200 JSON", async () => {
    const res = await request("/starkeep-runtime-config");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(() => JSON.parse(res.text)).not.toThrow();
  });

  it("POST to a client path is 405 with Allow: GET, HEAD", async () => {
    const res = await request("/", { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });
});

describe("portFromArgv", () => {
  const envPort = process.env.PORT;
  afterEach(() => {
    if (envPort === undefined) delete process.env.PORT;
    else process.env.PORT = envPort;
  });

  it("reads -p and --port", () => {
    delete process.env.PORT;
    expect(portFromArgv(["-p", "5199"])).toBe(5199);
    expect(portFromArgv(["--port", "5200"])).toBe(5200);
  });

  it("prefers the flag over PORT and falls back to PORT without one", () => {
    process.env.PORT = "6000";
    expect(portFromArgv(["-p", "5199"])).toBe(5199);
    expect(portFromArgv([])).toBe(6000);
  });

  it("throws on a missing or invalid port", () => {
    delete process.env.PORT;
    expect(() => portFromArgv([])).toThrow(/needs a port/);
    expect(() => portFromArgv(["-p"])).toThrow(/needs a port/);
    expect(() => portFromArgv(["-p", "abc"])).toThrow(/needs a port/);
    expect(() => portFromArgv(["--port", "0"])).toThrow(/needs a port/);
    expect(() => portFromArgv(["-p", "1.5"])).toThrow(/needs a port/);
  });
});
