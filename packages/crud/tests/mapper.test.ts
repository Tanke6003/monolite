/**
 * Declarative entity <-> DTO mapping.
 *
 * What it replaces is the `toDTO` / `toEntity` / `toPartialEntity` trio every
 * service used to write by hand, and the one of the three that is worth the
 * most is the last: telling "the field did not arrive" apart from "the field
 * arrived as null" is exactly the detail one gets wrong by hand, and getting it
 * wrong wipes columns nobody asked to change.
 */
import { createMapper } from "@monolite/crud";

interface IThing {
  pkThing: number;
  label: string;
  note?: string | null;
  when?: Date | null;
  active?: boolean;
}

interface ThingDTO {
  id: number;
  label: string;
  note: string | null;
  when: string | null;
  shout: string;
}

const thingMapper = createMapper<IThing, ThingDTO>({
  id: { field: "pkThing", readOnly: true },
  label: "label",
  note: { field: "note", to: (value) => (value ?? null) as string | null },
  when: {
    field: "when",
    to: (value) => (value ? new Date(value as Date).toISOString() : null),
    from: (value) => (value ? new Date(value) : null),
  },
  shout: { computed: (thing) => thing.label.toUpperCase() },
});

const thing: IThing = {
  pkThing: 1,
  label: "hello",
  note: null,
  when: new Date("2026-05-01T10:00:00.000Z"),
  active: true,
};

describe("toDTO", () => {
  it("renames, converts and computes", () => {
    expect(thingMapper.toDTO(thing)).toEqual({
      id: 1,
      label: "hello",
      note: null,
      when: "2026-05-01T10:00:00.000Z",
      shout: "HELLO",
    });
  });

  it("does not drag along entity properties the profile never mentioned", () => {
    // The DTO is the contract; a column added to the table does not become part
    // of it by accident.
    expect(thingMapper.toDTO(thing)).not.toHaveProperty("active");
  });

  it("hands the whole entity to a computed field", () => {
    expect(thingMapper.toDTO({ ...thing, label: "abc" }).shout).toBe("ABC");
  });

  it("maps the whole collection with toDTOList", () => {
    expect(thingMapper.toDTOList([thing, { ...thing, pkThing: 2 }]).map((dto) => dto.id)).toEqual([
      1, 2,
    ]);
  });
});

describe("toEntity", () => {
  it("inverts the mapping and applies the conversions back", () => {
    expect(
      thingMapper.toEntity({
        id: 99,
        label: "goodbye",
        note: "something",
        when: "2026-05-01T10:00:00.000Z",
        shout: "IGNORED",
      })
    ).toEqual({
      label: "goodbye",
      note: "something",
      when: new Date("2026-05-01T10:00:00.000Z"),
    });
  });

  // The primary key and the computed fields must never arrive from a request
  // body: one is the database's to generate, the other is not stored at all.
  it("leaves out the read-only fields and the computed ones", () => {
    const entity = thingMapper.toEntity({
      id: 99,
      label: "x",
      note: null,
      when: null,
      shout: "NO",
    });

    expect(entity).not.toHaveProperty("pkThing");
    expect(entity).not.toHaveProperty("shout");
  });

  it("writes an absent key as undefined, because a create means the whole DTO", () => {
    expect(thingMapper.toEntity({ label: "only this" } as ThingDTO)).toMatchObject({
      label: "only this",
      note: undefined,
    });
  });
});

describe("toPartialEntity", () => {
  it("writes only the keys that were present", () => {
    expect(thingMapper.toPartialEntity({ label: "new" })).toEqual({ label: "new" });
  });

  // The difference that gets lost when this is written by hand: not sending a
  // field is not the same as sending it empty. `null` *is* a value, and it has
  // to reach the entity so a column can be cleared on purpose.
  it("tells 'did not arrive' from 'arrived as null'", () => {
    expect(thingMapper.toPartialEntity({ note: null })).toEqual({ note: null });
    expect(thingMapper.toPartialEntity({})).toEqual({});
  });

  it("still refuses the read-only and the computed fields", () => {
    expect(thingMapper.toPartialEntity({ id: 5, shout: "NO", label: "yes" })).toEqual({
      label: "yes",
    });
  });

  it("applies the conversion back on the keys it does write", () => {
    expect(thingMapper.toPartialEntity({ when: "2026-05-01T10:00:00.000Z" })).toEqual({
      when: new Date("2026-05-01T10:00:00.000Z"),
    });
  });
});

describe("the profile", () => {
  it("is exposed as it was handed in", () => {
    expect(Object.keys(thingMapper.profile)).toEqual(["id", "label", "note", "when", "shout"]);
  });

  it("supports the shorthand of a plain field name", () => {
    const plain = createMapper<{ a: number; b: number }, { a: number }>({ a: "a" });

    expect(plain.toDTO({ a: 1, b: 2 })).toEqual({ a: 1 });
    expect(plain.toEntity({ a: 1 })).toEqual({ a: 1 });
  });
});
