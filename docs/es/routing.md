# Rutas decoradas y OpenAPI

> 🇬🇧 [Read in English](../en/routing.md) · paquete: `monolite-http`

Un controlador declara sus propias rutas. De esa única declaración salen **tres**
cosas a la vez: el enrutado de Express, la validación de la petición y el documento
OpenAPI. No se escriben por separado y no pueden discrepar entre sí.

---

## Cómo se ve

```ts
@ApiController("/users", { tag: "Users", token: TOKENS.IUsersController })
export class UsersController extends BaseController {
  constructor(private readonly users: IUsersService, context: IRequestContext) {
    super(context);
  }

  @Get("/", {
    summary: "Listado paginado de usuarios",
    query: paginationSchema,
    responses: { 200: { ref: "PaginatedUsers" } },
  })
  public getAll = async (req: Request, res: Response, next: NextFunction) => {
    // ...
  };

  @Post("/", {
    summary: "Crea un usuario",
    body: createUserSchema,
    responses: { 201: { ref: "User" }, 400: "Error de validación" },
  })
  public create = async (req: Request, res: Response, next: NextFunction) => {
    // ...
  };
}
```

El montaje es genérico, nada por módulo:

```ts
for (const [type, metadata] of registeredControllers()) {
  registerController(router, type, container.resolve(metadata.token), authGuard);
}
```

Lo único que hace falta es que la clase se **cargue**, y de eso se encarga su
`import`. Un controlador en un archivo que nadie importa no existe, porque el
decorador nunca se ejecuta.

---

## Los decoradores

| Decorador | Qué declara |
| --- | --- |
| `@ApiController(prefix, { tag, token })` | Prefijo de ruta, la etiqueta de OpenAPI y el token con el que el contenedor resuelve la instancia |
| `@Get` `@Post` `@Put` `@Patch` `@Delete` | Verbo y camino, relativo al prefijo |

Opciones de una ruta:

| Opción | Efecto en el enrutado | Efecto en el documento |
| --- | --- | --- |
| `body` | Monta `validateBody(schema)` | `requestBody` a partir del JSON Schema del validador |
| `requestBody` | — | Un cuerpo que no es JSON, descrito a mano: por ejemplo una subida `multipart/form-data` |
| `query` | Monta `validateQuery(schema)` | Un `parameter` por propiedad del esquema |
| `params` | — | Un `parameter` de ruta obligatorio por entrada |
| `public: true` | **No** monta la guarda de autenticación | Omite `security` y el 401 automático |
| `use` | Middlewares extra, después de la validación | — |
| `summary` / `description` | — | Lo que lee quien mira la documentación |
| `responses` | — | Códigos, su descripción y su cuerpo (`ref` a un componente, o `schema` de Zod) |

Un 4xx o 5xx que no declare cuerpo referencia el componente `ErrorResponse`, que es
el sobre que devuelve de verdad el manejador global de errores. Así el cliente ve
en la documentación el `code` estable sobre el que ramificar y el `requestId` que
citar a soporte.

La cadena que se monta es siempre la misma, y en este orden:

```
guarda de autenticación  →  validación  →  tus middlewares  →  manejador
```

La validación va **después** de la guarda a propósito: a quien no está autenticado
no se le cuenta qué campos espera el endpoint.

---

## Dos detalles que conviene saber

**Las rutas se declaran sobre propiedades, no sobre métodos.** Los manejadores se
escriben como propiedades de tipo función flecha (`public getAll = async (req, res,
next) => {}`), lo que ata `this` sin `.bind()` — necesario porque Express invoca el
manejador desligado de su objeto. Un decorador de propiedad recibe el prototipo y
el nombre, que es cuanto necesita el registro; el manejador se toma después de la
instancia.

**El orden lo decide la especificidad, no la posición en el código.** Las rutas se
montan de más concreta a más genérica: `/users/stats` gana a `/users/:id` aunque se
declare después. A igualdad se conserva el orden de declaración.

