# Acceso a datos

> 🇬🇧 [Read in English](../en/data-access.md) · paquete: `monolite-data`

Describe una tabla una vez y obtienes el CRUD clásico, un lenguaje de filtros
declarativo, consultas encadenables al estilo LINQ, paginación, borrado lógico y
transacciones — sin escribir SQL. Seis motores implementan ese único contrato, y
elegir entre ellos es configuración, no código.

---

## La forma que tiene

```
IGenericRepository<T>              ← lo que ven los servicios. Idéntico en todos los motores.
        │
        ├── SqlGenericRepository     ── SqlDialect ── oracle · mssql · postgres · mysql
        ├── MongoGenericRepository
        └── MemoryGenericRepository
                    │
            IDbPlugin                ← ciclo de vida de la conexión
            └── ISqlDbPlugin         ← + ejecutar sentencias y abrir transacciones
```

**La uniformidad vive arriba.** Los servicios ven `IGenericRepository<T>`, y ahí
todos los motores se comportan igual. El contrato del conector que hay debajo es
más fino a propósito: `IDbPlugin` cubre sólo `engine`, `authenticate` y `close`,
porque eso es todo lo que un almacén relacional y uno documental comparten de
verdad. Pretender unificar más sería pretender que a MongoDB se le puede mandar
SQL.

Los cuatro motores SQL comparten **un solo** `SqlGenericRepository`; todo lo que
difiere entre ellos está aislado en un `SqlDialect`. Cuatro subclases casi
idénticas serían duplicación, no abstracción.

Un módulo recibe ese repositorio a través de `BaseModuleRepository`, que delega
cada método genérico en el almacén configurado y añade el registro de errores, así
que no hace falta un `try/catch` por método:

```ts
export class BranchesRepository
  extends BaseModuleRepository<IBranch>
  implements IBranchesRepository
{
  constructor(store: IGenericRepository<IBranch>, logger: ILogger) {
    super(store, logger, "BranchesRepository");
  }
}
```

Los fallos se registran con el detalle del driver y se relanzan como
`BranchesRepository.<operation> failed.` con el error original en `cause` — así
`normalizeError` sigue pudiendo reconocer una violación de restricción única y
responder 409 en vez de un 500 a secas.

### La garantía de que los motores concuerdan

`monolite-data` exporta un **kit de contrato de repositorio**: el conjunto de
aserciones que toda implementación tiene que pasar, invocado por cada driver con su
propia factoría. Semántica del insert, operadores de filtro, ordenación,
paginación, proyecciones, borrado lógico idempotente, `hardDeleteWhere` alcanzando
las filas borradas lógicamente — se afirma una vez y se repite por driver. Eso es
lo que convierte "todos los motores se comportan igual" en algo comprobado y no
prometido.

---

## Describir una entidad

El modelo de dominio sigue siendo una interfaz a secas. El mapeo es el único sitio
donde aparece un nombre de columna:

```ts
export const BRANCHES_ENTITY = defineEntity<IBranch>({
  table: "BRANCHES",
  primaryKey: "pkBranch",
  identity: true,
  columns: {
    pkBranch:  { name: "PK_BRANCH", kind: "number", insertable: false, updatable: false },
    name:      { name: "NAME",      kind: "string" },
    address:   { name: "ADDRESS",   kind: "string" },
    available: { name: "AVAILABLE", kind: "boolean" },
    createdAt: { name: "CREATED_AT", kind: "date", updatable: false },
    updatedAt: { name: "UPDATED_AT", kind: "date" },
    createdBy: { name: "CREATED_BY", kind: "string", updatable: false },
    updatedBy: { name: "UPDATED_BY", kind: "string" },
  },
  softDelete: { property: "available", activeValue: 1, deletedValue: 0 },
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  audit: { createdBy: "createdBy", updatedBy: "updatedBy" },
  auditTrail: true,
});
```

`columns` tiene que cubrir todas las propiedades del modelo — TypeScript lo obliga.
Renombrar una columna física es un cambio de una línea.

| Campo | Significado |
| --- | --- |
| `identity` | `true` (por defecto): la base de datos genera la PK. `false`: quien llama tiene que darla, y un insert sin ella lanza. |
| `insertable` / `updatable` | `false` para las columnas que son de la base de datos (PKs identity, `CREATED_AT`). Por defecto `true`. |
| `kind` | Dirige la conversión en ambos sentidos: `boolean` ↔ `1/0`, `date` ↔ `Date`, `number`, `string`. Por defecto `string`. |
| `softDelete` | La columna que marca una fila como borrada lógicamente. Omítelo y la entidad simplemente no tiene borrado lógico. `activeValue`/`deletedValue` valen `1`/`0` por defecto. |
| `timestamps` | `createdAt` / `updatedAt`. Nunca se toman del cuerpo de la petición. |
| `audit` | `createdBy` / `updatedBy`, rellenados desde el contexto de la petición — la identidad del token, nunca el cuerpo, para que un cliente no pueda decir que es otro. Fuera de una petición el valor es `System`. |
| `auditTrail` | `true` para escribir una línea en el registro de cambios en cada escritura. Se activa por entidad: la propia tabla del registro no debe activarlo, y no toda entidad merece una fila extra por operación. |

