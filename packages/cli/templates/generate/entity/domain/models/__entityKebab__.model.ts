/**
 * `__entityName__`, as the domain sees it.
 *
 * A plain interface: no decorators, no base class, nothing imported from the
 * framework. That is what lets the same entity be persisted to any of the six
 * drivers and be constructed in a test without a container — how it maps to a
 * table is declared one layer out, in
 * `infrastructure/persistence/entities/__entityKebab__.entity.ts`.
 *
 * The last four fields are filled in by the generic repository, not by your
 * code: `available` is the soft-delete flag, the timestamps come from the
 * entity's `timestamps` mapping and the two `*By` columns from the request
 * context, so no BLL has to carry the current user down to the CRUD.
 */
export interface I__entityName__ {
  __pkProperty__: number;
  name: string;
  description?: string | null;
  /** Soft delete: `false` means the row is still there but no longer listed. */
  available?: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  createdBy?: string | null;
  updatedBy?: string | null;
}
