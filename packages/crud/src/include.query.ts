import type { IGenericRepository, WhereFilter } from "monolite-data";

/**
 * The equivalent of EF Core's `Include()` for this architecture.
 *
 * Relations between aggregates are not resolved in the repository — each
 * repository knows a single table — but here, in the application layer, which
 * is where the business rules live and where it is decided what has to be
 * brought along.
 *
 * The load is *batched*: a single `WHERE key IN (...)` query per relation
 * instead of one per row, which is exactly what EF does when it materialises an
 * Include.
 */
export interface IncludeSpec<TParent, TRelated, TKey = number> {
  /** Property of the parent that holds the foreign key. */
  foreignKey: Extract<keyof TParent, string>;
  /** Key property of the related entity. */
  relatedKey: Extract<keyof TRelated, string>;
  repository: IGenericRepository<TRelated, TKey>;
  /**
   * `true` by default: a row must keep showing the name of what it points at
   * even when that parent has since been soft-deleted. Hiding it would turn a
   * historical record into an unreadable one.
   */
  withDeleted?: boolean;
}

/**
 * Resolves an N:1 relation and returns an index `key -> related entity`.
 * Null keys are ignored (an optional relation) and no query is fired at all
 * when there is nothing to resolve.
 */
export async function loadRelated<TParent, TRelated, TKey = number>(
  parents: TParent[],
  spec: IncludeSpec<TParent, TRelated, TKey>
): Promise<Map<unknown, TRelated>> {
  const ids = [
    ...new Set(
      parents
        .map((parent) => (parent as Record<string, unknown>)[spec.foreignKey])
        .filter((id): id is NonNullable<unknown> => id !== null && id !== undefined)
    ),
  ];

  if (ids.length === 0) return new Map();

  const related = await spec.repository.find({
    where: { [spec.relatedKey]: { in: ids } } as WhereFilter<TRelated>,
    withDeleted: spec.withDeleted ?? true,
  });

  return new Map(
    related.map((entity) => [(entity as Record<string, unknown>)[spec.relatedKey], entity])
  );
}
