# Arquitectura

> 🇬🇧 [Read in English](../en/architecture.md)

Monolite es un conjunto de paquetes, no un monolito con sistema de plugins. Este
documento explica cómo encajan entre sí, de qué puede depender cada uno y por qué
las fronteras están donde están.

---

## El grafo de dependencias

```
                         ┌──────────────┐
                         │     core     │   errores, contratos de logger y de
                         │ (0 deps en   │   contexto, identidad de la petición
                         │  runtime)    │   con AsyncLocalStorage, sondeo de salud
                         └──────┬───────┘
                   ┌────────────┼────────────┐
                   ▼            ▼            ▼
            ┌───────────┐ ┌──────────┐ ┌──────────┐
            │   data    │ │   http   │ │    di    │
            │ 6 motores │ │ express  │ │ tsyringe │
            └─────┬─────┘ └────┬─────┘ └──────────┘
                  │            │
                  └─────┬──────┘
                        ▼
                  ┌───────────┐      ┌──────────┐
                  │   crud    │      │   auth   │
                  └───────────┘      └──────────┘

            ┌───────────┐
            │    cli    │   no depende de nada; escribe proyectos que usan el resto
            └───────────┘
```

Tres reglas mantienen esto honesto:

1. **`core` no depende de nada.** Ni de Express, ni de un driver, ni de un
   contenedor. Es el vocabulario en el que los demás paquetes se ponen de acuerdo,
   y un paquete con dependencias no puede ser eso.
2. **Ningún paquete depende de `di`.** El contenedor es una hoja. Todos los demás
   reciben sus colaboradores por el constructor, así que quien prefiera Awilix,
   InversifyJS o un `new` a secas nunca instala tsyringe.
3. **Los drivers de base de datos son peer dependencies opcionales.**
   `monolite-data` declara los seis, todos opcionales. Un proyecto con PostgreSQL
   no se descarga el cliente de Oracle.

---

## Capas dentro de un proyecto generado

Los paquetes implementan la maquinaria; un proyecto construido sobre ellos sigue
siendo Clean Architecture, y la CLI genera exactamente esta forma:

```
┌─────────────────────────────────────────────────────┐
│  Presentación   controladores, middlewares          │  ← monolite-http
├─────────────────────────────────────────────────────┤
│  Aplicación     servicios, DTOs, casos de uso       │  ← monolite-crud
├─────────────────────────────────────────────────────┤
│  Dominio        interfaces y modelos, sin imports   │  ← sólo tu código
├─────────────────────────────────────────────────────┤
│  Infraestructura repositorios, conectores, plugins  │  ← monolite-data
└─────────────────────────────────────────────────────┘
```

La regla de dependencia no cambia: las capas de dentro no saben nada de las de
fuera. Lo que aportan los paquetes es que ahora las capas de fuera vienen *dadas*
en vez de escritas. Tus modelos de dominio y tus reglas de negocio siguen siendo
tuyos.

### Un controlador habla con un servicio, nunca con un repositorio

La regla de dependencia va de *dirección*, y un controlador que se salta la capa
de aplicación para llegar a infraestructura la cumple tal y como está escrita
—por eso hace falta decir esto aparte—.

En el hueco que se salta viven dos decisiones: **qué puede ver un cliente** y
**qué significa la respuesta**. Un repositorio sabe contar filas. No sabe cuáles
merecen publicarse, en qué orden ni cuántas; y un controlador que respondiera con
filas estaría tomando las dos decisiones en la capa más lejana a ambas.

Casi siempre no hay nada que recordar, porque no hay nada que se pueda romper:
`CrudController` recibe un `ICrudService` y no acepta otra cosa, así que todo
módulo `@Crud` tiene la forma correcta se piense en ella o no. La regla solo
sostiene algo en el único caso en el que los cuatro ficheros se escriben desde
cero: un informe, una búsqueda sobre varias tablas, un panel. Para eso está
`monolite generate query`, que los escribe ya con las capas en su sitio.

