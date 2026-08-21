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

/**
 * A relation the CRUD resolves on every DTO it hands back.
 *
 * `loadRelated` is the primitive and it was never the problem. Where it had to
 * be *called* was: `list`, `get`, `create` and `update`, in every service with a
 * relation, and nothing enforced any of the four. Forgetting two of them is not
 * hypothetical — it produces a resource with two shapes, carrying its relation
 * when it was read and not when it was written, and the compiler is happy
 * because the DTO declares the field either way.
 *
 * Declared here instead, and applied by `CrudService` in one place. There is no
 * longer anywhere to forget.
 */
export interface Include<TDto> {
  /** The DTO property this fills; `CrudService` checks the mapper declared it. */
  readonly into: Extract<keyof TDto, string>;
  /** Fills that property on a whole page, in one batched query. */
  hydrate(dtos: TDto[]): Promise<void>;
}

export interface IncludeDefinition<
  TDto,
  TRelated,
  TInto extends Extract<keyof TDto, string>,
> {
  /** The DTO property holding the foreign key. */
  key: Extract<keyof TDto, string>;
  /** The related entity's own key. */
  relatedKey: Extract<keyof TRelated, string>;
  repository: IGenericRepository<TRelated>;
  /** The DTO property the resolved value goes into. */
  into: TInto;
  /** What to take from the related row. */
  pick: (related: TRelated) => TDto[TInto];
  /**
   * `true` by default, and it matters: a row has to keep showing the name of
   * what it points at even after that parent has been withdrawn. Hiding it turns
   * a historical record into an unreadable one.
   */
  withDeleted?: boolean;
}

/**
 * Declares one relation, ready to hand to `CrudService`.
 *
 * @example
 * super(books, bookMapper, {
 *   orderBy: { field: "name", direction: "asc" },
 *   includes: [
 *     include<BookDTO, IAuthor>({
 *       key: "authorId",
 *       relatedKey: "pkAuthor",
 *       repository: authors,
 *       into: "author",
 *       pick: (author) => author.name,
 *     }),
 *   ],
 * });
 */
export function include<
  TDto extends object,
  TRelated extends object,
  TInto extends Extract<keyof TDto, string> = Extract<keyof TDto, string>,
>(definition: IncludeDefinition<TDto, TRelated, TInto>): Include<TDto> {
  return {
    into: definition.into,

    async hydrate(dtos: TDto[]): Promise<void> {
      const index = await loadRelated<TDto, TRelated>(dtos, {
        foreignKey: definition.key,
        relatedKey: definition.relatedKey,
        repository: definition.repository,
        withDeleted: definition.withDeleted,
      });

      for (const dto of dtos) {
        const row = dto as Record<string, unknown>;
        const key = row[definition.key];
        const related = key === null || key === undefined ? undefined : index.get(key);

        // `null` and not left absent: a key that points nowhere is known to be
        // empty, and an absent property reads as unknown.
        row[definition.into] = related === undefined ? null : definition.pick(related);
      }
    },
  };
}
