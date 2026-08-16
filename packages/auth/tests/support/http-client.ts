/**
 * A minimal HTTP client built on node's own `http`.
 *
 * The original suite used supertest; it is not a dependency here, and adding
 * one for the tests would be a strange price to pay for a toolkit whose whole
 * point is not imposing dependencies. What these tests need from it is small —
 * send a request, read status, headers and body — and node already does that.
 *
 * `agent: false` on every request is not decoration: node's global agent keeps
 * connections alive, and a live keep-alive socket stops `server.close()` from
 * ever settling, which would hang the suite instead of failing it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Application } from "express";

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  /** The parsed JSON body, or `undefined` when the answer was not JSON. */
   
  body: any;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Anything that is not a string travels as JSON. */
  body?: unknown;
}

export interface TestClient {
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  get(path: string, options?: RequestOptions): Promise<TestResponse>;
  post(path: string, options?: RequestOptions): Promise<TestResponse>;
  put(path: string, options?: RequestOptions): Promise<TestResponse>;
  patch(path: string, options?: RequestOptions): Promise<TestResponse>;
  del(path: string, options?: RequestOptions): Promise<TestResponse>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A client aimed at an origin somebody else is listening on. */
export function httpClient(origin: string): TestClient {
  const request = (
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<TestResponse> =>
    new Promise<TestResponse>((resolve, reject) => {
      const url = new URL(path, origin);
      const headers: Record<string, string> = { ...options.headers };
      let payload: string | undefined;

      if (options.body !== undefined) {
        payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        const declared = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
        if (!declared) headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }

      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text,
              body: parseJson(text),
            });
          });
        }
      );

      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  return {
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    patch: (path, options) => request("PATCH", path, options),
    del: (path, options) => request("DELETE", path, options),
  };
}

export interface ServedApp {
  client: TestClient;
  origin: string;
  close(): Promise<void>;
}

/** Listens on a free port and hands back a client aimed at it. */
export async function serve(app: Application): Promise<ServedApp> {
  const server = await new Promise<http.Server>((resolve, reject) => {
    const listening = app.listen(0);
    listening.once("error", reject);
    listening.once("listening", () => resolve(listening));
  });

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    client: httpClient(origin),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
