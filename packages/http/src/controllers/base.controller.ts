import { AppError, type CurrentUser, type IRequestContext } from "monolite-core";

/**
 * Base for controllers: it exposes the identity of the request without each one
 * having to read the token or take the context as a parameter.
 *
 * It is the equivalent of `BaseApiController` in .NET, which publishes the
 * claims to its controllers. The difference is where they come from: there,
 * `HttpContext.User`; here, the context opened by the request-context
 * middleware and filled in by the auth guard.
 */
export abstract class BaseController {
  protected constructor(protected readonly context: IRequestContext) {}

  /** The authenticated user, or `null` when the route is anonymous. */
  protected get currentUser(): CurrentUser | null {
    return this.context.getCurrentUser();
  }

  /**
   * Id of the user (the `sub` claim). This is what rules that depend on who is
   * asking must use: the name can change, the id cannot.
   */
  protected get userId(): string | null {
    return this.context.getCurrentUserId();
  }

  /** Name to display or record; `"System"` outside a request. */
  protected get userName(): string {
    return this.context.getCurrentUserName();
  }

  protected get userEmail(): string | null {
    return this.currentUser?.email ?? null;
  }

  /** Roles granted by the token; empty, never absent, when there are none. */
  protected get userRoles(): string[] {
    return this.currentUser?.roles ?? [];
  }

  /** Correlation id of the request; it also travels in `X-Request-Id`. */
  protected get requestId(): string | undefined {
    return this.context.getRequestId();
  }

  /**
   * The user id, demanding that it exists. For actions that make no sense
   * without an identity: it fails with a 401 instead of carrying on with
   * `null`.
   */
  protected requireUserId(): string {
    const id = this.userId;
    if (!id) {
      throw new AppError("No authenticated user in the request", 401, true, {
        code: "NO_AUTHENTICATED_USER",
      });
    }
    return id;
  }
}
