# Referencia de la CLI

> 🇬🇧 [Read in English](../en/cli.md) · paquete: `monolite-cli`

```bash
npm install -g monolite-cli
monolite new mi-api
```

La CLI **no tiene dependencias en runtime**. Las banderas se parsean con el
`util.parseArgs` que trae Node, las preguntas se construyen sobre
`readline/promises`, y el color es ANSI en crudo que se apaga solo cuando
`NO_COLOR` está puesto o la salida no es una terminal. Un generador que se
descarga un árbol de dependencias para hacer cuatro preguntas tiene las
prioridades al revés.

---

## `monolite new [nombre]`

Alias: `monolite init`.

Interactivo por defecto. Cada pregunta tiene su bandera, y una pregunta cuya
bandera se dio no se hace. `--yes` responde todas con sus valores por defecto y no
pregunta nada: eso es lo que hace el comando usable desde CI.

```bash
monolite new billing-api
monolite new billing-api --database=postgres --auth --example --yes
monolite new chica --database=none --no-auth --no-example --yes --skip-install --skip-git
```

### Proyecto

| Bandera | Por defecto | Efecto |
| --- | --- | --- |
| `nombre` (posicional) | el nombre del directorio destino | `name` del `package.json`, título del README |
| `--directory=<ruta>` | `./<nombre>` | Dónde escribir |
| `--project-version=<v>` | `0.1.0` | La versión del `package.json` generado |
| `--description=<texto>` | — | `package.json` y subtítulo del README |
| `--author=<nombre>` | — | `package.json` |
| `--license=<id>` | `MIT` | Identificador SPDX |
| `--api-prefix=<ruta>` | `/api/v1` | Dónde se montan los controladores |

### Base de datos

| Bandera | Por defecto | Efecto |
| --- | --- | --- |
| `--database=<motor>` | `postgres` | Ver la tabla de abajo |
| `--db-host=<host>` | `localhost` | |
| `--db-port=<puerto>` | el del motor | Coincide con el `docker-compose.yml` generado |
| `--db-name=<nombre>` | | La base de datos; en Oracle, el nombre del servicio |
| `--db-user=<usuario>` | | El usuario de la aplicación |

Motores aceptados, con sus alias:

| Familia | Valores |
| --- | --- |
| Ninguna | `none`, `memory`, `in-memory`, `inmemory`, `dummy` |
| SQL | `oracle`/`oracledb`, `sqlserver`/`sql-server`/`mssql`, `postgres`/`postgresql`/`pg`, `mysql`/`mariadb` |
| NoSQL | `mongo`/`mongodb` |

**No hay `--db-password`, y es a propósito.** Una contraseña pasada por línea de
comandos acaba en un archivo que se commitea, y de paso en el historial del shell.
`.env.example` trae un marcador de posición y el resumen final dice dónde poner el
valor real.

### Contenido

| Bandera | Por defecto | Efecto |
| --- | --- | --- |
| `--auth` / `--no-auth` | sí | Añade `monolite-auth`, un módulo de login y una guarda |
| `--example` / `--no-example` | sí | Un módulo CRUD de ejemplo, de punta a punta |
| `--docs=<lector>` | `swagger` | Qué lector se monta sobre el documento OpenAPI |

El documento en sí nunca es opcional: se construye a partir de los mismos
metadatos de decorador que produjeron las rutas, así que publicarlo no cuesta
nada y no puede desviarse de la implementación. `--docs` elige qué se monta —si
es que se monta algo— para leerlo.

| `--docs` | Monta | Notas |
| --- | --- | --- |
| `swagger` | Swagger UI en `/docs` | Trae sus propios recursos, así que funciona sin conexión |
| `scalar` | Scalar en `/docs` | Carga el lector de un CDN; apunta `cdn` a una copia local si no hay salida a internet |
| `both` | Swagger UI en `/docs` y Scalar en `/reference` | Dos páginas sobre un documento; lo piden en vez de llevar una copia |
| `none` | nada | `/openapi.json` se sigue sirviendo |

