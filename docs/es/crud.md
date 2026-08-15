# CRUD genérico

> 🇬🇧 [Read in English](../en/crud.md) · paquete: `@monolite/crud`

`@monolite/data` quitó la repetición por debajo del servicio: una implementación de
repositorio en vez de seis. `@monolite/crud` quita la que quedaba por encima — el
controlador que parsea un id, lo envuelve todo en `try/catch` y llama a un servicio
que sólo reenvía al repositorio.

---

## Un módulo entero

```ts
@ApiController("/branches", { tag: "Branches", token: TOKENS.IBranchesController })
@Crud({ resource: "branch", dto: branchDto, paged: true, schemas: branchSchemas })
export class BranchesController extends CrudController<IBranch, BranchDto> {
  constructor(service: IBranchesService, context: IRequestContext) {
    super(service, context);
  }
}
```

```ts
export class BranchesService extends CrudService<IBranch, BranchDto> {
  constructor(repository: IBranchesRepository, mapper: EntityMapper<IBranch, BranchDto>) {
    super(repository, mapper);
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
| `resource` | Nombre en singular, usado en mensajes y en los resúmenes generados |
| `dto` | El DTO al que referencian las respuestas |
| `paged` | Si `list` devuelve el sobre paginado o un arreglo plano |
| `schemas` | `{ create, update, query }` — los esquemas de Zod que se montan como validación |
| `verbs` | Cuáles de los cinco registrar. Omítelo para todos |

```ts
// Un recurso de sólo lectura: dos endpoints, y nada puede escribirlo por HTTP.
@Crud({ resource: "auditLog", dto: auditDto, paged: true, verbs: ["list", "getOne"] })
```

---

## Sobreescribir

El decorador sólo rellena huecos. Declara un método con el mismo nombre y gana el
tuyo — sin bandera y sin lista de exclusión:

```ts
@ApiController("/appointments", { tag: "Appointments", token: TOKENS.IAppointmentsController })
@Crud({ resource: "appointment", dto: appointmentDto, paged: true, schemas })
export class AppointmentsController extends CrudController<IAppointment, AppointmentDto> {
  // Reemplaza el create genérico: reservar tiene una regla que el genérico no puede saber.
  @Post("/", { body: bookSchema, responses: { 201: { ref: "Appointment" }, 409: "Horario ocupado" } })
  public create = async (req: Request, res: Response, next: NextFunction) => {
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

Del lado del servicio funciona igual: sobreescribe `create` en tu subclase de
`CrudService`, o sobreescribe el hook `buildWhere` para cambiar cómo traduce `list`
los parámetros de consulta a un filtro.

```ts
protected override buildWhere(query: ListQuery): WhereFilter<IBranch> {
  const where = super.buildWhere(query);
  // Sólo las sucursales de quien llama, pida lo que pida además.
  return { $and: [where, { fkOwner: Number(this.context.getCurrentUserId()) }] };
}
```

---

## Transacciones

Un caso de uso que escribe en más de un sitio necesita una transacción. Enhebrar
una por controlador → servicio → repositorio metería un parámetro en todas las
firmas en beneficio de los pocos métodos que lo usan, así que la transacción es
**ambiental**:

```ts
export class AppointmentsService extends CrudService<IAppointment, AppointmentDto> {
  @Transactional()
  public async book(input: BookInput): Promise<AppointmentDto> {
    // Bloquear la fila de la sucursal es la primera sentencia a propósito — ver abajo.
    await lockRow(this.transactions, ENTITY.BRANCHES, input.fkBranch);

    const clash = await this.repository.findOverlapping(input);
    if (clash) {
      throw new AppError(`La sucursal ya tiene la cita #${clash.pk} en ese horario`, 409, true, {
        code: "APPOINTMENT_OVERLAP",
      });
    }

    return this.mapper.toDto(await this.repository.insert(input));
  }
}
```

`@Transactional()` abre una unidad de trabajo y la publica en el
`ITransactionContext` ambiental. Todo repositorio llamado dentro —incluidos los que
están varias capas más abajo y a los que nunca se les dijo nada— resuelve su
almacén a través de ese contexto y se suma a la misma transacción. No se pasa nada.

Tres cosas al respecto que son decisiones y no accidentes:

**Se suma en vez de anidar.** Un método `@Transactional()` llamado desde dentro de
otro reutiliza la transacción abierta. Anidar una segunda provocaría un interbloqueo
contra la primera por las filas que ya retiene.

**Rechaza en vez de lanzar cuando no hay unidad de trabajo.** Una configuración con
el driver de memoria y sin unidad de trabajo registrada recibe una promesa
rechazada con un mensaje claro, no un throw síncrono desde dentro de un decorador,
que es mucho más difícil de rastrear.

**`lockRow` es una función suelta, no un método de la clase base.** Un servicio que
necesite un bloqueo de fila puede ya estar extendiendo `CrudService`, y TypeScript
no tiene herencia múltiple. Pasar el contexto de transacción explícitamente cuesta
un argumento y evita imponerle una cadena de herencia a nadie.

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

## Qué te da `CrudService`

| Miembro | Para qué |
| --- | --- |
| `list(options)` | Lectura paginada; `options.withDeleted` incluye las filas borradas lógicamente, `options.query` alimenta `buildWhere` |
| `getOne(id)` | `null` si no está — el controlador lo convierte en un 404, así el servicio se mantiene ajeno a HTTP |
| `create(input)` | Inserta y mapea al DTO |
| `update(id, input)` | |
| `softDelete(id)` | |
| `buildWhere(query)` | Hook protegido: parámetros de consulta → `WhereFilter<T>` |
| `mapper` | `EntityMapper<TEntity, TDto>` — entidad ↔ DTO en un solo sitio |

El servicio no sabe nada de HTTP: devuelve `null`, no un 404, y lanza `AppError`,
no una respuesta. Eso es lo que permite que el mismo servicio respalde un comando
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
