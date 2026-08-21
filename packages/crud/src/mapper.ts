/**
 * Declarative entity <-> DTO mapping, along the lines of AutoMapper's profiles.
 *
 * It replaces the `toDTO` / `toModel` / `toPartialModel` that every service used
 * to repeat by hand. You declare once which DTO property comes from which
 * entity property and, from that, you get all four directions:
 *
 *   toDTO            entity   -> DTO
 *   toDTOList        entities -> DTOs
 *   toEntity         DTO      -> full entity
 *   toPartialEntity  partial DTO -> only the keys present (for a PUT/PATCH)
 *
 * `toPartialEntity` is the one that saves the most code: telling "it did not
 * arrive" apart from "it arrived as null" is precisely the detail one forgets
 * when writing this by hand, and it ends up wiping fields nobody asked to
 * change.
 */

/** A DTO field that is computed and therefore never travels back to the entity. */
export interface ComputedField<TEntity, TValue> {
  computed: (entity: TEntity) => TValue;
}

/** A DTO field with a different name on the entity and/or a type conversion. */
export interface MappedField<TEntity, TValue> {
  field: Extract<keyof TEntity, string>;
  /** Conversion entity -> DTO. By default, the value as it is. */
  to?: (value: unknown, entity: TEntity) => TValue;
  /** Conversion DTO -> entity. By default, the value as it is. */
  from?: (value: TValue) => unknown;
  /** `true` for fields that are only read (never written back). */
  readOnly?: boolean;
}

export type FieldMapping<TEntity, TValue> =
  | Extract<keyof TEntity, string>
  | MappedField<TEntity, TValue>
  | ComputedField<TEntity, TValue>;

/** One mapping per property of the DTO. */
export type MappingProfile<TEntity, TDto> = {
  [K in keyof TDto]-?: FieldMapping<TEntity, TDto[K]>;
};

export interface Mapper<TEntity, TDto> {
  toDTO(entity: TEntity): TDto;
  toDTOList(entities: TEntity[]): TDto[];
  /** Full DTO -> entity. Useful when creating. */
  toEntity(dto: TDto): Partial<TEntity>;
  /** Partial DTO -> entity, skipping absent keys. Useful when updating. */
  toPartialEntity(dto: Partial<TDto>): Partial<TEntity>;
  readonly profile: MappingProfile<TEntity, TDto>;
}

function isComputed<TEntity, TValue>(
  mapping: FieldMapping<TEntity, TValue>
): mapping is ComputedField<TEntity, TValue> {
  return typeof mapping === "object" && "computed" in mapping;
}

function isMapped<TEntity, TValue>(
  mapping: FieldMapping<TEntity, TValue>
): mapping is MappedField<TEntity, TValue> {
  return typeof mapping === "object" && "field" in mapping;
}

/**
 * Builds a mapper from its profile.
 *
 * @example
 * const branchMapper = createMapper<IBranch, BranchDTO>({
 *   id: "pkBranch",
 *   name: "name",
 *   address: "address",
 *   available: { field: "available", readOnly: true },
 * });
 */
export function createMapper<TEntity extends object, TDto extends object>(
  profile: MappingProfile<TEntity, TDto>
): Mapper<TEntity, TDto> {
  const entries = Object.entries(profile) as [
    Extract<keyof TDto, string>,
    FieldMapping<TEntity, unknown>,
  ][];

  // Only the fields that travel back to the entity: the computed ones and the
  // read-only ones stay out of both writing directions.
  const writable = entries.filter(
    ([, mapping]) => !isComputed(mapping) && !(isMapped(mapping) && mapping.readOnly)
  );

  const toDTO = (entity: TEntity): TDto => {
    const dto: Record<string, unknown> = {};
    const source = entity as Record<string, unknown>;

    for (const [dtoKey, mapping] of entries) {
      if (isComputed(mapping)) {
        dto[dtoKey] = mapping.computed(entity);
        continue;
      }

      if (isMapped(mapping)) {
        const value = source[mapping.field];
        dto[dtoKey] = mapping.to
          ? (mapping.to as (v: unknown, e: TEntity) => unknown)(value, entity)
          : value;
        continue;
      }

      dto[dtoKey] = source[mapping];
    }

    return dto as TDto;
  };

  const writeEntity = (dto: Partial<TDto>, skipUndefined: boolean): Partial<TEntity> => {
    const entity: Record<string, unknown> = {};
    const source = dto as Record<string, unknown>;

    for (const [dtoKey, mapping] of writable) {
      const value = source[dtoKey];
      // `undefined` means "it did not arrive in the body"; `null` *is* a value
      // and has to reach the entity so that a column can be cleared.
      if (skipUndefined && value === undefined) continue;

      const property = isMapped(mapping) ? mapping.field : (mapping as string);
      entity[property] =
        isMapped(mapping) && mapping.from
          ? (mapping.from as (v: unknown) => unknown)(value)
          : value;
    }

    return entity as Partial<TEntity>;
  };

  return {
    profile,
    toDTO,
    toDTOList: (entities) => entities.map(toDTO),
    toEntity: (dto) => writeEntity(dto, false),
    toPartialEntity: (dto) => writeEntity(dto, true),
  };
}

// ------------------------------------------------------------  hydration  ---

/**
 * A DTO field that an include fills, not the mapper.
 *
 * It is a computed field —so it never travels back to the entity, whatever a
 * client sends— that also says *why* it is computed. Before this, the same
 * field was written `{ computed: () => null }`, which is indistinguishable from
 * a field that is genuinely always null, and nothing anywhere knew that
 * something else was supposed to fill it in.
 *
 * `CrudService` reads the marker and refuses to be constructed if a field
 * carrying it has no include behind it. That is the whole point: the mistake it
 * replaces was a resource that quietly answered `author: null` on two verbs out
 * of four.
 */
export interface HydratedField<TValue> {
  readonly hydrated: true;
  computed: (entity: unknown) => TValue;
}

/** Marks a DTO field as filled by an include. See `include()` in `monolite-crud`. */
export function hydrated<TValue = null>(): HydratedField<TValue> {
  return { hydrated: true, computed: () => null as TValue };
}

export function isHydratedField(mapping: unknown): mapping is HydratedField<unknown> {
  return typeof mapping === "object" && mapping !== null && "hydrated" in mapping;
}

/** The DTO fields a profile declares with `hydrated()`, by name. */
export function hydratedFields<TEntity, TDto>(
  profile: MappingProfile<TEntity, TDto>
): string[] {
  return Object.entries(profile)
    .filter(([, mapping]) => isHydratedField(mapping))
    .map(([name]) => name);
}
