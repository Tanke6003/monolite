import type { IGenericRepository, OrderByClause, QueryOptions } from "monolite-data";
import { AppError } from "monolite-core";
import type { Include } from "./include.query.js";
import type { MappingProfile } from "./mapper.js";
import { hydratedFields } from "./mapper.js";

/**
 * A page of results as it leaves over HTTP.
 *
 * It is deliberately not the repository's `PagedResult`: that one calls the
 * rows `items` because it knows nothing about HTTP, and the response body has
 * called them `data` since the first endpoint. Keeping the two shapes apart
 * means the wire format cannot drift just because the data layer renames a
 * field, and the translation happens in exactly one place — `CrudBLL.list`.
 */
export interface PaginatedDTO<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

/** What the generic CRUD needs from a mapper (see `mapper.ts`). */
export interface EntityMapper<T, TDto> {
  toDTO(entity: T): TDto;
  toDTOList(entities: T[]): TDto[];
  toEntity(dto: Partial<TDto>): Partial<T>;
  toPartialEntity(dto: Partial<TDto>): Partial<T>;
}

/** The contract `CrudController` consumes. */
export interface ICrudBLL<TDto> {
  list(page: number, limit: number, options?: ListOptions): Promise<PaginatedDTO<TDto>>;
  get(id: number): Promise<TDto | null>;
  create(dto: Partial<TDto>): Promise<TDto>;
  update(id: number, dto: Partial<TDto>): Promise<TDto | null>;
  softDelete(id: number): Promise<boolean>;
}

export interface ListOptions {
  withDeleted?: boolean;
  /** The already-validated query of the route; `buildWhere` interprets it. */
  query?: unknown;
}

/** What a module tells `CrudBLL` about itself, beyond the two it must. */
export interface CrudBLLOptions<T, TDto> {
  /** Default ordering of the listing; without it, the primary key's. */
  orderBy?: OrderByClause<T>;
  /**
   * The relations every DTO this service hands back carries.
   *
   * Declared here rather than resolved per verb, which is the whole point: see
   * `include()`. A field the mapper marks with `hydrated()` and no include fills
   * is refused at construction time.
   */
  includes?: Include<TDto>[];
}

/**
 * The third constructor argument used to be the ordering and nothing else, and
 * a great deal of code passes it that way. Both shapes are accepted, told apart
 * by the one key an `OrderByClause` always has.
 */
function settingsOf<T, TDto>(
  options?: OrderByClause<T> | CrudBLLOptions<T, TDto>
): CrudBLLOptions<T, TDto> {
  if (!options) return {};
  return "field" in options ? { orderBy: options } : options;
}

/**
 * A module's CRUD, written once.
 *
 * It is the same move the generic repository made with the database, one layer
 * up: down there you described the table and got the CRUD without writing SQL;
 * here you supply the repository and the mapper and get the CRUD without
 * repeating the pass-through that every flat service used to write identically.
 *
 * **What it does not do: business rules.** A module that has rules — checking
 * an overlap, cascading a cancellation — overrides the verb that carries them
 * and keeps the rest. If a service had to contort itself to fit in here, the
 * right answer is not to extend this class.
 */
export abstract class CrudBLL<T extends object, TDto> implements ICrudBLL<TDto> {
  /** Default ordering of the listing; without it, the primary key's. */
  protected readonly defaultOrderBy?: OrderByClause<T>;

  private readonly includes: Include<TDto>[];

  protected constructor(
    protected readonly repository: IGenericRepository<T>,
    protected readonly mapper: EntityMapper<T, TDto>,
    options?: OrderByClause<T> | CrudBLLOptions<T, TDto>
  ) {
    const settings = settingsOf<T, TDto>(options);

    this.defaultOrderBy = settings.orderBy;
    this.includes = settings.includes ?? [];

    this.assertEveryHydratedFieldIsFilled();
  }

  /**
   * Refuses to be built when the mapper declares a hydrated field nothing fills.
   *
   * At construction time, so it fails while the container is being assembled and
   * names the field — rather than answering `null` on that property for the life
   * of the process. It is the same trade the composition root already makes for
   * `JWT_SECRET`: an arrangement that cannot work should not start.
   *
   * Only a mapper built by `createMapper` carries a profile to read, so a
   * hand-written one is taken on trust. It is a check, not a proof.
   */
  private assertEveryHydratedFieldIsFilled(): void {
    const profile = (this.mapper as { profile?: MappingProfile<T, TDto> }).profile;
    if (!profile) return;

    const filled = new Set<string>(this.includes.map((one) => one.into as string));
    const missing = hydratedFields(profile).filter((name) => !filled.has(name));
    if (missing.length === 0) return;

    const one = missing.length === 1;
    throw new Error(
      `[crud] ${this.constructor.name}: ${missing.join(", ")} ${one ? "is" : "are"} ` +
        `declared with hydrated() and no include fills ${one ? "it" : "them"}.`
    );
  }

