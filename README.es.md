# Monolite

Un conjunto de herramientas de backend en TypeScript que puedes adoptar paquete a paquete.

> 🇬🇧 [Read in English](./README.md) · 📚 [Índice de documentación](./docs/)

---

Monolite no es un framework que se adueñe de tu `main.ts`. Es un conjunto de
paquetes pequeños que resuelven las partes que la mayoría de plantillas te deja a
ti: un contrato de repositorio que funciona sobre seis motores de base de datos,
un ruteo HTTP que genera su propio documento OpenAPI, un CRUD genérico al que te
apuntas entidad por entidad, y una CLI que arma la combinación por ti.

Cada paquete funciona por su cuenta. Instala el que necesites e ignora el resto.

## Paquetes

| Paquete | Qué es | Depende de |
| --- | --- | --- |
| [`monolite-core`](./packages/core) | Errores, contratos de logger y de contexto de petición, identidad de la petición con `AsyncLocalStorage`, sondeo de salud. Cero dependencias. | — |
| [`monolite-data`](./packages/data) | Un `IGenericRepository<T>` sobre memoria, Oracle, SQL Server, PostgreSQL, MySQL y MongoDB. Unidad de trabajo, dialectos SQL, compiladores de filtros, y el DDL y las migraciones generados desde el mismo mapeo. | `core` |
| [`monolite-http`](./packages/http) | Decoradores `@ApiController` / `@Get` / `@Post`, constructor de rutas, validación con Zod, manejador de errores, valores de seguridad por defecto, generación de OpenAPI 3.1. | `core` |
| [`monolite-crud`](./packages/crud) | `CrudBLL` / `CrudController` genéricos y un decorador `@Crud()`: cinco endpoints por entidad, cada uno sobreescribible. Transacciones ambientales con `@Transactional()`. | `core`, `data`, `http` |
| [`monolite-auth`](./packages/auth) | Autenticación opcional: login, emisión y verificación de JWT, hasheo de contraseñas, guardas `requireAuth` / `requireRoles`. | `core`, `http` |
| [`monolite-di`](./packages/di) | La raíz de composición con tsyringe, separada para que nada más dependa de un contenedor. | `core`, `data` |
| [`monolite-cli`](./packages/cli) | `monolite new` — genera un proyecto y te pregunta qué base de datos quieres. `monolite generate` escribe dentro un módulo, una entidad, una BLL, un controlador, una consulta o un repositorio. Cero dependencias de ejecución. | — |

## Arranque rápido

```bash
npm install -g monolite-cli
monolite new mi-api
```

La CLI pregunta el nombre y la versión del proyecto, si quieres SQL, NoSQL o
ninguna base de datos, qué motor dentro de esa familia, si incluir autenticación y
si generar un módulo de ejemplo. Escribe un proyecto que compila y cuya suite de
pruebas pasa a la primera.

Sin preguntas, para CI:

```bash
monolite new mi-api --database=postgres --auth --example --yes
```

## O usa los paquetes directamente

Una aplicación Express que ya existe puede adoptar un solo paquete. Esto es un
módulo CRUD completo una vez que `monolite-crud` está en su sitio:

```ts
import { Crud } from "monolite-crud";
import { ApiController } from "monolite-http";

@ApiController("/branches", { tag: "Branches", token: BRANCH_TOKENS.controller })
@Crud({ resource: "branch", dto: "Branch", schemas: branchSchemas })
export class BranchesController extends CrudController {
  constructor(bll: BranchesBLL, context: IRequestContext) {
    super(bll, context, "branch");
  }
}
```

Cinco endpoints — listar, obtener uno, crear, actualizar, borrar lógico — con
validación, paginación, mapeo de errores y una entrada de OpenAPI cada uno. Para
sobreescribir cualquiera de ellos declara un método con el mismo nombre; el
decorador sólo rellena los huecos.

## Por qué existe

La mayoría de las plantillas toma una decisión de base de datos por ti y la
entierra en trescientos archivos. `monolite-data` pone todos los motores detrás
del mismo contrato y cada diferencia entre motores detrás de un `SqlDialect`, así
que pasar de Oracle a PostgreSQL es un cambio de configuración más un objeto de
dialecto, no una reescritura. La misma idea guía el resto: el documento OpenAPI se
genera a partir de los metadatos del ruteo en vez de mantenerse al lado, el
esquema de la base de datos se genera desde el mapeo de entidades en vez de
escribirse dos veces, y las transacciones son ambientales en vez de ir enhebradas
por cada firma de método.

Donde la API genérica se detiene, se detiene a propósito y lo dice. Las
agregaciones, las vistas y los procedimientos almacenados van por `executeRaw`
detrás del contrato `IRawQueryable`, y `monolite generate query` /
`generate repository` escriben esa forma con las capas ya en su sitio.

Lee [la guía de arquitectura](./docs/es/architecture.md) para el razonamiento
detrás de cada una de esas decisiones, incluido lo que cuestan.

## Documentación

- [Primeros pasos](./docs/es/getting-started.md)
- [Arquitectura](./docs/es/architecture.md)
- [Acceso a datos](./docs/es/data-access.md)
- [Rutas decoradas y OpenAPI](./docs/es/routing.md)
- [CRUD genérico](./docs/es/crud.md)
- [Autenticación](./docs/es/authentication.md)
- [Referencia de la CLI](./docs/es/cli.md)
- [Pruebas](./docs/es/testing.md)

## Desarrollo

```bash
npm install
npm run build      # tsc --build sobre todos los paquetes
npm run typecheck
npm run lint
npm test
npm run check      # todo lo anterior
```

El repositorio es un workspace de npm. Los paquetes se referencian entre sí con
referencias de proyecto de TypeScript, así que `tsc --build` recompila sólo lo que
cambió.

## Contribuir

Los issues y las pull requests son bienvenidos, y discrepar sobre el diseño más
que nada — los paquetes están llenos de comentarios explicando por qué una
decisión fue por donde fue, y las que se discutieron son la mitad buena.

- [Contribuir](./CONTRIBUTING.es.md) — puesta en marcha, dónde va cada cosa, para
  qué son las pruebas y la convención de commits de la que sale la versión
- [Código de conducta](./CODE_OF_CONDUCT.md) — la única regla que mantiene una
  discusión de diseño en el diseño
- [Seguridad](./SECURITY.md) — no en un issue público

No hace falta una base de datos para contribuir: `npm run check` corre sin nada
instalado, y el driver en memoria es un motor completo. Tocar un driver o un
dialecto sí la necesita, y `npm run engines:up` levanta los cinco.

## Estado

`0.8.0`, y pre-1.0 en lo que importa: los siete paquetes comparten número de
versión y la API pública puede cambiar en una versión menor. Fija versiones
exactas — el changelog recoge cada ruptura con el buscar y reemplazar que
necesita.

Lo que ese número **no** significa es "sin probar". La suite de unidad son 1100
aserciones sobre todos los paquetes; la del scaffold genera cinco proyectos,
comprueba los tipos de cada fichero que escriben y arranca uno para servir
peticiones reales; los ejemplos de la documentación se compilan en CI en los dos
idiomas; y la suite de integración ejecuta el contrato entero del repositorio
contra PostgreSQL, MySQL, SQL Server, Oracle y MongoDB en cada push.

## Licencia

MIT © 2026 Tanke6003