---

## Ciclo de vida de una petición

```
Petición HTTP
    │
    ▼
Cadena de middlewares                                     monolite-http
    │  x-powered-by off → trust proxy → contexto de petición →
    │  helmet → rate limit → cors → parseo del body → log http → static
    │
    ▼
Router construido a partir de los decoradores             monolite-http
    │  guarda de autenticación, luego validación Zod de body/query/params
    ▼
Controlador                                               tuyo, o monolite-crud
    │  lee la petición, llama al servicio
    ▼
Servicio                                                  tuyo, o monolite-crud
    │  reglas de negocio. Abre una transacción con @Transactional()
    │  cuando el caso de uso escribe en más de un sitio
    ▼
Repositorio                                               tuyo (fino) + monolite-data
    │  registra, envuelve los errores del driver, delega
    ▼
Repositorio genérico — SQL, MongoDB o memoria             monolite-data
    │  construye la consulta desde el mapeo de la entidad; todo valor va como bind
    ▼
Respuesta, o un error por el único manejador de errores
```

Dos cosas viajan *fuera* de esta cadena, las dos por `AsyncLocalStorage`:

- **La identidad de la petición** (`IRequestContext`, en `core`). El controlador la
  quiere para autorizar, el repositorio para las columnas de auditoría, el
  manejador de errores para el log. Enhebrar un parámetro `user` por cuatro capas
  ensuciaría todas las firmas.
- **La transacción abierta** (`ITransactionContext`, en `data`). Un repositorio se
  suma a la transacción ambiental en vez de recibir una conexión, y eso es lo que
  permite que `@Transactional()` sea un decorador de una línea.

Las dos son el mismo truco y tienen el mismo requisito: el almacén tiene que ser un
singleton, porque el middleware que lo abre y el repositorio que lo lee deben estar
mirando el mismo.

---

## `monolite-core` — el vocabulario

Todo lo que está aquí existe para que los demás paquetes puedan hablar de los
mismos conceptos sin depender unos de otros.

| Export | Por qué está en core |
| --- | --- |
| `AppError` | Todos los paquetes lo lanzan; sólo la capa HTTP lo renderiza. |
| `normalizeError` | Convierte cualquier cosa lanzada en un estado más un `code` estable. Vive aquí porque `data` necesita clasificar errores de driver y `http` necesita renderizarlos. |
| `ILogger` | Un contrato de cuatro métodos, para que ningún paquete dependa de pino o winston. |
| `IRequestContext`, `CurrentUser`, `AsyncRequestContext` | Identidad de la petición. `SYSTEM_USER` es el valor fuera de una petición: seeds, arranque, trabajos programados. |
| `IHealthProbe`, `HealthProbe` | Disponibilidad con caché y tiempo de espera, y un `beginShutdown()` que voltea la disponibilidad antes de que el proceso deje de aceptar trabajo. |

### Manejo de errores

Todo fallo, de cualquier capa, sale por la misma puerta y produce el mismo sobre:

```json
{
  "status": "error",
  "code": "APPOINTMENT_OVERLAP",
  "message": "La sucursal ya tiene la cita #5 en ese horario",
  "requestId": "407215bc-e453-4dcf-ac2f-37a1e88109c2",
  "timestamp": "2026-08-09T03:09:29.264Z",
  "path": "/api/v1/appointments",
  "method": "POST",
  "errors": [{ "field": "name", "message": "El nombre es obligatorio" }]
}
```

- `code` es estable y está pensado para que el cliente ramifique sobre él;
  `message` es para personas y puede reescribirse en cualquier momento.
- `stack` y `causes` se añaden **sólo fuera de producción**: son lo más útil para
  depurar y lo más peligroso de publicar.
- Un 5xx marcado como no operacional siempre responde `"Internal server error"`,
  esté donde esté. Ocultar el detalle de un fallo que el código no anticipó es la
  regla, no una cortesía de producción. Un error operacional conserva su mensaje
  incluso en un 500, porque alguien escribió ese mensaje *para* el cliente.
