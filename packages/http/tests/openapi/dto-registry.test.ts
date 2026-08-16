/**
 * A DTO is described once, with Zod, and both the TypeScript type and the
 * OpenAPI component come out of that description.
 *
 * What is being checked here is that the second one really is derived and not
 * merely written next to the first: an interface plus a hand-written schema
 * block agree only for as long as somebody keeps them agreeing, and nothing
 * fails when they stop.
 */
import { z } from "zod";
import { buildDtoComponents, defineDto, definePagedDto } from "@monolite/http";

const userDto = defineDto(
  "User",
  z.object({
    id: z.int(),
    name: z.string(),
    email: z.string().nullable(),
  })
);

const pagedUserDto = definePagedDto("PaginatedUser", userDto);

/** Registered but never referenced by another DTO. */
defineDto("Standalone", z.object({ flag: z.boolean() }));

 
const components = (): Record<string, any> => buildDtoComponents();

describe("defineDto", () => {
  it("returns the very schema it was given, so it can be declared inline", () => {
    // `export const userDto = defineDto("User", z.object({...}))` has to keep
    // working as a schema; if it returned a copy, `z.infer` would drift from
    // what was published.
    const schema = z.object({ x: z.string() });

    expect(defineDto("Inline", schema)).toBe(schema);
  });

  it("publishes the schema as a component under the name it was given", () => {
    expect(components().User).toMatchObject({
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        email: expect.anything(),
      },
      required: ["id", "name", "email"],
    });
  });

  it("emits everything that was registered, and nothing that was not", () => {
    const names = Object.keys(components());

    expect(names).toEqual(expect.arrayContaining(["User", "PaginatedUser", "Standalone"]));
    expect(names).not.toContain("NeverRegistered");
  });

  /**
   * `$schema` and `$id` are correct in a standalone JSON Schema document and
   * pure noise inside `components`, and the bounds Zod puts on an integer are
   * JavaScript's safe-integer limits — sixteen-digit numbers that tell a reader
   * of the documentation nothing at all.
   */
  it("strips the JSON Schema noise OpenAPI does not need", () => {
    const user = components().User;

    expect(user.$schema).toBeUndefined();
    expect(user.$id).toBeUndefined();
    expect(user.properties.id.maximum).toBeUndefined();
    expect(user.properties.id.minimum).toBeUndefined();
  });

  it("keeps a bound that was actually asked for", () => {
    defineDto("Bounded", z.object({ age: z.int().min(0).max(130) }));

    expect(components().Bounded.properties.age).toMatchObject({ minimum: 0, maximum: 130 });
  });

  it("keeps the descriptions, which are what the documentation reads", () => {
    defineDto("Described", z.object({ total: z.int().meta({ description: "How many" }) }));

    expect(components().Described.properties.total.description).toBe("How many");
  });
});

describe("definePagedDto", () => {
  it("references the item schema instead of inlining a copy of it", () => {
    // Inlining would work and would be unreadable: every paged endpoint would
    // repeat the whole item, and a change to the item would show up in the
    // document as a diff in a dozen places.
    expect(components().PaginatedUser.properties.data).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/User" },
    });
  });

  it("wraps the item in the house's page shape", () => {
    expect(components().PaginatedUser).toMatchObject({
      type: "object",
      required: ["data", "total", "page", "limit", "pages"],
    });
  });

  it("registers the page under its own name and returns it as a schema", () => {
    // The returned schema is what a controller types its response with, so it
    // has to be usable and not only registered.
    expect(pagedUserDto.parse({ data: [], total: 0, page: 1, limit: 10, pages: 0 })).toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 10,
      pages: 0,
    });
  });

  it("documents what the total counts", () => {
    expect(components().PaginatedUser.properties.total.description).toBe(
      "Total number of records matching the filter"
    );
  });
});