La definición de una columna puede ser sólo su nombre (`name: "NAME"`) cuando todos
los valores por defecto le sirven.

En tiempo de ejecución los metadatos se envuelven en un `EntitySchema`, que
resuelve esos atajos, indexa las columnas sin distinguir mayúsculas (Oracle
devuelve los identificadores en mayúsculas y PostgreSQL en minúsculas — el mismo
mapeo resuelve los dos) y centraliza las conversiones. Su `columnOf()` **lanza
cuando una propiedad no está mapeada**, y esa es la barrera que impide que un
nombre arbitrario entre en una consulta generada.

---

## CRUD

```ts
getAll(options?: QueryOptions<T>): Promise<T[]>
getPaged(page, limit, options?): Promise<PagedResult<T>>       // { items, total, page, limit, pages }
getById(id, options?): Promise<T | null>
find(options: QueryOptions<T>): Promise<T[]>
firstOrDefault(options?): Promise<T | null>
count(where?, withDeleted?): Promise<number>
exists(where, withDeleted?): Promise<boolean>

insert(entity: Partial<T>): Promise<T>              // la entidad persistida, PK incluida
insertMany(entities: Partial<T>[]): Promise<number> // filas escritas
update(id, changes: Partial<T>): Promise<T | null>  // null si la fila no existe
updateWhere(where, changes): Promise<number>        // filas afectadas

softDelete(id): Promise<boolean>
restore(id): Promise<boolean>
hardDelete(id): Promise<boolean>
hardDeleteWhere(where): Promise<number>

query(): IQueryable<T>
```

`QueryOptions<T>` lleva `where`, `orderBy`, `skip`, `take`, `select` y
`withDeleted`.

Comportamientos que conviene conocer, idénticos en todos los motores y fijados por
la suite de contrato:

- **Las lecturas excluyen por defecto las filas borradas lógicamente.** Pasa
  `withDeleted: true` para incluirlas — el equivalente del `IgnoreQueryFilters()`
  de EF Core.
- **`insert` vuelve a leer la fila que escribió** y devuelve eso, así que quien
  llama recibe la PK generada y todos los valores por defecto que aplicó la base de
  datos. Un insert sin nada que escribir es un error, no una fila vacía.
- **Un `update` sin ningún cambio actualizable no es un error**: devuelve el estado
  actual. Devolver `null` se leería como "no existe". Una PK que llegue en el
  conjunto de cambios se ignora.
- **`updateWhere` no alcanza las filas borradas lógicamente**; `hardDeleteWhere` sí
  lo hace, y a propósito — saltarse las filas ya marcadas dejaría huérfanos
  apuntando por clave foránea a algo que acaba de desaparecer.
- **Las marcas de tiempo y las columnas de auditoría nunca se toman del payload.**
  En los motores SQL se escriben con la expresión propia del servidor, así que no
  dependen del reloj del proceso de Node.
- **`select` proyecta**: las columnas que no se piden están ausentes del resultado,
  no presentes como `undefined`.

---

## El lenguaje de filtros

Declarativo, no a base de cadenas. Todo valor viaja como bind con nombre y todo
nombre de columna se resuelve por el mapeo de la entidad, así que la entrada del
usuario nunca llega al texto de la sentencia.

```ts
await branches.find({ where: { name: "Downtown" } });

await appointments.find({
  where: {
    fkBranch: 1,
    durationMin: { gte: 30, lte: 90 },
    status: { notIn: ["CANCELLED", "DONE"] },
    guestName: { contains: "walk-in" },
    fkClient: { isNull: true },
    scheduledAt: { between: [from, to] },
  },
});

await branches.getPaged(page, limit, {
  where: { $or: [{ name: { contains: search } }, { address: { contains: search } }] },
});
```

