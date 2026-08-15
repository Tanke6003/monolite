# Referencia de la CLI

> 🇬🇧 [Read in English](../en/cli.md) · paquete: `@monolite/cli`

```bash
npm install -g @monolite/cli
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
| `--auth` / `--no-auth` | sí | Añade `@monolite/auth`, un módulo de login y una guarda |
| `--example` / `--no-example` | sí | Un módulo CRUD de ejemplo, de punta a punta |

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
│   └── presentation/routes.ts           los imports que ejecutan los decoradores
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
```

| Schematic | Qué escribe |
| --- | --- |
| `module` | Entidad + registro del almacén + servicio + controlador, cableados con `@Crud` |
| `entity` | La interfaz de dominio y su mapeo a tabla |
| `service` | Una subclase de `CrudService` para una entidad existente |
| `controller` | Una subclase de `CrudController` para un servicio existente |

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
  TypeScript para el proyecto *generado*: importan paquetes `@monolite/*` que aquí
  no son dependencias, y contienen marcadores que no son sintaxis válida hasta que
  se renderizan.
