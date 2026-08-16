import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { SYSTEM_USER, type CurrentUser, type IRequestContext } from "monolite-core";

/** Header the request identifier is propagated with — or received on. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Claim names that are tried, in order, to obtain a human-readable name.
 * The list covers what the usual providers emit (OIDC, Azure AD / ADFS) on top
 * of the development token this toolkit issues.
 */
const NAME_CLAIMS = ["name", "nameComplete", "preferred_username", "samaccountname", "username"];
const EMAIL_CLAIMS = ["email", "emails", "upn"];
const ID_CLAIMS = ["sub", "userId", "id", "oid"];
/**
 * Where roles usually live. Two spellings because providers disagree: the
 * plural for a list, the singular for a token that carries exactly one.
 */
const ROLE_CLAIMS = ["roles", "role"];

/**
 * A decoded token, as far as this middleware is concerned.
 *
 * It is deliberately not `JwtPayload`: typing it that way would drag
 * `jsonwebtoken` into the HTTP package for a shape that is, in the end, a bag
 * of claims. Whoever decodes the token — the auth package, a provider's SDK,
 * a test — hands over that bag and this file only reads from it.
 */
export type TokenClaims = Record<string, unknown>;

function firstClaim(payload: TokenClaims, claims: string[]): string | null {
  for (const claim of claims) {
    const value = payload[claim];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

/**
 * Roles as a list, whatever shape the provider used.
 *
 * Never `undefined`: `CurrentUser.roles` is always an array so an authorisation
 * check can iterate without a null guard, and an absent claim means "no roles",
 * not "unknown".
 */
function rolesFrom(payload: TokenClaims): string[] {
  for (const claim of ROLE_CLAIMS) {
    const value = payload[claim];
    if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
    if (Array.isArray(value)) {
      const roles = value.filter((role): role is string => typeof role === "string" && role.trim().length > 0);
      if (roles.length > 0) return roles.map((role) => role.trim());
    }
  }
  return [];
}

/**
 * Translates the token payload into the identity auditing uses. If the token
 * carries no name it falls back to the email and then to the id, so that
 * `CREATED_BY` gets something identifiable instead of `System`.
 */
export function toCurrentUser(payload: string | TokenClaims | undefined): CurrentUser | null {
  if (!payload || typeof payload !== "object") return null;

  const claims = payload;
  const id = firstClaim(claims, ID_CLAIMS);
  const email = firstClaim(claims, EMAIL_CLAIMS);
  const name = firstClaim(claims, NAME_CLAIMS) ?? email ?? id;

  if (!name) return null;
  return { id, name, email, roles: rolesFrom(claims) };
}

/**
 * Opens the request context and leaves everything that comes afterwards inside
 * it.
 *
 * It goes **before** the routes so that even an early failure has a
 * `requestId`, and it reads the user lazily: when this middleware runs the auth
 * guard has not put anything on the request yet, so the context is completed as
 * soon as an authenticated route does.
 */
export function requestContext(context: IRequestContext): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // An id coming from a proxy or from another service is honoured, so one
    // operation can be followed across several hops.
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    context.run({ requestId, user: null }, () => {
      next();
    });
  };
}

/** Name to record in the audit trail for the request in flight. */
export function currentUserName(context: IRequestContext): string {
  return context.getCurrentUser()?.name ?? SYSTEM_USER;
}
