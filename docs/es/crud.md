# CRUD genérico

> 🇬🇧 [Read in English](../en/crud.md) · paquete: `monolite-crud`

`monolite-data` quitó la repetición por debajo de la BLL: una implementación de
repositorio en vez de seis. `monolite-crud` quita la que quedaba por encima — el
controlador que parsea un id, lo envuelve todo en `try/catch` y llama a una BLL
que sólo reenvía al repositorio.

---

## Un módulo entero

```ts
@injectable()
@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
@Crud({ resource: "branch", dto: "Branch", schemas: branchSchemas })
export class BranchesController extends CrudController {
  constructor(
    @inject(BRANCH_TOKENS.bll) bll: BranchesBLL,
    @inject(TOKENS.IRequestContext) context: IRequestContext
  ) {
    super(bll, context, "branch");
  }
}
```

```ts
export class BranchesBLL extends CrudBLL<IBranch, BranchDTO> {
  constructor(@inject(BRANCH_TOKENS.store) store: IGenericRepository<IBranch>) {
    super(store, branchMapper, { field: "pkBranch", direction: "asc" });
  }
}
```

Eso son cinco endpoints:

| Verbo | Camino | Manejador |
| --- | --- | --- |
| `GET` | `/branches` | `list` — paginado, filtrable, `withDeleted` opcional |
| `GET` | `/branches/:id` | `getOne` — 404 `NOT_FOUND` si no está |
| `POST` | `/branches` | `create` — 201 con el recurso creado |
| `PUT` | `/branches/:id` | `update` |
| `DELETE` | `/branches/:id` | `softDelete` |

Cada uno llega con validación, el sobre de paginación, mapeo de errores y su
entrada de OpenAPI, porque `@Crud()` registra exactamente los mismos metadatos de
ruta que registraría un controlador escrito a mano.

---

## Opciones

| Opción | Significado |
| --- | --- |
| `resource` | Nombre en singular, usado en mensajes y en los resúmenes generados. Sin artículo: el decorador construye la frase a su alrededor |
| `dto` | **El nombre del componente de OpenAPI** al que referencian las respuestas — una cadena, no el objeto del esquema |
| `paged` | Nombre del componente de la página. Por defecto, `Paginated<dto>` |
| `schemas` | `{ create, update, query }` — los esquemas de Zod que se montan como validación |
| `verbs` | Cuáles de los cinco registrar. Omítelo para todos |

`dto` es un nombre y no un esquema porque el decorador sólo escribe un `$ref` con
él. Registrar el componente es un paso aparte, y obligatorio:

```ts
export const branchDto = defineDto("Branch", z.object({ /* ... */ }));
export const paginatedBranchesDto = definePagedDto("PaginatedBranch", branchDto);
```

Si se omite, el documento se sigue sirviendo, con cada operación apuntando a un
componente que no existe — Swagger UI muestra un cuerpo vacío y Scalar no muestra
nada. `mountDocs`, en un proyecto generado, comprueba justo eso al arrancar y
registra los nombres que faltan; `missingSchemaRefs(document)` es la misma
comprobación, para un test.

```ts
// Un recurso de sólo lectura: dos endpoints, y nada puede escribirlo por HTTP.
@Crud({ resource: "audit log", dto: "AuditLog", verbs: ["list", "getOne"] })
```

---

## Sobreescribir

El decorador sólo rellena huecos. Declara un método con el mismo nombre y gana el
tuyo — sin bandera y sin lista de exclusión:

```ts
@ApiController("/appointments", { tag: "Appointments", token: APPOINTMENT_TOKENS.controller })
@Crud({ resource: "appointment", dto: "Appointment", schemas })
export class AppointmentsController extends CrudController {
  constructor(
    private readonly appointments: AppointmentsBLL,
    context: IRequestContext
  ) {
    super(appointments, context, "appointment");
  }

  // Reemplaza el create genérico: reservar tiene una regla que el genérico no puede saber.
  @Post("/", {
    body: bookSchema,
    responses: { 201: { ref: "Appointment" }, 409: "Horario ocupado" },
  })
  public override create: CrudHandler = async (req, res, next) => {
    try {
      res.status(201).json(await this.appointments.book(req.body));
    } catch (error) {
      next(error);
    }
  };

  // Y añadir un endpoint que el conjunto genérico no tiene es sólo un decorador.
  @Get("/upcoming", { query: upcomingSchema })
  public upcoming = async (req: Request, res: Response) => { /* ... */ };
}
```

