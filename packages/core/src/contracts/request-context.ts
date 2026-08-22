/**
 * Identity of the user behind the current request, taken from the token.
 * `name` is what gets written into the audit columns.
 */
export interface CurrentUser {
  id: string | null;
  name: string;
  email: string | null;

  /**
   * Roles granted to this user. The kernel never fills it in — the auth package
   * populates it while decoding the token, and anything that runs without one
   * (startup, scheduled jobs, seeds) leaves it empty rather than absent, so
   * authorisation checks can always iterate without a null guard.
   */
  roles: string[];
}

export interface RequestContextData {
  /** Request identifier; it travels in the log and in the error response. */
  requestId: string;
  user: CurrentUser | null;
}

/**
 * The context of the request in flight, reachable from any layer without being
 * passed as a parameter. It is the equivalent of `IHttpContextAccessor` in .NET.
 *
 * The generic repository needs it to fill `CREATED_BY` / `UPDATED_BY` without
 * every BLL having to drag the user all the way down to the CRUD.
 */
export interface IRequestContext {
  /** Runs `fn` with this context active, including everything async it starts. */
  run<T>(data: RequestContextData, fn: () => T): T;

  get(): RequestContextData | undefined;
  getCurrentUser(): CurrentUser | null;

  /**
   * Name for auditing. Returns `"System"` when there is no request in flight
   * (startup, scheduled jobs, seeds), the same way `BaseBll` does in .NET.
   */
  getCurrentUserName(): string;

  /**
   * Id of the authenticated user (the `sub` claim), or `null` when the request
   * is anonymous. This is what business rules that depend on who is asking
   * —resource ownership, permissions— must use, never the name, which can
   * change.
   */
  getCurrentUserId(): string | null;

  getRequestId(): string | undefined;
}