| Operador | SQL | MongoDB | En memoria |
| --- | --- | --- | --- |
| `eq` `ne` `gt` `gte` `lt` `lte` | `=` `<>` `>` `>=` `<` `<=` | `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` | comparación sobre un valor normalizado |
| `like` / `notLike` | `LIKE` / `NOT LIKE` | `$regex` anclado / `$not` | `RegExp` anclado |
| `ilike` | `UPPER(col) LIKE UPPER(:bind)` | `$regex` con la bandera `i` | `RegExp` sin distinguir mayúsculas |
| `contains` | `UPPER(col) LIKE UPPER(:bind) ESCAPE '!'` | `$regex` escapado, bandera `i` | `String.includes`, en minúsculas |
| `in` / `notIn` | `IN (…)` / `NOT IN (…)` | `$in` / `$nin` | `some` / `every` |
| `between` | `BETWEEN … AND …` | `$gte` + `$lte` | ambos extremos |
| `isNull` | `IS NULL` / `IS NOT NULL` | `$eq: null` / `$ne: null` | `null` o ausente |
| `$and` `$or` `$not` | grupos anidados | `$and`, `$or`, `$nor` con un solo miembro | evaluación recursiva |

Detalles fáciles de equivocar, y por eso mismo fijados por la suite de contrato:

- Un `null` pelado (`{ tag: null }`) significa `IS NULL`. En MongoDB se convierte
  en `$eq: null`, que también casa con los documentos donde el campo no está — que
  es lo que un motor SQL entiende por "columna sin valor".
- Una **lista vacía** no es un error de sintaxis: `in: []` compila a `1 = 0` y
  `notIn: []` a `1 = 1` en SQL, y a `$in: []` en MongoDB. Los filtros dinámicos se
  topan con esto constantemente.
- Una **propiedad que no está mapeada lanza**, en vez de no casar con nada en
  silencio.
- **`contains` es el operador para la entrada del usuario.** `like` e `ilike`
  reciben un *patrón*, así que un `%` o un `_` escritos en un formulario se
  convierten en comodines: buscar `%` devuelve la tabla entera y `a_b` casa con
  `axb`. `contains` recibe texto literal, neutraliza los comodines y declara una
  cláusula `ESCAPE`; cada driver implementa ese significado de forma nativa, así
  que quien llama no tiene ningún patrón que equivocar. El carácter de escape es
  `!` y no la barra invertida, porque MySQL trata la barra invertida como escape
  dentro del propio literal de cadena y `ESCAPE '\'` llegaría como una comilla
  escapada.
- Los filtros sobre un mismo campo nunca chocan: el traductor de Mongo los reparte
  en varios documentos en vez de pisar una clave, y SQL los une con `AND`.

Tres traductores mantienen esa semántica alineada —`SqlWhereCompiler`,
`toMongoFilter` y `matchesFilter`— y cada uno resuelve los nombres de campo por
`EntitySchema` y los valores por `toColumnValue`, así que un booleano del modelo se
compara contra el `1/0` almacenado y una fecha viaja como `Date`.

---

## Consultas encadenables y paginación

`query()` devuelve un `IQueryable<T>` que imita a LINQ: perezoso, inmutable y que
sólo toca la base de datos en un operador terminal.

```ts
const page = await appointments
  .query()
  .where({ fkBranch: 1 })
  .where({ status: { notIn: ["CANCELLED", "DONE"] } })  // se acumula con AND
  .orderByDescending("scheduledAt")
  .toPagedList(1, 20);

const exists = await branches.query().where({ name: "Downtown" }).any();
```

Composición: `where`, `orderBy`, `orderByDescending`, `select`, `skip`, `take`,
`withDeleted`. Terminales: `toList`, `firstOrDefault`, `count`, `any`,
`toPagedList`. `toOptions()` devuelve las `QueryOptions` acumuladas, para depurar o
para reutilizarlas.

Cada llamada devuelve una consulta **nueva**, así que se puede ramificar una
consulta base sin que las ramas se contaminen entre sí. El constructor es una sola
clase compartida por todos los drivers — no sabe nada de SQL ni de documentos,
acumula opciones y delega la llamada terminal en el repositorio que lo creó.

`getPaged(page, limit)` acota los dos argumentos a 1 como mínimo y devuelve
`{ items, total, page, limit, pages }` — un conteo más una lectura con ventana.
Cuando una consulta paginada no trae `orderBy`, el repositorio recurre a ordenar
por la clave primaria: ni Oracle ni SQL Server garantizan el orden de un
`OFFSET`/`FETCH` sin `ORDER BY` (SQL Server directamente lo rechaza) y MongoDB no
garantiza el orden natural, así que sin ese respaldo dos páginas consecutivas
podrían repetir filas o saltárselas.

---

## Borrado lógico, restauración y borrado físico

```ts
await branches.softDelete(id);                       // true la primera vez
await branches.softDelete(id);                       // false — no hay nada que hacer
await branches.getById(id);                          // null
await branches.getById(id, { withDeleted: true });   // la fila, ahí sigue
await branches.restore(id);                          // true, y false si se repite
```

Las dos operaciones son **idempotentes por construcción**: la sentencia lleva una
condición sobre el estado anterior, así que borrar dos veces devuelve `false` la
segunda en vez de fingir que hizo algo. Las dos cuentan como modificación, así que
sellan `updatedAt` y `updatedBy` — un borrado lógico es un cambio y debería decir
quién lo hizo.

