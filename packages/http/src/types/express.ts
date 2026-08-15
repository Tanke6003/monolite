// Declaration merging to type the custom properties this package attaches to
// Express's Request:
//  - `user`: the decoded token payload set by the auth guard.
//  - `validatedQuery`: the parsed query set by the `validateQuery` middleware.

declare global {
  // `namespace` is the only syntax that augments Express's own declarations —
  // they are published as a namespace, so module syntax cannot reach them.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Payload of the token the auth guard decoded, or the raw string when the
       * token carried no JSON payload.
       *
       * It is a plain bag of claims rather than `jsonwebtoken`'s `JwtPayload`:
       * typing it that way would drag a signing library into the HTTP layer for
       * a shape that whoever verifies the token decides.
       */
      user?: string | Record<string, unknown>;
      /**
       * Output of the schema handed to `validateQuery`. Every module uses a
       * different schema, so the concrete type is asserted by the controller
       * that consumes it.
       *
       * It is a property of its own and not `req.query` because in Express 5
       * `req.query` is a getter with no setter, so the parsed value cannot be
       * written back over it.
       */
      validatedQuery?: unknown;
    }
  }
}

export {};
