# Primeros pasos

> 🇬🇧 [Read in English](../en/getting-started.md)

Dos formas de entrar: dejar que la CLI genere un proyecto, o añadir un paquete a
algo que ya tienes. Las dos están soportadas; ninguna es el camino menor.

---

## Requisitos

- **Node.js 20 o superior.** Los paquetes usan `AsyncLocalStorage`, `parseArgs` de
  `node:util` y `structuredClone` sin polyfills.
- **npm 10+**, pnpm o yarn. El propio monorepo usa workspaces de npm.
- Una base de datos, si la quieres. Todos los motores son opcionales; el driver de
  memoria no necesita nada instalado.

---

## Camino A — generar un proyecto nuevo

```bash
npm install -g monolite-cli
monolite new mi-api
```

La CLI pregunta, en este orden:

| Pregunta | Por defecto | Qué cambia |
| --- | --- | --- |
| Nombre del proyecto | el argumento del directorio | el `name` del `package.json`, el título del README |
| Versión | `0.1.0` | `package.json` |
| Descripción / autor / licencia | — / — / MIT | `package.json`, `LICENSE` |
| Familia de base de datos | SQL | cuáles de las siguientes preguntas ves |
| Motor | PostgreSQL | la dependencia del driver, el servicio de docker, el dialecto SQL, el esquema semilla |
| Datos de conexión | valores por motor | `.env.example` (nunca una contraseña real) |
| Autenticación | sí | añade `monolite-auth`, un módulo de login y una guarda en las rutas de ejemplo |
| Módulo CRUD de ejemplo | sí | una entidad de punta a punta, para que el patrón se vea |
| Prefijo de la API | `/api/v1` | `API_PREFIX` en el entorno |
| Gestor de paquetes | npm | el lockfile y el comando de instalación que ejecuta |
| Iniciar git / instalar ya | sí / sí | si te deja listo para arrancar |

Después:

```bash
cd mi-api
cp .env.example .env      # pon la contraseña
npm run dev
```

`GET /health/ready` responde en cuanto la base de datos es alcanzable. El documento
OpenAPI está en `/docs` (Scalar) y `/swagger` (Swagger UI), los dos generados a
partir de los decoradores de ruta.

### Sin preguntas

Cada respuesta tiene su bandera, y `--yes` acepta los valores por defecto de lo que
no indiques:

```bash
monolite new mi-api --database=postgres --auth --example --yes
monolite new api-chica --database=none --no-auth --yes --skip-install --skip-git
```

La lista completa de banderas está en la [referencia de la CLI](cli.md).

---

## Camino B — añadir un paquete a una aplicación existente

Los paquetes no se necesitan entre sí más allá de sus dependencias declaradas, y
ninguno necesita la CLI.

### Sólo la capa de datos

```bash
npm install monolite-core monolite-data pg
```

```ts
import { EntitySchema, SqlGenericRepository, postgresDialect } from "monolite-data";

const USERS = {
  table: "USERS",
  key: { property: "pkUser", column: "PK_USER" },
  columns: { name: "NAME", email: "EMAIL", isActive: "IS_ACTIVE" },
  softDelete: { column: "IS_DELETED" },
  audit: { createdBy: "CREATED_BY", updatedBy: "UPDATED_BY" },
} as const;

const users = new SqlGenericRepository<User>(executor, USERS, logger, postgresDialect);

await users.getAll({
  where: { isActive: true, name: { contains: search } },
  orderBy: { field: "name" },
  page: { number: 1, size: 20 },
});
```

Pasarse a MySQL más adelante es `postgresDialect` → `mysqlDialect` más la cadena de
conexión. Pasarse a MongoDB es `SqlGenericRepository` → `MongoGenericRepository`; el
filtro de arriba no cambia, porque compila a un documento de consulta en vez de a
SQL.

### Sólo el ruteo y OpenAPI

```bash
npm install monolite-core monolite-http express zod
```