Llamar a `softDelete` o a `restore` sobre una entidad cuyos metadatos no declaran
`softDelete` lanza, con un mensaje que te dice que uses `hardDelete` o que añadas
los metadatos. No hacer nada en silencio sería peor.

---

## Transacciones (unidad de trabajo)

**No todo va envuelto en una transacción.** Una sola sentencia ya es atómica y
viaja con auto-commit; envolverla sólo añadiría un viaje de ida y vuelta.

Se abre una transacción en dos casos, y la frontera es el servicio, no el
repositorio:

1. **El caso de uso escribe en más de un sitio** y un resultado a medias sería
   inválido.
2. **Decide en función de lo que acaba de leer**, aunque luego escriba una sola
   fila. Comprobar que un horario está libre y ocuparlo son dos sentencias, y entre
   ellas cabe otra petición. Aquí la transacción no va de atomicidad sino de
   aislamiento, y viene acompañada de `lockRow`.

La forma explícita:

```ts
await unitOfWork.execute(async (scope) => {
  await scope.lockRow("BRANCHES", id);
  await scope.repository<IAppointment>("APPOINTMENTS").hardDeleteWhere({ fkBranch: id });
  await scope.repository<IBranch>("BRANCHES").hardDelete(id);
});
```

`scope.repository(...)` devuelve el mismo repositorio genérico atado a la
transacción, memoizado por entidad. Commit si sale bien, rollback si algo lanza, y
el error original se propaga intacto. El registro de cambios sigue ese mismo
ámbito: una operación revertida se lleva su línea de auditoría con ella.

La forma ambiental —`@Transactional()`, en [`monolite-crud`](crud.md)— publica la
transacción abierta en un `AsyncLocalStorage` para que los repositorios inyectados
se sumen sin que se les pase nada. El mismo compromiso que con el contexto de
petición: leyendo `repository.insert(...)` no puedes saber si corre dentro de una
transacción. Lo que *sí* se ve es la frontera.

Cómo lo implementa cada motor:

| Motor | Implementación |
| --- | --- |
| Oracle | Una conexión del pool con `autoCommit: false`, y commit o rollback alrededor del bloque. |
| SQL Server · PostgreSQL · MySQL | La transacción gestionada de Sequelize; el bloque recibe un executor atado a ella. |
| MongoDB | Una `ClientSession` que se pasa a todas las operaciones. `withTransaction` **reintenta** ante errores transitorios del servidor, así que el bloque puede ejecutarse más de una vez y no debe llevar efectos secundarios fuera de la base de datos. |
| En memoria | Toma una foto de cada almacén antes de ejecutar y las restaura si el bloque lanza. Las transacciones se encolan y corren de una en una: Node es de un solo hilo, pero eso no es aislamiento — entre el `await` de una lectura y la escritura que depende de ella el bucle de eventos atiende otras peticiones, y además dos fotos solapadas romperían el rollback, porque un fallo en la segunda restauraría por encima de lo que la primera ya había confirmado. |

### `lockRow(entity, id)`

Bloquea una fila hasta el commit. Las transacciones que pidan esa misma fila hacen
cola detrás.

Bloquear la fila **padre** —la sucursal de una cita, no la cita— serializa sólo a
quienes compiten de verdad, y deja que otras sucursales reserven en paralelo.

**Tiene que ser la primera sentencia de la transacción.** MySQL usa REPEATABLE READ
por defecto y fija la foto en la primera lectura consistente; si antes del bloqueo
corre un SELECT normal, las lecturas posteriores siguen viendo el estado antiguo
aunque el bloqueo ya se haya concedido. Una lectura con bloqueo no fija ninguna
foto, así que abrir con ella hace que las comprobaciones vean los últimos datos
confirmados en los cuatro motores.

| Motor | Sentencia |
| --- | --- |
| Oracle · PostgreSQL · MySQL | `SELECT pk FROM t WHERE pk = :pk FOR UPDATE` |
| SQL Server | `SELECT pk FROM t WITH (UPDLOCK, HOLDLOCK) WHERE pk = :pk` — T-SQL no tiene `FOR UPDATE`; `HOLDLOCK` es lo que lo mantiene hasta el commit |
| MongoDB | No existe la lectura con bloqueo. La garantía la da en su lugar un índice único, y el driver devuelve un error de clave duplicada que el mapeo convierte en un 409 |
| En memoria | Nada que bloquear: la transacción entera ya corre en exclusiva |

El bloqueo sólo alcanza a las peticiones de **un proceso**. Con más de una
instancia corriendo, la garantía tiene que estar en la base de datos — un índice
único parcial sobre las columnas que no deben chocar.

---

## Dónde se detiene la API genérica

