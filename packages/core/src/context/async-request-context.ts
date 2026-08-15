import { AsyncLocalStorage } from "node:async_hooks";
import type { CurrentUser, IRequestContext, RequestContextData } from "../contracts/request-context.js";

/** Audit value when there is no user: internal processes, seeds, startup. */
export const SYSTEM_USER = "System";

/**
 * Request context backed by `AsyncLocalStorage`.
 *
 * This is Node's equivalent of `IHttpContextAccessor`: the store survives every
 * `await`, so a repository called three layers down still sees the user of the
 * request without receiving it as a parameter. A plain module-level variable
 * would not do: two concurrent requests would overwrite each other.
 */
export class AsyncRequestContext implements IRequestContext {
  private readonly storage = new AsyncLocalStorage<RequestContextData>();

  run<T>(data: RequestContextData, fn: () => T): T {
    return this.storage.run(data, fn);
  }

  get(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  getCurrentUser(): CurrentUser | null {
    return this.storage.getStore()?.user ?? null;
  }

  getCurrentUserName(): string {
    return this.storage.getStore()?.user?.name ?? SYSTEM_USER;
  }

  getCurrentUserId(): string | null {
    return this.storage.getStore()?.user?.id ?? null;
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }
}