```ts
import { ApiController, Get, buildOpenApiDocument, registerController } from "monolite-http";

@ApiController("/reports", { tag: "Reports" })
export class ReportsController {
  @Get("/:id", { params: idParamSchema })
  getOne = async (req, res) => res.json(await load(req.params.id));
}
```

`registerController` lo monta en un router de Express; `buildOpenApiDocument`
convierte esos mismos metadatos en el spec. Tú conservas tu `app`, tu arranque y
todo lo demás.

### Sólo los errores y la identidad de la petición

`monolite-core` no tiene ninguna dependencia, así que se puede adoptar aislado por
`AppError` + `normalizeError` + el contexto de petición con `AsyncLocalStorage`,
incluso en un proyecto que nunca vaya a usar el resto.

---

## Configuración

Los proyectos generados leen la configuración del entorno. Los nombres que
importan:

| Variable | Por defecto | Notas |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` oculta los stack traces y apaga el log de SQL |
| `PORT` | `3000` | |
| `API_PREFIX` | `/api/v1` | Dónde se montan los controladores |
| `API_LEGACY_PREFIX` | — | Un segundo punto de montaje durante una migración de versión; `off` lo desactiva |
| `DATA_SOURCE` | `memory` | `memory` \| `oracle` \| `mssql` \| `postgres` \| `mysql` \| `mongo` |
| `LOG_DRIVER` | `pino` | `pino` \| `winston` |
| `LOG_LEVEL` | `debug` en desarrollo | |
| `CORS_ORIGINS` | — | Lista blanca separada por comas. `*` permite todo: no lo uses en producción con credenciales |
| `CSP_ENABLED` | `false` | Apagado por defecto porque una Content-Security-Policy pensada para una app HTML rompe las UIs de documentación de una API |
| `RATE_LIMIT_MAX` | valor del motor | `0` desactiva el limitador por completo |
| `TRUST_PROXY` | `0` | Un **número** de saltos. `true` hace que cualquier cliente pueda falsear su IP |
| `BODY_LIMIT` | `1mb` | |
| `DOCS_ENABLED` | encendido fuera de producción | |
| `SHUTDOWN_DELAY_MS` | `5000` | Cuánto tiempo la disponibilidad sigue en falso antes de dejar de aceptar |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Perro guardián; el proceso sale aunque una conexión no drene |

`TRUST_PROXY` merece el énfasis. Ponerlo a `true` le dice a Express que se crea la
primera entrada de `X-Forwarded-For`, que cualquier cliente puede escribir: eso
vuelve trivialmente esquivable el limitador de peticiones y convierte en ficción
cada IP registrada. Ponlo al número de proxies que realmente tienes delante.

---

## Apagado ordenado

`SIGTERM` ejecuta cuatro pasos, en este orden, y el orden es justamente el punto:

1. `healthProbe.beginShutdown()` — la disponibilidad pasa a falso de inmediato,
   para que el balanceador deje de mandar trabajo nuevo.
2. Esperar `SHUTDOWN_DELAY_MS`. El balanceador necesita tiempo para darse cuenta;
   cerrar el listener ahora rechazaría peticiones que ya venían encaminadas aquí.
3. `server.close()` más `closeIdleConnections()` — dejar de aceptar, permitir que
   terminen las peticiones en vuelo, y soltar los sockets keep-alive que están
   ociosos en vez de esperar a que expiren.
4. Cerrar las conexiones de base de datos y salir.

Un perro guardián de `SHUTDOWN_TIMEOUT_MS` fuerza la salida si el paso 3 o el 4 se
cuelgan, porque un pod que no se muere es peor que uno que se muere de mala manera.

---

## Siguiente

- [Arquitectura](architecture.md) — cómo encajan los paquetes y qué cuesta el diseño
- [Acceso a datos](data-access.md) — el contrato de repositorio a fondo
- [Rutas decoradas y OpenAPI](routing.md)
- [CRUD genérico](crud.md)
- [Pruebas](testing.md)