### Las relaciones se componen en el servicio

Un repositorio conoce exactamente una tabla. Componer entre agregados es una
decisión de negocio, así que ocurre en la capa de servicio — el equivalente del
`Include()` de EF Core. `loadRelated` resuelve una relación N:1 en **una sola
consulta por lotes** (`WHERE key IN (…)`), no una por fila:

```ts
const branches = await loadRelated<IAppointment, IBranch>(appointments, {
  foreignKey: "fkBranch",
  relatedKey: "pkBranch",
  repository: branchesRepository,
});
```

Las claves foráneas nulas se saltan y no se consulta nada cuando no hay nada que
resolver. Aquí `withDeleted` vale `true` por defecto: un registro debe seguir
mostrando el nombre de su padre después de que el padre se haya borrado
lógicamente.

Nada de lo de arriba lee la metadata, porque hasta ahora la metadata no tenía
nada que decir al respecto: una clave ajena era una columna `kind: "number"` con
un nombre que casualmente lo parecía. Declarar la relación le pone nombre:

```ts
export const BOOKS_ENTITY = defineEntity<IBook>({
  table: "BOOKS",
  primaryKey: "pkBook",
  columns: {
    pkBook: { name: "PK_BOOK", kind: "number", insertable: false, updatable: false },
    name: { name: "NAME", kind: "string" },
    authorId: { name: "FK_AUTHOR", kind: "number" },
  },
  relations: {
    author: { to: "AUTHORS", localKey: "authorId", foreignKey: "pkAuthor", onDelete: "restrict" },
  },
});
```

**El repositorio sigue sin leer esto.** Conoce una tabla, no hace ningún join, y
una relación no cambia nada de cómo se selecciona, se inserta o se filtra una
fila. `onDelete` es lo que debe decir el DDL generado y nada más — no hay cascada
que ejecutar en tiempo de consulta, porque nadie mira.

Lo que gana es una única declaración de un hecho que se estaba haciendo tres
veces: la restricción en el DDL generado, la relación que `monolite generate
module` necesita para andamiar un módulo relacionado, y las claves que si no hay
que ir a buscar leyendo dos ficheros. Una relación que apunta a una entidad que
nadie registró falla mientras se ensambla la capa de persistencia, nombrando
ambos lados — no más tarde, cuando algo la siga, porque nunca la sigue nadie.

El include que declara un servicio sigue nombrando sus propias claves. La
metadata conoce la propiedad de la *entidad*; un include necesita la del *DTO*, y
sólo el mapper sabe cómo se corresponden esas dos.

### Una segunda interfaz para el SQL extra

Un módulo recibe el repositorio genérico **más** su propia interfaz sólo cuando
necesita algo que la API genérica no puede expresar:

```ts
// Con esto basta.
export type IBranchesRepository = IGenericRepository<IBranch>;

// El contrato genérico más un GROUP BY.
export interface IAppointmentsRepository extends IGenericRepository<IAppointment> {
  countByStatus(fkBranch?: number): Promise<AppointmentStatusCount[]>;
}
```

Las agregaciones quedan fuera del lenguaje de filtros a propósito: añadirlas lo
convertiría en un ORM completo. `SqlGenericRepository.executeRaw()` es la vía de
escape documentada para ellas — y para vistas y procedimientos almacenados. Los
valores siguen viajando como binds, y los nombres físicos siguen saliendo del
mapeo:

```ts
const statusColumn = store.schema.columnOf("status");
const rows = await store.executeRaw<{ STATUS: string; TOTAL: number }>(sql, binds);
```

Ninguno de los dos miembros está en `IGenericRepository`, que es lo que registra
el contenedor y lo que un módulo inyecta normalmente. Se piden con
`asRawQueryable`:

```ts
import { asRawQueryable } from "monolite-data";
import type { IGenericRepository } from "monolite-data";

interface IAppointment {
  pkAppointment: number;
  status: string;
}

async function countByStatus(
  store: IGenericRepository<IAppointment>
): Promise<{ status: string; total: number }[]> {
  const sql = asRawQueryable(store);

  if (!sql) {
    const all = await store.getAll();
    const counts = new Map<string, number>();
    for (const one of all) counts.set(one.status, (counts.get(one.status) ?? 0) + 1);
    return [...counts].map(([status, total]) => ({ status, total }));
  }

  const column = sql.schema.columnOf("status");
  const rows = await sql.executeRaw<{ STATUS: string; TOTAL: number }>(
    `SELECT ${column} AS STATUS, COUNT(*) AS TOTAL FROM ${sql.schema.table} GROUP BY ${column}`
  );

  return rows.map((row) => ({ status: row.STATUS, total: Number(row.TOTAL) }));
}
```