La regla anterior era "gana el orden del código", y funcionaba justo hasta que
dejaba de hacerlo: bastaba mover un método para que una ruta estática dejara de
alcanzarse, y el síntoma era un confuso `400 id inválido` en vez de un error claro.
Ordenar por especificidad elimina ese modo de fallo por completo, y es además lo
que permite que una clase base declare `/:id` sin tapar lo que añada quien la
extienda — que es exactamente en lo que se apoya [`@Crud()`](crud.md).

Lo que sí es un error se detecta al arrancar: dos rutas con el mismo verbo y el
mismo camino lanzan, en vez de que la segunda quede muerta en silencio.

---

## Por qué el documento sale del esquema

En la plantilla de la que salió esto, el bloque de comentario `@openapi` de un
archivo de rutas era entre el **71 % y el 77 %** de sus líneas, y repetía a mano lo
que el validador de Zod ya decía. Nada obligaba a que coincidieran: en cuanto uno
cambiaba, el otro mentía en silencio.

Ahora `parameters` y `requestBody` se generan con `z.toJSONSchema()` sobre el mismo
esquema que valida la petición. Si el validador dice que `limit` llega hasta 100,
eso es lo que documenta, porque es literalmente el mismo objeto.

Tres decisiones técnicas detrás:

- **Se genera en modo `input`.** La documentación describe lo que manda el cliente,
  no lo que el validador devuelve tras sus `.transform()`. Es además el único modo
  que funciona con esquemas que transforman —varios esquemas de query convierten la
  cadena de la URL a número—, porque el modo de salida falla directamente con
  `Transforms cannot be represented in JSON Schema`.
- **El documento es OpenAPI 3.1, no 3.0.** El objeto de esquema de 3.1 *es* JSON
  Schema 2020-12, que es justo lo que emite Zod. Apuntar a 3.0 obligaría a traducir
  cada esquema a sus diferencias (`nullable`, `exclusiveMinimum` booleano…), que es
  la clase de código que este diseño existe para borrar. Swagger UI y Scalar
  soportan 3.1.
- **El 401 no se escribe en cada ruta.** Lo pone la guarda, así que lo pone también
  el generador en toda ruta que no esté marcada como `public`.

---

## Los DTOs también se declaran una vez

```ts
export const userDto = defineDto("User", z.object({
  pkUser: z.number().int(),
  name: z.string(),
  email: z.email(),
}));

export type UserDto = z.infer<typeof userDto>;

export const paginatedUsersDto = definePagedDto("PaginatedUsers", userDto);
```

`defineDto` publica el componente de OpenAPI y `z.infer` da el tipo de TypeScript.
Antes esto era una interfaz más un bloque `@openapi` que la repetía en YAML, sin
nada que mantuviera los dos al mismo paso.

`definePagedDto` envuelve un DTO en la respuesta paginada de la casa, referenciando
el esquema del elemento en vez de copiarlo dentro.

**La trampa:** un DTO se registra cuando su módulo se **carga**, y el resto del
código importa los DTOs como *tipos*, que TypeScript borra al compilar. Por eso los
proyectos generados traen un barril `dtos/index.ts` y por eso el constructor del
documento lo importa. Un DTO que falte en el barril falta en la documentación, y el
fallo es silencioso.

---

## Añadir un módulo

1. Decora su controlador con `@ApiController("/loquesea", { tag, token })` y cada
   manejador con su verbo.
2. Declara sus DTOs con `defineDto` y añádelos al barril.
3. Añade una línea de `import` donde se recogen los controladores: eso es lo que
   ejecuta los decoradores y mete la clase en el registro.

Nada más: ni archivo de rutas, ni archivo de documentación, ni tabla de módulos.

---

## Lo que esto no resuelve

El controlador sigue teniendo su `try/catch` y su `Number(req.params.id)` en cada
manejador, y en un módulo sin reglas el servicio sigue siendo un pase a través del
repositorio. Eso es otra clase de repetición, y se ataca con una capa de CRUD
genérico por encima del repositorio genérico —ver [crud.md](crud.md)— no con más
decoradores.
