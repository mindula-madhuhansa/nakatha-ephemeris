// HTTP front of the service: auth, size limits, JSON in/out. No framework: the surface is five POST routes.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { HttpError, handle, isRoute } from "./api.ts";

const MAX_BODY = 256 * 1024;

export type Options = {
  /** Shared secret required as "Authorization: Bearer <token>". Empty only if allowAnon. */
  token?: string;
  allowAnon?: boolean;
  /** Public repository, offered at GET /source (AGPL section 13). */
  sourceUrl?: string;
  log?: (line: Record<string, unknown>) => void;
};

// Compare digests so the check takes the same time whatever the token length.
const digest = (s: string) => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Keep draining without storing; the response closes the socket (see the handler).
        if (size - chunk.length <= MAX_BODY) reject(new HttpError(413, "request too large"));
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createEphemerisServer(options: Options): Server {
  const { token = "", allowAnon = false, sourceUrl = "", log = () => {} } = options;
  if (!token && !allowAnon) throw new Error("EPHEMERIS_TOKEN is required (or set EPHEMERIS_ALLOW_ANON=1 for local development)");

  return createServer(async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    let status = 500;
    try {
      if (url.pathname === "/healthz" && req.method === "GET") {
        status = 200;
        return send(res, status, { ok: true, service: "nakatha-ephemeris", ephemeris: "moshier", ayanamsa: "lahiri", source: sourceUrl || null });
      }
      if (url.pathname === "/source" && req.method === "GET") {
        if (!sourceUrl) throw new HttpError(404, "not found");
        status = 302;
        res.writeHead(status, { location: sourceUrl });
        return res.end();
      }
      if (!isRoute(url.pathname)) throw new HttpError(404, "not found");
      if (req.method !== "POST") throw new HttpError(405, "use POST");
      if (!allowAnon || token) {
        const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        if (!given || !sameToken(given, token)) throw new HttpError(401, "unauthorized");
      }
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new HttpError(413, "request too large");
      let input: unknown;
      try {
        input = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "body is not valid JSON");
      }
      status = 200;
      send(res, status, handle(url.pathname, input));
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        const extra: Record<string, string> = status === 401 ? { "www-authenticate": "Bearer" } : {};
        if (status === 413) {
          // Don't keep reading an oversized upload: answer, then close the connection.
          extra.connection = "close";
          res.once("finish", () => req.destroy());
        }
        send(res, status, { error: err.message }, extra);
      } else {
        status = 500;
        send(res, status, { error: "internal error" });
        log({ level: "error", path: url.pathname, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      log({ method: req.method, path: url.pathname, status, ms: Math.round(performance.now() - started) });
    }
  });
}

if (import.meta.main) {
  const production = process.env.NODE_ENV === "production";
  const server = createEphemerisServer({
    token: process.env.EPHEMERIS_TOKEN ?? "",
    allowAnon: process.env.EPHEMERIS_ALLOW_ANON === "1" && !production,
    sourceUrl: process.env.SOURCE_URL ?? "",
    log: (line) => console.log(JSON.stringify(line)),
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 65_000; // longer than common proxy/load-balancer idle timeouts
  const port = Number(process.env.PORT ?? 4010);
  const host = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
  server.listen(port, host, () => console.log(JSON.stringify({ listening: `${host}:${port}` })));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => process.exit(0)));
}