El `null` es justamente el punto. Los drivers en memoria y de MongoDB no tienen
SQL que ejecutar y no pueden fingir lo contrario, así que `executeRaw` no está en
el contrato común: ponerlo ahí obligaría a que dos de las tres implementaciones
lanzaran, y un contrato cuyas implementaciones lanzan no es un contrato.
`IRawQueryable<T>` dice lo que sí es cierto —*algunos* almacenes saben ejecutar
SQL— y preguntarlo es una línea en vez del narrowing que cada proyecto se
inventaría por su cuenta.

Conviene mantener el camino alternativo en lugar de tratar el `null` como un
error de configuración: el driver en memoria es sobre el que corre la suite
generada, así que la rama que calcula la misma respuesta en el proceso es la que
tus pruebas ejercitan.

Un módulo que toma ese camino suele mantener un respaldo en JavaScript para los
motores que no son SQL, así que sigue funcionando con el driver de memoria y con
MongoDB.

---

## Generar el esquema

`defineEntity` ya lleva todos los datos que necesita un `CREATE TABLE`: los
nombres físicos, los tipos, la clave, si la genera el motor, la marca de borrado
lógico, las marcas de tiempo, las columnas de auditoría y —desde que se declaran
las relaciones— las claves foráneas. Hasta ahora nada de eso se usaba para eso, y
el esquema se mantenía dos veces: como metadatos que lee el código y como SQL
escrito a mano, sin que nadie comprobara que decían lo mismo.

Y no dicen lo mismo de formas difíciles de adivinar. El mapeo escribe un booleano
como `1` y `0`, así que una columna declarada `BOOLEAN` en PostgreSQL rechaza
todos los inserts que hace el repositorio; la demo que se topó con ello perdió
una tarde hasta convertirla en `SMALLINT`, que es lo que emite el generador.

```bash
npm run db:sql                      # a stdout, para el motor de DATA_SOURCE
npm run db:sql -- --dialect mysql
npm run db:sql -- --out db/schema.sql
```

```sql
CREATE TABLE PRODUCTS (
  PK_PRODUCT INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  NAME VARCHAR(150) NOT NULL,
  DESCRIPTION VARCHAR(500),
  AVAILABLE SMALLINT DEFAULT 1 NOT NULL,
  CREATED_AT TIMESTAMPTZ,
  CONSTRAINT PK_PRODUCTS PRIMARY KEY (PK_PRODUCT)
);

-- Foreign keys
ALTER TABLE PRODUCTS ADD CONSTRAINT FK_PRODUCTS_FK_CATEGORY
  FOREIGN KEY (FK_CATEGORY) REFERENCES CATEGORIES (PK_CATEGORY) ON DELETE RESTRICT;
```

Todas las tablas se crean antes de restringir ninguna. No por orden estético: una
clave foránea puede apuntar a una tabla declarada después, y dos tablas que se
apuntan entre sí no tienen ningún orden válido.

### Qué tiene que decir el mapeo para esto

Cuatro campos opcionales de una columna existen para el generador y para nada
más: el repositorio nunca ha necesitado saber cuán ancha es una columna, envía
valores como binds y deja que el motor los revise. Omitirlos sigue mapeando,
consultando y escribiendo igual; solo genera un esquema con los valores por
defecto.

| Campo | Por defecto |
| --- | --- |
| `length` | 255; `"max"` pide el tipo de texto sin límite del motor |
| `precision` / `scale` | ausentes: un número es un entero |
| `nullable` | `true`, salvo la clave primaria |
| `unique` | `false`; para más de una columna, `indexes` |
| `default` | ninguno. SQL literal, tal cual — comilla tú tus cadenas |

Que la nulabilidad por defecto sea la permisiva es deliberado: es la única
elección que no puede romper una tabla que ya existe la primera vez que el DDL
generado se compara con uno escrito a mano.

### Migraciones

```bash
npm run db:migration -- add-invoice-notes
```

Compara el modelo contra `migrations/.snapshot.json` —versionado, y a propósito
no contra la base de datos viva—. Leer la base de datos significaría una
migración que no se puede escribir sin conexión a un entorno, y que saldría
distinta según a qué entorno estuvieras apuntando. El snapshot es lo que decía el
código, que es lo mismo para todo el que tiene el código.

**Cuando nada ha cambiado no escribe nada.** Una herramienta que emite un fichero
vacío en cada ejecución enseña a la gente a dejar de leer su salida, y entonces
la que importaba sale sin leerse.

**No puede ver un renombrado.** Una columna renombrada en los metadatos es, para
un diff, una columna que desaparece y otra que aparece, y nada la distingue de un
borrado y un alta de verdad: lo único que podría —una identidad estable por
columna que sobreviva al renombrado— no existe en el mapeo. Así que emite las dos
y lo dice en el fichero. Convertir el par en un `RENAME COLUMN` son dos líneas
para la única persona que sabe que era un renombrado; adivinar borraría en
silencio una columna con datos el día que dos cambios sin relación caigan juntos.