Esto funciona porque las rutas se montan [por especificidad](routing.md), así que
`/appointments/upcoming` se registra por delante de `/appointments/:id` sin
importar dónde lo pusiera el decorador.

Del lado de la BLL funciona igual: sobreescribe `create` en tu subclase de
`CrudBLL`, o sobreescribe el hook `buildWhere` para cambiar cómo traduce `list`
los parámetros de consulta a un filtro. Los filtros que sólo son una
correspondencia —este parámetro, esa columna— es mejor
[declararlos](#filtrar-el-listado); el hook es para los que son una regla.
`super.buildWhere(query)` devuelve los declarados, y `allOf` los combina con los
tuyos:

```ts
protected override buildWhere(query: ListQuery): WhereFilter<IBranch> | undefined {
  // Sólo las sucursales de quien llama, pida lo que pida además.
  return allOf(super.buildWhere(query), { fkOwner: Number(this.context.getCurrentUserId()) });
}
```

`buildWhere` es síncrono a propósito. Es el hook que sobreescriben todos los
módulos, y uno que pudiera hacer `await` pondría una consulta por delante de todos
los listados del proyecto: la pagarían todos y la necesitan pocos.

Aun así, hay filtros que sí tienen que mirar en otro sitio antes. «Libros cuyo autor
se llama Le Guin» son dos pasos: las claves de los autores cuyo nombre encaja, y
luego los libros con esas claves. Ese paso va en **`resolveQuery`**, que corre antes
de `buildWhere` y le entrega una consulta ya completa:

```ts
protected override async resolveQuery(query: unknown): Promise<unknown> {
  const { author } = (query ?? {}) as { author?: string };
  if (!author) return query;

  const matches = await this.authors.find({ where: { name: { contains: author } } });
  // Un nombre que no lleva nadie no puede convertirse en un filtro vacío: `{ in: [] }`
  // no filtra nada en algunos drivers, y una búsqueda fallida contestaría con todo.
  return { ...query, authorIds: matches.length ? matches.map((a) => a.pkAuthor) : [-1] };
}
```

Lo que importa de la costura es lo que conservas: la paginación, el orden por
defecto y `withDeleted` siguen viniendo de la clase base. Sobreescribir `list` para
hacerle sitio a la búsqueda obliga a copiar los tres, y cada copia es un sitio donde
perder uno.

---

## Filtrar el listado

Casi todos los filtros de un listado son una correspondencia: `clientId` es
igualdad sobre `clientId`, `q` busca en `reference`, `from` y `to` acotan
`paymentDate`. Declara esa correspondencia junto al esquema de la consulta en vez de
programarla en la BLL:

```ts
import { contains, eq, filtersFor, gte, lte } from "monolite-crud";

export const paymentFilters = filtersFor<IPayment, z.infer<typeof paymentQuerySchema>>({
  q:        contains(["reference", "notes"]),
  clientId: eq("clientId"),
  methodId: eq("methodId"),
  from:     gte("paymentDate", { boundary: "startOfDay" }),
  to:       lte("paymentDate", { boundary: "endOfDay" }),
});
```

y dile a la BLL cuál usa:

```ts
constructor(@inject(PAYMENT_TOKENS.store) store: IGenericRepository<IPayment>) {
  super(store, paymentMapper, {
    orderBy: { field: "paymentDate", direction: "desc" },
    filters: paymentFilters,
  });
}
```

El `buildWhere` por defecto contesta con ellos, así que el módulo no escribe ningún
`buildWhere`. Lo que viene incluido:

- **El ensamblado.** Sin parámetros presentes es `undefined` —ningún filtro, no un
  `$and` vacío—. Con uno es la cláusula sola, no un `$and` de un elemento, así que
  el SQL no cambia cuando un módulo migra desde un `buildWhere` escrito a mano. Con
  varios es un `$and`, en el orden en que se declararon las reglas. Ausente
  significa `undefined`, `null` o la cadena vacía que manda una caja de búsqueda en
  blanco; `0` y `false` son valores.
- **Varias columnas en una búsqueda.** `contains(["reference", "notes"])` es un
  `$or` de un `contains` sin distinguir mayúsculas por columna: la razón por la que
  tantos módulos buscaban sólo en la primera columna que se le ocurrió a alguien.
- **La convención de rangos de fecha, con nombre.** `startOfDay` es
  `T00:00:00.000Z` y `endOfDay` es `T23:59:59.999Z`: la misma decisión en todos los
  módulos, y la que cambia en un solo sitio si la aplicación algún día tiene zona
  horaria. El parámetro tiene que ser una fecha de calendario (`YYYY-MM-DD`, o un
  `Date` que se lee por su día UTC); cualquier otra cosa —un timestamp,
  `2026-02-30`— se rechaza con un 400 que nombra el parámetro en vez de convertirse
  en un filtro que en silencio no encuentra nada.
- **Comprobaciones al compilar.** Una regla que nombra una propiedad que `IPayment`
  no tiene rompe el build. Pasa el tipo de la consulta como segundo argumento de
  tipo y un parámetro que el esquema no tiene también lo rompe: la deriva que un
  cast escrito a mano escondía.

Los constructores son `eq`, `contains`, `gte`, `lte`, `gt` y `lt`. La
correspondencia se declara en vez de inferirse del esquema a propósito: `from` y
`to` no nombran su columna, `q` apunta a una distinta en cada módulo, y un
parámetro que comparte nombre con una columna no siempre es un filtro sobre ella.

Un filtro que es lógica —«vencido» como una fecha *y* un estado *y* ningún pago
contra él— no es una correspondencia y sigue siendo un `buildWhere` sobreescrito,
que combina su regla con los filtros declarados mediante
`allOf(super.buildWhere(query), rule)`.

---

## Relaciones

Un libro lleva el *nombre* de su autor, no sólo la clave: la clave es lo que un
cliente devuelve al editar, el nombre es lo que tiene que pintar, y un listado que
sólo lleva la clave cuesta una petición por fila.

Declara la relación una vez, donde se construye la BLL:

```ts
export class BooksBLL extends CrudBLL<IBook, BookDTO> {
  constructor(books: IGenericRepository<IBook>, authors: IGenericRepository<IAuthor>) {
    super(books, bookMapper, {
      orderBy: { field: "name", direction: "asc" },
      includes: [
        include<BookDTO, IAuthor>({
          key: "authorId",       // la propiedad del DTO con la clave ajena
          relatedKey: "pkAuthor",
          repository: authors,
          into: "author",        // la propiedad del DTO donde va el nombre
          pick: (author) => author.name,
        }),
      ],
    });
  }
}
```

y marca en el mapper el campo que rellena, para que nada lo escriba de vuelta y
para que se vea de dónde sale:

```ts
const bookMapper = createMapper<IBook, BookDTO>({
  id: { field: "pkBook", readOnly: true },
  name: "name",
  authorId: "authorId",
  author: hydrated(),
});
```

Eso es todo. `list`, `getOne`, `create` y `update` la resuelven, porque los cuatro
pasan por un único sitio dentro de `CrudBLL` — y **un campo declarado con
`hydrated()` que ningún include rellena impide construir la BLL**, diciendo
qué campo es. El error que esto sustituye no es hipotético: llamar a `loadRelated`
a mano en cada uno de los cuatro verbos y acordarse sólo de dos produce un recurso
que lleva su autor cuando se lee y no cuando se escribe, con un DTO que dice que el
campo está en ambos casos.

Una consulta en lote por relación y por página —`WHERE clave IN (…)`, lo mismo que
hace `Include()` de EF Core— y ninguna cuando todas las claves son nulas. Los
padres borrados lógicamente se incluyen a propósito: un libro tiene que seguir
mostrando su autor después de que ese autor se retire, o una fila histórica se
vuelve ilegible.

`loadRelated` se sigue exportando para lo que esto no cubre: una relación que no es
uno a uno con un campo del DTO, o una que se resuelve dentro de un verbo que el
módulo escribió él mismo.

---

## Transacciones

Un caso de uso que escribe en más de un sitio necesita una transacción. Enhebrar
una por controlador → BLL → repositorio metería un parámetro en todas las
firmas en beneficio de los pocos métodos que lo usan, así que la transacción es
**ambiental**:

```ts
export class AppointmentsBLL extends CrudBLL<IAppointment, AppointmentDto> {
  constructor(
    // El almacén trae la unidad de trabajo a la que se suma, así que este es
    // todo el constructor: sin segunda clase base, sin nada más que inyectar.
    @inject(APPOINTMENT_TOKENS.store) repository: IGenericRepository<IAppointment>
  ) {
    super(repository, appointmentMapper);
  }

  @Transactional()
  public async book(input: BookInput): Promise<AppointmentDto> {
    // Bloquear la fila de la sucursal es la primera sentencia a propósito — ver abajo.
    await lockRow(this, ENTITY.BRANCHES, input.fkBranch);

    const clash = await this.repository.firstOrDefault({
      where: { fkBranch: input.fkBranch, startsAt: input.startsAt },
    });
    if (clash) {
      throw new AppError(`La sucursal ya tiene la cita #${clash.pk} en ese horario`, 409, true, {
        code: "APPOINTMENT_OVERLAP",
      });
    }

    return this.mapper.toDTO(await this.repository.insert(input));
  }
}
```

`@Transactional()` abre una unidad de trabajo y la publica en el
`ITransactionContext` ambiental. Todo repositorio llamado dentro —incluidos los que
están varias capas más abajo y a los que nunca se les dijo nada— resuelve su
almacén a través de ese contexto y se suma a la misma transacción. No se pasa nada.

**`CrudBLL` trae la costura.** El decorador necesita una unidad de trabajo para
abrir la transacción y un contexto de transacción para saber si ya hay una
abierta, y una subclase de `CrudBLL` tiene las dos sin pedirlas: vienen con el
almacén que recibió. Esa resolución es lo que cablea `registerPersistence` cuando
recibe un contexto `transactions`: cada almacén que registra se suma a la
transacción que esté abierta, usa el pool cuando no hay ninguna y lleva consigo la
unidad de trabajo a la que se suma. Los proyectos generados lo pasan, así que en
el tuyo ya es cierto.

Una raíz de composición escrita a mano que omita el contexto obtiene almacenes que
escriben por su propia conexión, y ninguna costura: `@Transactional()` rechaza
entonces en la primera llamada, diciendo qué falta, en vez de ejecutar el método
con auto-commit — tres auto-commits se ven exactamente igual que una transacción
hasta que algo falla en medio. Lo mismo vale para el driver de memoria en una
prueba unitaria construida sobre un almacén pelado.

Una clase puede seguir aportando los dos miembros ella misma —extender
`TransactionalBLL`, o inyectar `IUnitOfWork` e `ITransactionContext` y guardarlos
como `unitOfWork` y `transactions`, con `implements TransactionalHost` para que el
que falte sea un error de compilación—. Si lo hace, se usan sus propios miembros.
Esa era la única forma para una subclase de `CrudBLL` antes de la
[#33](https://github.com/Tanke6003/monolite/issues/33), y sigue compilando sin
cambios.

**Las escrituras por defecto son atómicas.** `create`, `update` y `softDelete` de
`CrudBLL` se ejecutan en una transacción siempre que haya una unidad de trabajo
con la que abrirla. Cada una es una llamada y varias sentencias por debajo —la
fila, su entrada en el registro de cambios, la relectura—, y el coste del defecto
es una transacción alrededor de un solo insert, cuando el coste del defecto
contrario era que todo módulo generado fuera no atómico sin que nadie lo notara.
Llamado desde dentro de una sobrescritura `@Transactional()`, `super.create(...)`
se suma a su transacción, así que esto basta para mantener juntos una
comprobación y el insert:

```ts
export class PaymentsBLL extends CrudBLL<IPayment, PaymentDto> {
  @Transactional()
  override async create(dto: Partial<PaymentDto>): Promise<PaymentDto> {
    await this.assertConsistent(dto);
    return super.create(dto);
  }

