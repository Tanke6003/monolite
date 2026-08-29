import { AppError } from "monolite-core";
import type { AuthUser } from "./contracts.js";

/**
 * What every login flow in this package answers with, whichever one it is.
 *
 * There are two `IAuthBLL` implementations here — one that checks a password
 * against a hash it was handed, one that asks an external provider — and the
 * whole point of the first function below is that an attacker cannot tell them
 * apart, let alone tell two failures apart. Two copies of "the same" error
 * would drift: a code renamed on one side, a message reworded on the other, and
 * suddenly the deployment that runs both (external provider, local password as
 * the way back in) leaks which path a request took. One definition, imported by
 * both, is the only version of this that stays true.
 */

/**
 * The one error a failed login produces.
 *
 * "That email does not exist" and "that password is wrong" are answered
 * identically, with the same code and the same status. Telling them apart turns
 * the login form into a lookup service: an attacker submits a list of addresses
 * with a junk password and walks away knowing which ones are registered. That
 * matters on its own — knowing somebody has an account somewhere is often the
 * sensitive part — and it also halves the work of the attack that follows,
 * because guessing passwords is only worth doing against addresses known to
 * exist.
 */
export function invalidCredentials(): AppError {
  return new AppError("Invalid email or password", 401, true, {
    code: "INVALID_CREDENTIALS",
  });
}

/**
 * Strips the secret. Written field by field rather than as a spread with the
 * hash deleted afterwards: a new secret added to `AuthUserWithSecret` later
 * would be published by the spread and silently ride out to the client, while
 * here it simply does not appear.
 */
export function publicUser(user: AuthUser): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
  };
}