Renombrar una propiedad sobre la misma columna no produce nada, porque el
snapshot se indexa por columna. Refactorizar tu código no es una migración.

Todo lo que destruye datos —una columna que se cae, una tabla que se cae— se
escribe **comentado**. Lo demás es aditivo o reversible; un fichero generado que
borra una tabla es un fichero generado que alguien ejecuta sin querer.

### No hay runner, a propósito

La salida es SQL plano para umzug, node-pg-migrate, Flyway o `psql < fichero`,
lo que este proyecto ya use. Tener un runner significa tener una tabla de
migraciones aplicadas, bloqueo, orden, rollback y todas las preguntas de soporte
sobre las cuatro cosas; y un toolkit que se adopta paquete a paquete no debería
obligarte a cambiar de herramienta de migraciones para usar su mapeo de
entidades.

Generar el DDL al arrancar se consideró y se descartó por una razón más corta: un
proceso que altera un esquema al arrancar es un proceso que altera producción en
un despliegue malo.

---

## Los motores

| `DATA_SOURCE` | Motor | Repositorio | Conector |
| --- | --- | --- | --- |
| `memory`, `dummy` | arreglos dentro del proceso | `MemoryGenericRepository` | — |
| `oracle` | Oracle 23ai | `SqlGenericRepository` + `oracleDialect` | `OracleConnector` — node-oracledb 7, modo thin |
| `mssql`, `sqlserver` | SQL Server 2022 | `SqlGenericRepository` + `sqlServerDialect` | `SequelizeConnector` — tedious |
| `postgres` | PostgreSQL 16 | `SqlGenericRepository` + `postgresDialect` | `SequelizeConnector` — pg |
| `mysql`, `mariadb` | MySQL 8 | `SqlGenericRepository` + `mysqlDialect` | `SequelizeConnector` — mysql2 |
| `mongo`, `mongodb` | MongoDB 7 | `MongoGenericRepository` | `MongoConnector` — el driver de mongodb |

Un valor desconocido **falla al arrancar** en vez de caer a memoria: un `postgress`
mal escrito arrancaría en memoria y sólo saldría a la luz mucho después, como datos
que no persisten.

Todos los drivers son **peer dependencies opcionales**. Instala el que uses; el
paquete no se descarga los otros cinco.

Un mismo conector cubre tres motores porque Sequelize habla los tres. Lo único que
resuelve por motor es cómo pedirle al driver las dos cosas que no todos reportan
igual: las filas afectadas y el id generado.

### Qué codifica un dialecto

| | PK generada | El "ahora" del servidor | Paginación |
| --- | --- | --- | --- |
| Oracle | `RETURNING … INTO` (bind de salida) | `SYSTIMESTAMP` | `OFFSET … FETCH NEXT` |
| SQL Server | `OUTPUT INSERTED` | `SYSDATETIME()` | `OFFSET … FETCH NEXT` |
| PostgreSQL | `RETURNING` | `NOW()` | `OFFSET … FETCH NEXT` |
| MySQL / MariaDB | el driver (`LAST_INSERT_ID()`) | `CURRENT_TIMESTAMP(3)` | `LIMIT … OFFSET` |

Se prefiere `OUTPUT INSERTED` a `SCOPE_IDENTITY()` porque no depende del ámbito de
la sesión. MySQL es la excepción por partida doble: no tiene ni `RETURNING` ni
`OUTPUT`, y no entiende `OFFSET … FETCH NEXT` — cuando sólo hace falta un
desplazamiento recibe `LIMIT 18446744073709551615`, el truco que el propio manual
de MySQL documenta para "de la fila N hasta el final".

Esa primera columna es la razón de que `ISqlExecutor.execute` reciba una pista
`expects` (`rows` | `affected` | `identity`): el repositorio sabe si una sentencia
produce un conjunto de resultados, un número de filas o un id generado, y cada
conector responde en consecuencia. Oracle ignora la pista — devuelve las tres cosas
en una sola respuesta.

### Tres trampas que vale la pena heredar

**La trampa de la zona horaria.** Sequelize escapa un `Date` como *hora local con
desfase*. SQL Server y MySQL descartan ese desfase al guardarlo y luego releen la
columna *como si fuera UTC*, así que cada ida y vuelta corre la fecha el desfase
local. El síntoma es sutil: una regla de solapamiento deja de detectar choques sin
decir nada, porque la comparación del lado de JavaScript ve horas de diferencia.
Los dos dialectos normalizan los binds `Date` a UTC sin desfase, que es exactamente
lo que da por supuesto el lado de la lectura. Oracle y PostgreSQL no lo necesitan —
node-oracledb conserva el instante y la columna de PostgreSQL es `TIMESTAMPTZ`.
**Si añades otro motor, prueba explícitamente una ida y vuelta con fechas.** Esta
mordió dos veces al código original.

