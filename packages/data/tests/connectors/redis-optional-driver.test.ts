/**
 * `redis` is an optional peer dependency like the database drivers: a project
 * that keeps its cache in memory never installs it, and one that asked for
 * Redis without installing it is told which package to add — at start-up,
 * when the cache is built, rather than at the first request.
 */
jest.mock("redis", () => {
  const error = new Error("Cannot find module 'redis' from 'redis-cache.ts'") as NodeJS.ErrnoException;
  error.code = "MODULE_NOT_FOUND";
  throw error;
});

import type { ILogger } from "monolite-core";
import { RedisCache } from "monolite-data";

const logger = { info: jest.fn(), error: jest.fn() } as unknown as ILogger;

describe("RedisCache without the redis package", () => {
  it("can be imported: the package is only required when a cache is built", () => {
    expect(typeof RedisCache).toBe("function");
  });

  it("names the package to install and the way out of needing it", () => {
    expect(() => new RedisCache({ url: "redis://localhost" }, logger)).toThrow(
      /\[cache\] The Redis connector needs "redis".*npm install redis.*CACHE_DRIVER=memory/s
    );
  });
});
