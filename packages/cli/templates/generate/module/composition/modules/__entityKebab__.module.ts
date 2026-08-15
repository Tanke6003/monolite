import { container } from "tsyringe";
import { __entityName__Service } from "../../application/services/__entityKebab__.service";
import type { DataSource } from "../../infrastructure/persistence/data-source";
import { __entityConst__ } from "../../infrastructure/persistence/entities/__entityKebab__.entity";
import { __entityName__Controller } from "../../presentation/controllers/__entityKebab__.controller";
import { TOKENS } from "../tokens";
import { __entityUpper___TOKENS } from "./__entityKebab__.tokens";

// #if memory
/**
 * Rows the in-memory driver starts with, so the module answers something on the
 * first request. A real engine ignores this: its rows come from a migration,
 * not from the process that queries them.
 */
const SEED = [
  { name: "First __entityKebab__", description: "Created by the scaffold" },
  { name: "Second __entityKebab__", description: null },
];
// #endif

/**
 * The three layers of the __entityKebab__ module.
 *
 * Transient on purpose: they hold no state between requests, and the router
 * resolves each controller once at startup, so making them singletons would
 * save nothing and would hide an accidental field the day somebody adds one.
 *
 * The store is the exception, and it is a value rather than a class: it is the
 * generic repository already bound to the active engine, and building a second
 * one per request would mean a second connection pool.
 */
export function __registerFn__(): void {
  const dataSource = container.resolve<DataSource>(TOKENS.DataSource);

  container.register(__entityUpper___TOKENS.store, {
    // #if memory
    useValue: dataSource.repository(__entityConst__, SEED),
    // #else
    useValue: dataSource.repository(__entityConst__),
    // #endif
  });

  container.register(__entityUpper___TOKENS.service, { useClass: __entityName__Service });
  container.register(__entityUpper___TOKENS.controller, { useClass: __entityName__Controller });
}