**PostgreSQL pasa a minúsculas los identificadores sin comillas**, en el DDL igual
que en las consultas. Crea el esquema *sin* comillas, para que el SQL en mayúsculas
que genera el repositorio caiga en esos mismos nombres; el mapeo columna↔propiedad
no distingue mayúsculas, así que los resultados que vuelven en minúsculas casan
limpiamente. Poner comillas en el DDL es justo lo que lo rompe.

**Los `replacements` de Sequelize se escapan y se interpolan; no son parámetros del
lado del servidor.** Sequelize escapa según el dialecto, así que es seguro frente a
inyección, pero no reutiliza los planes de ejecución como sí haría un bind de
verdad. node-oracledb sí usa binds reales. Conviene saberlo antes de ponerse a
medir rendimiento.

### Conexiones

Un `connection.close()` sobre una conexión del pool la devuelve al pool; no derriba
el socket. Cada adquisición tiene emparejada su liberación en un `finally`, así que
una conexión se retiene sólo durante la sentencia — salvo dentro de una
transacción, donde una conexión se retiene durante todo el bloque, porque un
`COMMIT` sólo tiene sentido en la sesión que hizo las escrituras. Mantén cortos
esos bloques.

Los pools y los clientes se crean de forma perezosa y se memoizan, así que una
ráfaga de peticiones al arrancar abre exactamente uno. Un intento fallido **no** se
cachea: un fallo transitorio —la base de datos todavía arrancando, una réplica
todavía eligiendo primario— no debe envenenar el proceso.

### MongoDB, el que no comparte implementación

Ofrece exactamente el mismo contrato, con cuatro divergencias reales:

- **Las transacciones exigen un replica set.** Un `mongod` suelto no tiene oplog y
  rechaza `startTransaction`. Como el repositorio escribe cada operación y su línea
  de auditoría de forma atómica, sin él la API no funciona en absoluto.
- **Las claves primarias numéricas salen de una colección `_counters`** — el patrón
  canónico de secuencia, un documento por entidad, incrementado con un
  `findOneAndUpdate` atómico. La reserva ocurre a propósito *fuera* de la sesión de
  la transacción: dos transacciones tocando el mismo documento contador entrarían
  en conflicto y una abortaría. Una secuencia que no devuelve el número al hacer
  rollback es exactamente cómo se comportan las secuencias de Oracle y el
  `IDENTITY` de SQL Server, así que **puede haber huecos, y ése es el
  comportamiento fiel**.
- **Las marcas de tiempo las escribe la aplicación.** MongoDB no tiene un
  equivalente de `SYSTIMESTAMP` que el servidor evalúe al escribir.
- **Un validador `$jsonSchema` rechaza documentos, no los completa.** Todo lo que
  los motores SQL rellenan con un `DEFAULT` de columna tiene que escribirlo el
  repositorio. Un valor por defecto que la aplicación no aporte simplemente no
  existirá en el documento, así que deja esos campos fuera de `required` —
  exigirlos rechazaría un insert que los otros cuatro motores aceptan.

MongoDB tampoco tiene claves foráneas, así que la existencia referencial la
comprueba la aplicación. `_id` se excluye de todas las proyecciones: es la clave
técnica de Mongo, no forma parte del modelo de dominio y no tiene equivalente en
los demás motores.

---

## Añadir un motor nuevo

Si es SQL y Sequelize lo habla, es un dialecto y un poco de cableado:

1. Añade el dialecto — cómo vuelve una PK generada, la expresión del ahora del
   servidor, la cláusula de paginación, la sentencia de bloqueo de fila y cualquier
   conversión de binds que necesite el driver.
2. Regístralo en la factoría de repositorios y en la unión `SequelizeEngine`.
3. Añade el alias, las variables de entorno y el esquema.

Si no es SQL, necesita su propia implementación de `IGenericRepository<T>`, su
propio traductor de filtros y su propia unidad de trabajo — que es lo que tiene
MongoDB. `MemoryGenericRepository` es la referencia: implementa el mismo contrato
sin una sola línea de SQL.

En cualquiera de los dos casos:

- **Apúntale primero el kit de contrato.** Es la definición de "se comporta como
  los demás", y sale más barato satisfacerlo que adaptarse a él después.
- **Prueba explícitamente una ida y vuelta con fechas**, por lo dicho arriba.
- **No añadas el alias antes de que exista la implementación.** Listarlo pronto
  hace que `DATA_SOURCE` arranque en memoria y tape el problema, que es justo lo
  que esa tabla existe para evitar.
</content>
</invoke>