Los dos lectores apuntan a `/openapi.json` en vez de recibir el documento, para
que haya una sola fuente. `DOCS_ENABLED` gobierna todo esto y está encendido
fuera de producción: el documento describe la superficie entera de la API,
reglas de validación incluidas.

### Después

| Bandera | Por defecto | Efecto |
| --- | --- | --- |
| `--pm=<npm\|pnpm\|yarn>` | `npm` | Qué lockfile y qué comando de instalación |
| `--install` / `--skip-install` | instalar | |
| `--git` / `--skip-git` | iniciar | |
| `--force` | no | Escribir en un directorio que no está vacío |
| `-y`, `--yes` | | Tomar todos los valores por defecto, no preguntar nada |

El generador se niega a escribir en un directorio no vacío sin `--force`, e imprime
todos los archivos que creó y los siguientes pasos.

---

## Lo que obtienes

```
mi-api/
├── .editorconfig
├── .env.example              marcadores, nunca un secreto real
├── .gitignore
├── docker-compose.yml        sólo el motor elegido — ausente con memoria
├── eslint.config.mjs
├── jest.config.js
├── package.json              sólo el driver que el motor necesita
├── tsconfig.json
├── README.md
├── src/
│   ├── main.ts               arranque y el apagado ordenado de cuatro pasos
│   ├── server.ts             la cadena de middlewares y dónde se montan los controladores
│   ├── composition/          el contenedor y la tabla de tokens
│   ├── config/env.ts
│   ├── infrastructure/
│   │   ├── logger.ts
│   │   └── persistence/data-source.ts   el cableado propio del motor
│   ├── composition/modules.ts        la única lista a la que se añade un módulo
│   └── presentation/routes.ts           monta todos los controladores decorados
└── tests/smoke.test.ts       pasa a la primera
```

El proyecto compila y su suite de pruebas pasa antes de que escribas una línea. Ese
es el contrato al que la CLI se somete, y CI lo comprueba en cada push generando dos
proyectos y ejecutándolos.

---

## `monolite generate <schematic> <nombre>`

Alias: `monolite g`.

```bash
monolite generate module invoice
monolite g entity payment-method
monolite g query revenue --over invoice
```

| Schematic | Qué escribe |
| --- | --- |
| `module` | Entidad + registro del almacén + servicio + controlador, cableados con `@Crud` |
| `entity` | La interfaz de dominio y su mapeo a tabla |
| `service` | Una subclase de `CrudService` para una entidad existente |
| `controller` | Una subclase de `CrudController` para un servicio existente |
| `query` | Repositorio + servicio + DTO + controlador, para lo que la API genérica no expresa |

### `generate query`

Las agregaciones, los `GROUP BY`, las vistas y los procedimientos almacenados
quedan fuera de la API genérica a propósito: expresarlos la convertiría en un
ORM. Lo que se escribe en su lugar son cuatro ficheros: una interfaz propia y
pequeña, una implementación sobre `executeRaw`, un servicio y un controlador.

```bash
monolite g query revenue --over invoice
```

```
src/infrastructure/persistence/revenue.repository.ts   interfaz + implementación
src/application/dtos/revenue.dto.ts                    la forma publicada
src/application/services/revenue.service.ts            filas -> DTO
src/presentation/controllers/revenue.controller.ts     inyecta el servicio
src/composition/modules/revenue.tokens.ts              sus tres identificadores
src/composition/modules/revenue.module.ts              sus bindings, sin registro
```

`--over` es obligatorio y nombra la entidad que la consulta lee: es lo único que
no se puede derivar del nombre que escribiste. El repositorio generado inyecta
el almacén de esa entidad, lo estrecha con `asRawQueryable` y trae ya el camino
alternativo en proceso para los drivers que no tienen SQL —que es justo la rama
que ejercita la suite generada—.

El módulo que escribe **no lleva registro**, porque una consulta no tiene tabla
propia. Aun así entra en `composition/modules.ts` como todo lo demás, que es la
razón de que se pueda generar siquiera.

El agregado que calcula —cuántas filas hay, el id más bajo y el más alto— es un
marcador de posición, cierto en cualquier tabla, para que el módulo responda
antes de que escribas una línea. Sustitúyelo. Lo que merece la pena conservar es
la forma que lo rodea: binds en vez de concatenación, nombres de columna sacados
del mapeo y un controlador que habla con el servicio.