- `requestId` sale en `X-Request-Id` y entra en cada línea de log de la petición,
  así que la captura de pantalla de un usuario basta para encontrar la traza.

`AppError` recibe `isOperational` como tercer argumento. `true` significa un
desenlace esperado: se registra como aviso y el mensaje llega al cliente. `false`
marca un bug: se registra como error y se responde de forma genérica.

---

## `monolite-data` — un contrato, seis motores

Este es el paquete que el resto del proyecto existe para hacer posible. El detalle
completo está en [data-access.md](data-access.md); los puntos arquitectónicos son
estos:

**`IGenericRepository<T>` es el único contrato de datos.** Todos los módulos pasan
por él, sea cual sea el motor configurado, así que el CRUD se escribe una vez. Lo
implementan tres drivers: SQL (compartido por cuatro motores), MongoDB y memoria.

**`SqlDialect` es la costura entre los cuatro motores SQL.** La sintaxis de
paginación, la recuperación del identity, el bloqueo de filas y la representación
de los booleanos difieren por motor, y nada más lo hace. Aislar esas diferencias en
un objeto es lo que convierte "vamos a dejar Oracle" en un cambio de configuración
más un archivo, en vez de una reescritura.

**Los filtros son declarativos y se compilan; nunca se concatenan.** El mismo
`WhereFilter<T>` compila a SQL con parámetros ligados, a un documento de consulta
de MongoDB o a un predicado en memoria. Los identificadores sólo llegan al SQL a
través de `columnOf()`, que lanza si la propiedad no está mapeada; los valores
siempre van ligados. Esa es la razón estructural por la que aquí no cabe una
inyección: no es el escapado, es que la entrada del usuario nunca ocupa una
posición de identificador.

**Los metadatos de la entidad son el único mapeo.** Una declaración da el nombre de
la tabla, el mapeo propiedad↔columna, la clave, el borrado lógico, las columnas de
auditoría y el alta en el registro de cambios. Los tres drivers lo leen.

**La unidad de trabajo es por motor pero uniforme por encima.** `execute(work)`
entrega un ámbito cuyos repositorios están atados a la transacción; `lockRow` toma
un bloqueo real de fila en SQL, y degrada con honestidad en el resto.

---

## `monolite-http` — los metadatos son la fuente de verdad

Un controlador declara sus rutas sobre sí mismo:

```ts
@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
export class BranchesController extends BaseController {
  constructor(context: IRequestContext) {
    super(context);
  }

  @Get("/", { query: listQuerySchema })
  list = async (req: Request, res: Response) => { /* ... */ };

  @Post("/", { body: createBranchSchema })
  create = async (req: Request, res: Response) => { /* ... */ };
}
```

Dos consumidores leen esos mismos metadatos: el **constructor de rutas**, que los
convierte en manejadores de Express (guarda → validación → middleware extra →
manejador), y el **constructor de OpenAPI**, que los convierte en paths y
operaciones. Tener una sola fuente significa que la documentación no puede
desviarse de las rutas: la clase de bug en la que el spec dice `PATCH` y el
servidor quiere `PUT` simplemente no puede ocurrir.

Los métodos de ruta son **decoradores de propiedad sobre funciones flecha**, no
decoradores de método. Los manejadores son propiedades de tipo función flecha para
conservar `this` cuando Express los llama sueltos; un decorador de método nunca los
vería.

Las rutas se ordenan por especificidad antes de montarse, así que
`/branches/active` se registra antes que `/branches/:id` sin importar el orden de
declaración, y los duplicados se detectan al arrancar en vez de taparse en
silencio.

### Orden de los middlewares

El orden no es cosmético:

