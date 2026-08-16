import { QueryBuilder } from "monolite-data";
import { ITestItem } from "../support/test-entity";

describe("QueryBuilder", () => {
  let repository: any;
  let query: QueryBuilder<ITestItem>;

  beforeEach(() => {
    repository = {
      find: jest.fn().mockResolvedValue([]),
      firstOrDefault: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      getPaged: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 10, pages: 0 }),
    };
    query = new QueryBuilder<ITestItem>(repository);
  });

  it("is immutable: every operator returns a new query", () => {
    const filtered = query.where({ qty: 1 });

    expect(filtered).not.toBe(query);
    expect(query.toOptions()).toEqual({});
    expect(filtered.toOptions().where).toEqual({ qty: 1 });
  });

  it("several `where` calls are combined with AND", () => {
    const options = query.where({ qty: 1 }).where({ name: "a" }).toOptions();

    expect(options.where).toEqual({ $and: [{ qty: 1 }, { name: "a" }] });
  });

  it("accumulates the sort criteria in the order they were asked for", () => {
    const options = query.orderBy("qty").orderByDescending("name").toOptions();

    expect(options.orderBy).toEqual([
      { field: "qty", direction: "asc" },
      { field: "name", direction: "desc" },
    ]);
  });

  it("select, skip, take and withDeleted end up in the options", () => {
    const options = query.select("name", "qty").skip(5).take(2).withDeleted().toOptions();

    expect(options).toMatchObject({
      select: ["name", "qty"],
      skip: 5,
      take: 2,
      withDeleted: true,
    });
  });

  it("toList delegates to find with the accumulated options", async () => {
    await query.where({ qty: 1 }).take(3).toList();

    expect(repository.find).toHaveBeenCalledWith({ where: { qty: 1 }, take: 3 });
  });

  it("firstOrDefault delegates to the repository", async () => {
    await query.where({ qty: 1 }).firstOrDefault();

    expect(repository.firstOrDefault).toHaveBeenCalledWith({ where: { qty: 1 } });
  });

  it("count passes the filter and withDeleted", async () => {
    await query.where({ qty: 1 }).withDeleted().count();

    expect(repository.count).toHaveBeenCalledWith({ qty: 1 }, true);
  });

  it("any is true as soon as there is one row", async () => {
    repository.count.mockResolvedValue(0);
    expect(await query.any()).toBe(false);

    repository.count.mockResolvedValue(2);
    expect(await query.any()).toBe(true);
  });

  it("toPagedList ignores any previous skip/take because pagination sets them", async () => {
    await query.where({ qty: 1 }).skip(99).take(99).orderBy("name").toPagedList(2, 5);

    expect(repository.getPaged).toHaveBeenCalledWith(2, 5, {
      where: { qty: 1 },
      orderBy: [{ field: "name", direction: "asc" }],
      select: undefined,
      withDeleted: undefined,
    });
  });

  it("toOptions returns a copy", () => {
    const built = query.where({ qty: 1 });
    const options = built.toOptions();
    options.take = 100;

    expect(built.toOptions().take).toBeUndefined();
  });
});