Eso último es la razón de ser de este schematic. Todo módulo `@Crud` mantiene
bien las capas sin que nadie piense en ello, porque `CrudController` recibe un
`ICrudService` y no acepta otra cosa. Una consulta es el único sitio de un
proyecto monolite donde los cuatro ficheros se escriben desde cero, así que es el
único donde la regla se puede romper —ver [arquitectura](architecture.md)—.

### Cableado

Un módulo generado se añade a una lista, y el generador lo añade:

```
i Wired into src/composition/modules.ts:
    import { INVOICE_MODULE } from "./modules/invoice.module";
    INVOICE_MODULE,
```

Esa lista es `composition/modules.ts`, y es la única. Antes un módulo se añadía
en tres sitios —su registro a `entities.ts`, sus bindings a `container.ts`, un
import a `routes.ts`—, ninguno de ellos una decisión, y olvidar cualquiera dejaba
un módulo que compila perfectamente y no se sirve nunca.

Lo que hacía imposible automatizar con seguridad la versión de tres ficheros no
era la edición: era que las ediciones estaban repartidas. Un `MonoliteModule`
lleva juntos el registro, los bindings y el controlador, así que cablear es una
línea en un fichero — y una línea en un fichero es lo bastante pequeño como para
que un generador la inserte y alguien la revise.

El registro es opcional. Un módulo que no tiene tabla propia —un informe que lee
tres entidades que ya existen, una búsqueda sobre varias, un panel, un proceso de
importación, un receptor de webhooks— lo omite y entra en la misma lista, que es
justo el objetivo: la alternativa era un segundo sitio donde registrar cosas, y un
segundo sitio es el problema que esta lista resolvió.

El permiso para escribir viene de un marcador. `composition/modules.ts` se
genera con `// monolite:modules` dentro y la entrada va justo encima. Mueve ese
marcador, renómbralo o bórralo y no se toca nada: el comando te imprime la línea,
que es lo que siempre hizo. `--no-wire` dice lo mismo a propósito.

No hay AST de por medio, y es deliberado: la CLI **no tiene dependencias en
runtime**, y meter el compilador de TypeScript para añadir una línea a un arreglo
gastaría esa promesa en la edición más barata del proyecto.

El proyecto se localiza subiendo desde el directorio actual en busca de una clave
`monolite` en el `package.json`, así que el comando funciona desde cualquier
subdirectorio — y **se niega a ejecutarse fuera de un proyecto** en vez de esparcir
archivos por la carpeta en la que te encuentres.

`--force` sobreescribe archivos que ya existen. Sin ella, un archivo existente se
deja intacto y se informa.

---

## Opciones globales

| Bandera | Efecto |
| --- | --- |
| `-v`, `--version` | Imprime la versión de la CLI |
| `-h`, `--help` | Muestra la ayuda; `monolite help <comando>` para un comando |
| `--no-color` | Desactiva el color ANSI. `NO_COLOR` también se respeta |

---

## Plantillas

Las plantillas viven en `packages/cli/templates/` como archivos de verdad, y se
renderizan sustituyendo marcadores `__placeholder__` tanto en el contenido como en
los nombres de archivo, y seleccionando por directorio (`templates/base/`,
`templates/db/<motor>/`, `templates/auth/`, `templates/example/`). Un renderizador
diminuto gana a un motor de plantillas: así las plantillas se siguen leyendo como
los archivos en los que se van a convertir.

Dos convenciones que conviene conocer si las editas:

- **`gitignore`, no `.gitignore`.** npm renombra un `.gitignore` empaquetado a
  `.npmignore`, así que la plantilla nunca llegaría al tarball con su propio
  nombre. El renderizador le devuelve el punto al escribirla.
- **Las plantillas quedan fuera del typecheck y del lint de este repositorio.** Son
  TypeScript para el proyecto *generado*: importan paquetes `monolite-*` que aquí
  no son dependencias, y contienen marcadores que no son sintaxis válida hasta que
  se renderizan.