  /**
   * Fills in the relations, once per set of DTOs.
   *
   * Every verb that hands a DTO out goes through here, and that is the point:
   * calling `loadRelated` from `list`, `get`, `create` and `update` separately
   * is four places to forget, and forgetting two of them produces a resource
   * that carries its relation when read and not when written.
   *
   * The includes run concurrently — they are independent queries against
   * different repositories — and they write into the DTOs the mapper has just
   * produced, which nothing else holds a reference to yet.
   */
  private async hydrate(dtos: TDto[]): Promise<TDto[]> {
    if (this.includes.length === 0 || dtos.length === 0) return dtos;

    await Promise.all(this.includes.map((one) => one.hydrate(dtos)));
    return dtos;
  }

  /**
   * The listing filter, built from the route's query.
   *
   * By default it does not filter: a flat CRUD is paged and that is that. A
   * module that offers search overrides **only this** and keeps the rest of the
   * listing.
   */
  protected buildWhere(_query: unknown): QueryOptions<T>["where"] {
    return undefined;
  }

  /**
   * A last chance to complete the query before it becomes a filter.
   *
   * `buildWhere` is synchronous, and that is not an oversight: it is the hook
   * every module overrides, and one that could await would put a query in front
   * of every listing in the project — paid by all of them, needed by few.
   *
   * But some filters genuinely have to read somewhere else first. "Books whose
   * author is called Le Guin" is two steps: the keys of the authors whose name
   * matches, then the books holding those keys. Without a seam for that step, a
   * module has to override `list` itself and copy the paging, the ordering and
   * everything else the base class was doing for it — and each copy is a place
   * to drop one of them.
   *
   * So: override this to turn the route's query into a richer one, and let
   * `buildWhere` stay a pure function of what it is handed. A module that does
   * not override it fires nothing extra.
   */
  protected async resolveQuery(query: unknown): Promise<unknown> {
    return query;
  }

  async list(page: number, limit: number, options: ListOptions = {}): Promise<PaginatedDTO<TDto>> {
    const query: Omit<QueryOptions<T>, "skip" | "take"> = {
      where: this.buildWhere(await this.resolveQuery(options.query)),
      withDeleted: options.withDeleted,
      orderBy: this.defaultOrderBy,
    };

    const paged = await this.repository.getPaged(page, limit, query);

    return {
      data: await this.hydrate(this.mapper.toDTOList(paged.items)),
      total: paged.total,
      page: paged.page,
      limit: paged.limit,
      pages: paged.pages,
    };
  }

  async get(id: number): Promise<TDto | null> {
    const entity = await this.repository.getById(id as never);
    if (!entity) return null;

    const [dto] = await this.hydrate([this.mapper.toDTO(entity)]);
    return dto;
  }

  async create(dto: Partial<TDto>): Promise<TDto> {
    // The primary key is generated by the database: the mapper treats it as
    // read-only, so it never arrives from the request body.
    const created = await this.repository.insert(this.mapper.toEntity(dto));
    // The contract says `insert` returns the persisted entity, but a driver
    // that returns nothing would otherwise surface as a crash inside the mapper
    // or as a 201 with an empty body. Failing here names the real problem.
    if (!created) throw new AppError("The record could not be created", 500);

    // Hydrated on the way out of a write as well as a read. A resource that
    // carries its relation when it was fetched and not when it was just created
    // is two shapes under one name, and the client that forgot which verb it
    // used renders a blank.
    const [hydrated] = await this.hydrate([this.mapper.toDTO(created)]);
    return hydrated;
  }

  async update(id: number, dto: Partial<TDto>): Promise<TDto | null> {
    // Partial on purpose: the mapper skips the keys that did not arrive, so an
    // incomplete PUT does not wipe what nobody asked to change.
    const updated = await this.repository.update(id as never, this.mapper.toPartialEntity(dto));
    if (!updated) return null;

    const [hydrated] = await this.hydrate([this.mapper.toDTO(updated)]);
    return hydrated;
  }

  softDelete(id: number): Promise<boolean> {
    return this.repository.softDelete(id as never);
  }
}