  private async assertConsistent(dto: Partial<PaymentDto>): Promise<void> {
    // Las lecturas contra las otras tablas; un throw aquí deshace el insert.
  }
}
```

Para una parte del método y no todo —un método que primero lee y sólo después
decide qué escribir—, `this.tx(() => ...)` ejecuta el callback en una transacción,
sumándose a una ya abierta, y se niega sin unidad de trabajo igual que el
decorador. Es también el único punto por el que pasan las escrituras por defecto,
así que un módulo que las quiera con auto-commit después de todo (una ruta de
inserción caliente, o MongoDB sin replica set, donde no hay transacción que abrir)
lo sobrescribe:

```ts
protected override tx<R>(fn: () => Promise<R>): Promise<R> {
  return fn();
}
```

Tres cosas al respecto que son decisiones y no accidentes:

**Se suma en vez de anidar.** Un método `@Transactional()` llamado desde dentro de
otro reutiliza la transacción abierta. Anidar una segunda provocaría un interbloqueo
contra la primera por las filas que ya retiene.

**Rechaza en vez de lanzar cuando falta un miembro.** Una configuración con el
driver de memoria y sin unidad de trabajo registrada recibe una promesa rechazada
que nombra el miembro y las dos maneras de aportarlo, no un throw síncrono desde
dentro de un decorador, que es mucho más difícil de rastrear.

**`lockRow` es una función suelta, no un método de la clase base.** Una BLL que
necesite un bloqueo de fila puede ya estar extendiendo `CrudBLL`, y TypeScript
no tiene herencia múltiple. Recibe el propio servicio —`lockRow(this, ...)`
encuentra el contexto igual que lo encontró el decorador— o el contexto de
transacción explícitamente, que cuesta un argumento y evita imponerle una cadena
de herencia a nadie.

### Por qué el bloqueo va primero

En MySQL, `REPEATABLE READ` fija la foto de la transacción en su **primera
lectura**. Un comprobar-y-luego-escribir que lee antes de bloquear lee la foto
previa al bloqueo, así que las dos transacciones concurrentes ven "no hay choque" y
las dos insertan. Que el bloqueo sea la primera sentencia es lo que hace que la
lectura siguiente vea la realidad confirmada.

El bloqueo además necesita un índice único parcial detrás como red: el bloqueo
serializa las dos transacciones, y el índice caza el caso que el bloqueo no puede
cubrir, como dos instancias distintas de la aplicación compitiendo antes de que
cualquiera lo tome. Los proyectos generados traen ese índice en el esquema de todos
los motores.

---

## Qué te da `CrudBLL`

| Miembro | Para qué |
| --- | --- |
| `list(options)` | Lectura paginada; `options.withDeleted` incluye las filas borradas lógicamente, `options.query` alimenta `buildWhere` |
| `getOne(id)` | `null` si no está — el controlador lo convierte en un 404, así la BLL se mantiene ajena a HTTP |
| `create(input)` | Inserta —en una transacción si hay unidad de trabajo— y mapea al DTO |
| `update(id, input)` | En una transacción si hay unidad de trabajo |
| `softDelete(id)` | En una transacción si hay unidad de trabajo |
| `buildWhere(query)` | Hook protegido: parámetros de consulta → `WhereFilter<T>`; por defecto, los `filters` declarados |
| `filters` | Los filtros del listado, declarados al construir con `filtersFor()` |
| `resolveQuery(query)` | Hook protegido, asíncrono: completa la consulta antes de que `buildWhere` la lea |
| `includes` | Relaciones resueltas en todos los verbos, declaradas al construir con `include()` |
| `mapper` | `EntityMapper<TEntity, TDto>` — entidad ↔ DTO en un solo sitio |
| `tx(fn)` | Protegido: ejecuta `fn` en una transacción, sumándose a una ya abierta; sobrescrito a `return fn()`, devuelve las escrituras por defecto al auto-commit |

La BLL no sabe nada de HTTP: devuelve `null`, no un 404, y lanza `AppError`,
no una respuesta. Eso es lo que permite que la misma BLL respalde un comando
de consola, un trabajo programado o un consumidor de mensajes sin arrastrar Express
hasta ellos.

---

## Cuándo no usarlo

`@Crud()` es lo correcto para un recurso cuyas cinco operaciones básicas son
genuinamente genéricas. Es la herramienta equivocada cuando:

- **Cada verbo tiene una regla.** Si sobreescribes los cinco, el decorador añade
  indirección y no quita nada. Escribe el controlador.
- **El recurso no es una fila.** Un informe, una búsqueda sobre tres agregados o un
  endpoint de acción (`POST /orders/:id/ship`) no es CRUD y no debería fingir que
  lo es.
- **El listado necesita un join.** `buildWhere` filtra una tabla. Un listado que
  tenga que unir pertenece a un método de repositorio con SQL de verdad — ver
  [data-access.md](data-access.md) sobre por qué el repositorio genérico se detiene
  en los joins.
