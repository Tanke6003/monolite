/**
 * The repository contract kit, on a subpath of its own.
 *
 * It is a test kit, not part of the runtime surface, and it was documented as
 * `monolite-data/testing` long before that subpath existed — which is a fair
 * signal about where people expect it to live. Until now the guide's import was
 * simply impossible: the manifest declared only `"."`, so it resolved for
 * nobody.
 *
 * The root keeps exporting the same names, so nothing that already imports them
 * from there has to move.
 */
export { CONTRACT_ENTITY, runGenericRepositoryContract } from "./repository-contract.js";
export type { ContractItem, ContractSetup } from "./repository-contract.js";
