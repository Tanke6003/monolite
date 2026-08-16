/**
 * The equivalent of EF Core's `Include()`: an N:1 relation resolved in the
 * application layer, where it is decided what has to be brought along, rather
 * than in a repository that knows a single table.
 *
 * The property being defended is that the load is *batched* — one
 * `WHERE key IN (...)` per relation instead of one query per row, which is the
 * N+1 that turns a page of twenty into twenty-one round trips.
 */
import type { IGenericRepository } from "@monolite/data";
import { loadRelated } from "@monolite/crud";

interface Parent {
  id: number;
  fkChild: number | null;
}

interface Child {
  pk: number;
  name: string;
}

describe("loadRelated", () => {
  let repository: { find: jest.Mock };

  beforeEach(() => {
    repository = {
      find: jest.fn().mockResolvedValue([
        { pk: 1, name: "one" },
        { pk: 2, name: "two" },
      ]),
    };
  });

  const spec = () => ({
    foreignKey: "fkChild" as const,
    relatedKey: "pk" as const,
    repository: repository as unknown as IGenericRepository<Child>,
  });

  it("resolves the batch with a single IN (...) query", async () => {
    const parents: Parent[] = [
      { id: 1, fkChild: 1 },
      { id: 2, fkChild: 2 },
      { id: 3, fkChild: 1 },
    ];

    const index = await loadRelated<Parent, Child>(parents, spec());

    // One query for three parents, and the repeated key asked for once.
    expect(repository.find).toHaveBeenCalledTimes(1);
    expect(repository.find).toHaveBeenCalledWith({
      where: { pk: { in: [1, 2] } },
      withDeleted: true,
    });
    expect(index.get(1)).toMatchObject({ name: "one" });
    expect(index.get(2)).toMatchObject({ name: "two" });
  });

  it("ignores the null keys of an optional relation", async () => {
    await loadRelated<Parent, Child>(
      [
        { id: 1, fkChild: null },
        { id: 2, fkChild: 2 },
      ],
      spec()
    );

    expect(repository.find).toHaveBeenCalledWith({
      where: { pk: { in: [2] } },
      withDeleted: true,
    });
  });

  it("queries nothing when there are no keys to resolve", async () => {
    const index = await loadRelated<Parent, Child>([{ id: 1, fkChild: null }], spec());

    expect(repository.find).not.toHaveBeenCalled();
    expect(index.size).toBe(0);
  });

  it("queries nothing for an empty list of parents either", async () => {
    expect((await loadRelated<Parent, Child>([], spec())).size).toBe(0);
    expect(repository.find).not.toHaveBeenCalled();
  });

  /**
   * Soft-deleted relations are included by default: a row has to keep showing
   * the name of what it points at even after that parent has been taken down,
   * or a historical record turns into an unreadable one.
   */
  it("includes soft-deleted relations by default", async () => {
    await loadRelated<Parent, Child>([{ id: 1, fkChild: 1 }], spec());

    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({ withDeleted: true })
    );
  });

  it("allows excluding them when a module means to", async () => {
    await loadRelated<Parent, Child>([{ id: 1, fkChild: 1 }], {
      ...spec(),
      withDeleted: false,
    });

    expect(repository.find).toHaveBeenCalledWith({
      where: { pk: { in: [1] } },
      withDeleted: false,
    });
  });

  it("leaves out of the index whatever the query did not return", async () => {
    // A dangling foreign key is not an error here: the caller sees a miss and
    // decides what to do with it.
    repository.find.mockResolvedValue([]);

    const index = await loadRelated<Parent, Child>([{ id: 1, fkChild: 9 }], spec());

    expect(index.get(9)).toBeUndefined();
    expect(index.size).toBe(0);
  });

  it("indexes by the related key, which is what the caller looks rows up with", async () => {
    const index = await loadRelated<Parent, Child>([{ id: 1, fkChild: 2 }], spec());

    expect([...index.keys()].sort()).toEqual([1, 2]);
  });
});
