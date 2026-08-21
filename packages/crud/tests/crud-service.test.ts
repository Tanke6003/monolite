import type { IGenericRepository, QueryOptions } from "monolite-data";
import { AppError } from "monolite-core";
import {
  createMapper,
  CrudService,
  hydrated,
  include,
  type EntityMapper,
} from "monolite-crud";

interface Item {
  pkItem: number;
  name: string;
}

interface ItemDTO {
  id: number;
  name: string;
}

const mapper: EntityMapper<Item, ItemDTO> = {
  toDTO: (entity) => ({ id: entity.pkItem, name: entity.name }),
  toDTOList: (entities) => entities.map((entity) => ({ id: entity.pkItem, name: entity.name })),
  toEntity: (dto) => ({ name: dto.name }),
  toPartialEntity: (dto) => (dto.name === undefined ? {} : { name: dto.name }),
};

class ItemsService extends CrudService<Item, ItemDTO> {
  constructor(repository: IGenericRepository<Item>) {
    super(repository, mapper, { field: "pkItem", direction: "asc" });
  }
}

type Repository = jest.Mocked<
  Pick<IGenericRepository<Item>, "getPaged" | "getById" | "insert" | "update" | "softDelete">
>;

describe("CrudService", () => {
  let repository: Repository;
  let service: ItemsService;

  beforeEach(() => {
    repository = {
      getPaged: jest.fn(),
      getById: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    } as unknown as Repository;

    service = new ItemsService(repository as unknown as IGenericRepository<Item>);
  });

  describe("list", () => {
    it("maps the page to DTOs and keeps the totals", async () => {
      repository.getPaged.mockResolvedValue({
        items: [{ pkItem: 1, name: "one" }],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      });

      // The repository calls the rows `items` because it knows nothing about
      // HTTP; the response body has called them `data` since the first
      // endpoint. Translating in exactly one place is what stops the wire
      // format from drifting when the data layer renames a field.
      await expect(service.list(1, 10)).resolves.toEqual({
        data: [{ id: 1, name: "one" }],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
      });
    });

    it("applies the module's default ordering", async () => {
      repository.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });

      await service.list(2, 5, { withDeleted: true });

      expect(repository.getPaged).toHaveBeenCalledWith(2, 5, {
        where: undefined,
        withDeleted: true,
        orderBy: { field: "pkItem", direction: "asc" },
      });
    });

    it("filters nothing by default: a flat CRUD is paged and that is that", async () => {
      repository.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });

      await service.list(1, 10, { query: { search: "anything" } });

      expect(repository.getPaged).toHaveBeenCalledWith(1, 10, expect.objectContaining({ where: undefined }));
    });

    /**
     * The seam a module that offers search overrides — and only this one, so it
     * keeps the pagination, the mapping and the ordering for free.
     */
    it("lets a module supply its own filter through buildWhere", async () => {
      class SearchableService extends CrudService<Item, ItemDTO> {
        constructor(repo: IGenericRepository<Item>) {
          super(repo, mapper);
        }

        protected override buildWhere(query: unknown): QueryOptions<Item>["where"] {
          const { search } = (query ?? {}) as { search?: string };
          return search ? { name: { contains: search } } : undefined;
        }
      }

      repository.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });

      await new SearchableService(repository as unknown as IGenericRepository<Item>).list(1, 10, {
        query: { search: "an" },
      });

      expect(repository.getPaged).toHaveBeenCalledWith(1, 10, {
        where: { name: { contains: "an" } },
        withDeleted: undefined,
        orderBy: undefined,
      });
    });

    /**
     * The two-step filter, and the reason `resolveQuery` exists: a module that
     * has to read somewhere else before it can build its `where` keeps every
     * other behaviour of the listing instead of reimplementing `list`.
     */
    it("lets a module complete the query asynchronously before buildWhere sees it", async () => {
      const lookup = jest.fn().mockResolvedValue([7, 9]);

      class TwoStepService extends CrudService<Item, ItemDTO> {
        constructor(repo: IGenericRepository<Item>) {
          super(repo, mapper, { field: "pkItem", direction: "asc" });
        }

        protected override async resolveQuery(query: unknown): Promise<unknown> {
          const { owner } = (query ?? {}) as { owner?: string };
          return owner ? { ...(query as object), keys: await lookup(owner) } : query;
        }

        protected override buildWhere(query: unknown): QueryOptions<Item>["where"] {
          const { keys } = (query ?? {}) as { keys?: number[] };
          return keys ? { pkItem: { in: keys } } : undefined;
        }
      }

      repository.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });

      await new TwoStepService(repository as unknown as IGenericRepository<Item>).list(2, 25, {
        query: { owner: "ana" },
        withDeleted: true,
      });

      expect(lookup).toHaveBeenCalledWith("ana");
      // Paging, ordering and `withDeleted` all survive: that is what a module
      // used to lose the moment it overrode `list` to make room for a lookup.
      expect(repository.getPaged).toHaveBeenCalledWith(2, 25, {
        where: { pkItem: { in: [7, 9] } },
        withDeleted: true,
        orderBy: { field: "pkItem", direction: "asc" },
      });
    });

    /**
     * The cost of the hook for everybody who does not use it, which has to be
     * nothing: no extra query, and the query object arriving at `buildWhere`
     * exactly as the route left it.
     */
    it("hands buildWhere the untouched query when nobody overrides resolveQuery", async () => {
      const seen: unknown[] = [];

      class PlainService extends CrudService<Item, ItemDTO> {
        constructor(repo: IGenericRepository<Item>) {
          super(repo, mapper);
        }

        protected override buildWhere(query: unknown): QueryOptions<Item>["where"] {
          seen.push(query);
          return undefined;
        }
      }

      repository.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });

      const query = { page: 1, limit: 10 };
      await new PlainService(repository as unknown as IGenericRepository<Item>).list(1, 10, {
        query,
      });

      expect(seen).toEqual([query]);
      expect(seen[0]).toBe(query);
    });
  });

  describe("get", () => {
    it("gives back the DTO, or null when there is no row", async () => {
      repository.getById.mockResolvedValueOnce({ pkItem: 3, name: "three" });
      await expect(service.get(3)).resolves.toEqual({ id: 3, name: "three" });

      repository.getById.mockResolvedValueOnce(null);
      await expect(service.get(9)).resolves.toBeNull();
    });
  });

  describe("create", () => {
    it("returns the resource with its primary key already on it", async () => {
      repository.insert.mockResolvedValue({ pkItem: 7, name: "new" });

      await expect(service.create({ name: "new" })).resolves.toEqual({ id: 7, name: "new" });
      // The key does not travel towards the entity: the database generates it,
      // so the mapper treats it as read-only and it never arrives from a body.
      expect(repository.insert).toHaveBeenCalledWith({ name: "new" });
    });

    it("names the problem when the driver returns nothing", async () => {
      // The contract says `insert` gives back the persisted entity. A driver
      // that returns nothing would otherwise crash inside the mapper, or answer
      // 201 with an empty body.
      repository.insert.mockResolvedValue(undefined as unknown as Item);

      await expect(service.create({ name: "new" })).rejects.toThrow(AppError);
      await expect(service.create({ name: "new" })).rejects.toThrow(
        "The record could not be created"
      );
    });
  });

  describe("update", () => {
    it("sends only the keys that were present", async () => {
      repository.update.mockResolvedValue({ pkItem: 1, name: "other" });

      await service.update(1, { name: "other" });
      expect(repository.update).toHaveBeenCalledWith(1, { name: "other" });

      // An incomplete PUT must not wipe what nobody asked to change.
      await service.update(1, {});
      expect(repository.update).toHaveBeenLastCalledWith(1, {});
    });

    it("returns null when the row does not exist", async () => {
      repository.update.mockResolvedValue(null);

      await expect(service.update(99, { name: "x" })).resolves.toBeNull();
    });
  });

  it("softDelete defers to the repository and reports whether a row was touched", async () => {
    repository.softDelete.mockResolvedValue(false);

    await expect(service.softDelete(1)).resolves.toBe(false);
    expect(repository.softDelete).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------

interface Author {
  pkAuthor: number;
  name: string;
}

interface BookRow {
  pkBook: number;
  title: string;
  authorId: number | null;
}

interface BookDTO {
  id: number;
  title: string;
  authorId: number | null;
  author: string | null;
}

const bookMapper = createMapper<BookRow, BookDTO>({
  id: { field: "pkBook", readOnly: true },
  title: "title",
  authorId: "authorId",
  // Filled by the include below, never by the mapper and never written back.
  author: hydrated(),
});

/**
 * The relation, declared once.
 *
 * Before this it was four calls to `loadRelated` — one in each verb that hands a
 * DTO out — and the mistake it replaces is forgetting two of them, which
 * produces a resource that carries its author when it was read and not when it
 * was written.
 */
describe("CrudService with a declared include", () => {
  let books: jest.Mocked<Pick<IGenericRepository<BookRow>, "getPaged" | "getById" | "insert" | "update">>;
  let authors: jest.Mocked<Pick<IGenericRepository<Author>, "find">>;
  let service: CrudService<BookRow, BookDTO>;

  const ROW: BookRow = { pkBook: 1, title: "A Wizard of Earthsea", authorId: 7 };

  class BooksService extends CrudService<BookRow, BookDTO> {
    constructor(store: IGenericRepository<BookRow>, related: IGenericRepository<Author>) {
      super(store, bookMapper, {
        orderBy: { field: "title", direction: "asc" },
        includes: [
          include<BookDTO, Author>({
            key: "authorId",
            relatedKey: "pkAuthor",
            repository: related,
            into: "author",
            pick: (author) => author.name,
          }),
        ],
      });
    }
  }

  beforeEach(() => {
    books = {
      getPaged: jest.fn(),
      getById: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    } as unknown as typeof books;

    authors = { find: jest.fn().mockResolvedValue([{ pkAuthor: 7, name: "Ursula K. Le Guin" }]) } as unknown as typeof authors;

    service = new BooksService(
      books as unknown as IGenericRepository<BookRow>,
      authors as unknown as IGenericRepository<Author>
    );
  });

  /**
   * The regression, and the reason the whole thing exists. One assertion per
   * verb, because the bug it replaces was two verbs out of four.
   */
  it("resolves the relation on all four verbs", async () => {
    books.getPaged.mockResolvedValue({ items: [ROW], total: 1, page: 1, limit: 10, pages: 1 });
    books.getById.mockResolvedValue(ROW);
    books.insert.mockResolvedValue(ROW);
    books.update.mockResolvedValue(ROW);

    const listed = await service.list(1, 10);
    expect(listed.data[0].author).toBe("Ursula K. Le Guin");

    expect((await service.get(1))?.author).toBe("Ursula K. Le Guin");
    expect((await service.create({ title: "x" })).author).toBe("Ursula K. Le Guin");
    expect((await service.update(1, { title: "x" }))?.author).toBe("Ursula K. Le Guin");
  });

  it("asks the related repository once for a whole page, not once per row", async () => {
    books.getPaged.mockResolvedValue({
      items: [
        { pkBook: 1, title: "one", authorId: 7 },
        { pkBook: 2, title: "two", authorId: 7 },
        { pkBook: 3, title: "three", authorId: 9 },
      ],
      total: 3,
      page: 1,
      limit: 10,
      pages: 1,
    });
    authors.find.mockResolvedValue([
      { pkAuthor: 7, name: "Ursula K. Le Guin" },
      { pkAuthor: 9, name: "Italo Calvino" },
    ]);

    const page = await service.list(1, 10);

    expect(authors.find).toHaveBeenCalledTimes(1);
    // The distinct keys, in one `IN (...)` — three rows, two authors.
    expect(authors.find).toHaveBeenCalledWith({
      where: { pkAuthor: { in: [7, 9] } },
      // A book has to keep showing its author after that author is withdrawn:
      // hiding the name would turn a historical row into an unreadable one.
      withDeleted: true,
    });
    expect(page.data.map((book) => book.author)).toEqual([
      "Ursula K. Le Guin",
      "Ursula K. Le Guin",
      "Italo Calvino",
    ]);
  });

  it("answers null for a row that points nowhere, and asks nothing", async () => {
    books.getById.mockResolvedValue({ pkBook: 4, title: "Beowulf", authorId: null });

    const book = await service.get(4);

    expect(book).toMatchObject({ authorId: null, author: null });
    // Present and null, not absent: unknown and empty have to look different.
    expect(Object.keys(book as object)).toContain("author");
    expect(authors.find).not.toHaveBeenCalled();
  });

  it("answers null when the key points at a row that is not there", async () => {
    books.getById.mockResolvedValue({ pkBook: 5, title: "Orphan", authorId: 404 });
    authors.find.mockResolvedValue([]);

    expect((await service.get(5))?.author).toBeNull();
  });

  /**
   * The other half of the design: declaring the field and forgetting the include
   * has to be impossible to ship, not merely discouraged.
   */
  it("refuses to be constructed when a hydrated field has nothing to fill it", () => {
    class Forgetful extends CrudService<BookRow, BookDTO> {
      constructor(store: IGenericRepository<BookRow>) {
        super(store, bookMapper, { orderBy: { field: "title", direction: "asc" } });
      }
    }

    expect(() => new Forgetful(books as unknown as IGenericRepository<BookRow>)).toThrow(
      /Forgetful.*author.*hydrated/s
    );
  });

  /**
   * The third argument was the ordering for a long time and a great deal of
   * code passes it that way, so both shapes have to work. A module with no
   * relation is unaffected by any of this.
   */
  it("still takes a bare order-by as its third argument", async () => {
    const plainMapper = createMapper<BookRow, Omit<BookDTO, "author">>({
      id: { field: "pkBook", readOnly: true },
      title: "title",
      authorId: "authorId",
    });

    class Plain extends CrudService<BookRow, Omit<BookDTO, "author">> {
      constructor(store: IGenericRepository<BookRow>) {
        super(store, plainMapper, { field: "title", direction: "desc" });
      }
    }

    books.getPaged.mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 });
    await new Plain(books as unknown as IGenericRepository<BookRow>).list(1, 10);

    expect(books.getPaged).toHaveBeenCalledWith(1, 10, {
      where: undefined,
      withDeleted: undefined,
      orderBy: { field: "title", direction: "desc" },
    });
  });
});