```
disable("x-powered-by")     no anunciar el stack
trust proxy                 un número, nunca `true` — ver security.config
requestContext              primero, para que hasta un body malformado tenga requestId
helmet
rate limit                  /health* exento, para que un sondeo no quede limitado
cors                        lista blanca desde CORS_ORIGINS
express.json / urlencoded   extended: false
logger http
express.static
…rutas…
notFoundHandler             404 en el mismo sobre, código ROUTE_NOT_FOUND
errorHandler                siempre el último
```

`notFoundHandler` y `errorHandler` van **después** de las rutas de documentación.
Un manejador de errores de Express sólo cubre lo que se registró antes que él, y un
manejador de 404 puesto demasiado pronto se traga Swagger.

---

## `monolite-crud` — cinco endpoints, todos sobreescribibles

`@Crud()` registra `list`, `getOne`, `create`, `update` y `softDelete` para una
entidad, cada uno con validación, paginación y su entrada de OpenAPI. El decorador
sólo rellena huecos: declara un método con el mismo nombre y gana el tuyo. Añade
`verbs: ["list", "getOne"]` y registra sólo esos.

`@Transactional()` abre una transacción alrededor de un método de servicio y la
publica en el `ITransactionContext` ambiental, de modo que todo repositorio llamado
dentro se suma sin recibir nada. *Se suma* a una transacción existente en vez de
anidar una segunda.

`lockRow(transactions, entity, id)` es una función suelta y no un método de una
clase base, porque un servicio que la necesite puede ya estar extendiendo otra cosa
y TypeScript no tiene herencia múltiple. Que el bloqueo sea la primera sentencia de
la transacción importa en MySQL, donde REPEATABLE READ fija la foto en la primera
lectura.

---

## `monolite-di` — una hoja a propósito

tsyringe resuelve por token de cadena, lo que significa que una errata en
`@inject("IUsersServcie")` compila sin ruido y sólo revienta cuando esa clase se
construye. `TOKENS` existe para que el compilador la cace antes.

En este paquete sólo viven los tokens *del framework*. Tus tokens de negocio
(`IUsersService`, `IBranchesRepository`) pertenecen a tu aplicación y se registran
desde tus propios archivos de módulo, así que un módulo es un archivo más una línea
en la raíz de composición, y quitarlo es borrar los dos.

Tiempos de vida: los plugins son singletons — el contexto de petición y el de
transacción *tienen* que serlo, por lo dicho arriba. Repositorios, servicios y
controladores son transitorios; no guardan estado entre peticiones.

---

## Lo que cuesta esta arquitectura

Siendo honestos con los compromisos:

- **Un repositorio genérico no es un ORM.** No hay mapeo de relaciones, ni carga
  perezosa, ni migraciones. Los joins son tu SQL, en tu repositorio. Es
  deliberado —en cuanto la abstracción cubre joins deja de ser portable entre seis
  motores— pero es un límite real, no un descuido.
- **Seis motores significa que el contrato es la intersección, no la unión.** Nada
  en `IGenericRepository` puede apoyarse en algo que MongoDB no tenga o que Oracle
  escriba distinto. La potencia específica de cada motor sigue al alcance, pero
  sólo bajando al executor.
- **Los metadatos de los decoradores se descubren al importar.** Un controlador en
  un archivo que nadie importa no existe. Lo mismo vale para el registro de DTOs:
  esta es, con diferencia, la causa más común de "mi endpoint no sale en el
  documento OpenAPI", y la razón de que los proyectos generados traigan un archivo
  barril explícito.
- **Las transacciones ambientales son invisibles en la firma.** `@Transactional()`
  se lee bien pero no aparece en el tipo del método que decora. Ese es el precio de
  no enhebrar un parámetro de transacción por todas las capas, y es un precio.

---

## Ver también

- [Acceso a datos](data-access.md) — el contrato de repositorio, dialectos y filtros
- [Rutas decoradas y OpenAPI](routing.md)
- [CRUD genérico](crud.md)
- [Autenticación](authentication.md)
- [Pruebas](testing.md)
