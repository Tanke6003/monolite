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
│   ├── scripts/              db:sql, db:migration y el runner de tareas
│   ├── tasks/index.ts        la única lista a la que se añade una tarea
│   └── presentation/routes.ts           monta todos los controladores decorados
└── tests/smoke.test.ts       pasa a la primera
```

El proyecto compila y su suite de pruebas pasa antes de que escribas una línea. Ese
es el contrato al que la CLI se somete, y CI lo comprueba en cada push generando dos
proyectos y ejecutándolos.

---

## Los scripts que trae un proyecto

Dos de ellos no van de ejecutar la aplicación, y son la razón de que el scaffold
ya no te diga que te escribas el esquema tú.

| Script | Qué hace |
| --- | --- |
| `npm run db:sql` | `CREATE TABLE` de cada entidad registrada, por dialecto |
| `npm run db:migration -- <nombre>` | Lo que cambió desde la anterior, como un `.sql` con marca de tiempo |
| `npm run task <nombre>` | Ejecuta una tarea de `src/tasks/` — ver [`generate task`](#generate-task) |

```bash
npm run db:sql -- --out db/schema.sql
npm run db:migration -- add-invoice-notes
```

Viven en el proyecto y no en el CLI, y no es casualidad: `monolite-cli` **no
tiene dependencias de ejecución** y por tanto no puede cargar tus entidades. Tu
proyecto ya las tiene. En [acceso a datos](data-access.md) está qué tiene que
decir el mapeo, por qué no hay runner de migraciones y lo único que un diff no
puede ver.

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
| `module` | Entidad + registro del almacén + BLL + controlador, cableados con `@Crud` |
| `entity` | La interfaz de dominio y su mapeo a tabla |
| `bll` | Una subclase de `CrudBLL` para una entidad existente |
| `controller` | Una subclase de `CrudController` para una BLL existente |
| `query` | Repositorio + BLL + DTO + controlador, para lo que la API genérica no expresa |
| `repository` | El almacén de una entidad existente más sus propias consultas, sobre `executeRaw` |
| `task` | Un trabajo que se ejecuta por nombre — lo que invoca un timer, cron o un CronJob |

### `generate query`

Las agregaciones, los `GROUP BY`, las vistas y los procedimientos almacenados
quedan fuera de la API genérica a propósito: expresarlos la convertiría en un
ORM. Lo que se escribe en su lugar son cuatro ficheros: una interfaz propia y
pequeña, una implementación sobre `executeRaw`, una BLL y un controlador.

```bash
monolite g query revenue --over invoice
```

```
src/infrastructure/persistence/revenue.repository.ts   interfaz + implementación
src/application/dtos/revenue.dto.ts                    la forma publicada
src/application/bll/revenue.bll.ts                     filas -> DTO
src/presentation/controllers/revenue.controller.ts     inyecta la BLL
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
del mapeo y un controlador que habla con la BLL.

Eso último es la razón de ser de este schematic. Todo módulo `@Crud` mantiene
bien las capas sin que nadie piense en ello, porque `CrudController` recibe un
`ICrudBLL` y no acepta otra cosa. Una consulta es el único sitio de un
proyecto monolite donde los cuatro ficheros se escriben desde cero, así que es el
único donde la regla se puede romper —ver [arquitectura](architecture.md)—.

### `generate repository`

No hace falta uno para hacer CRUD, y conviene decirlo primero: `defineEntity` ya
produjo un repositorio que selecciona, inserta, actualiza, pagina, filtra y borra
lógicamente en todos los motores. Un módulo que solo haga eso debería inyectarlo
directamente. Una clase que reenvía diecisiete métodos y no añade ninguno es una
capa por tenerla, y por eso esto no forma parte de `generate module`.

Genera uno el día en que el módulo necesita una consulta que la API genérica no
expresa a propósito: una agregación, un `GROUP BY`, una vista, un procedimiento
almacenado.

```bash
monolite g repository invoice
```

```
src/infrastructure/persistence/invoice.repository.ts   la interfaz y la clase
```

Extiende `BaseModuleRepository`, que reenvía el contrato entero al almacén y
envuelve cada llamada en un guard que registra el error del driver y relanza uno
neutro — así un `ORA-00001` se queda en el log y no llega nunca a un cliente. El
método de ejemplo enseña la forma: `asRawQueryable` para preguntar si este motor
tiene SQL que ejecutar, la agregación si lo tiene, y el camino en proceso si no,
porque el driver en memoria es el que usa tu suite generada.

El almacén que inyecta ya se suma a la transacción que esté abierta —eso es
cierto de todos los almacenes registrados desde 0.6.0—, así que aquí no hay que
decirle nada de eso.

**¿`repository` o `query`?** Un repositorio pertenece a una entidad y añade
métodos a *su* almacén. Una consulta no tiene tabla propia y calcula una
respuesta sobre varias, así que viene con su BLL, su DTO y su controlador. Si te
encuentras dándole al repositorio de una entidad un método que lee otras dos, la
respuesta era una consulta.

#### El binding

```
i Registered in src/composition/modules/invoice.module.ts:
    import { InvoicesRepository } from "../../infrastructure/persistence/invoice.repository";
    container.register(INVOICE_TOKENS.repository, { useClass: InvoicesRepository });
```

Dos líneas y no una, porque la clase hay que importarla antes de poder
registrarla. Van encima de un marcador `// monolite:bindings` que el módulo trae
— y a diferencia de `modules.ts`, este es un fichero que casi seguro has
editado, que es justo la situación en la que un generador tiene que ir con
cuidado. Mueve el marcador, renómbralo o bórralo y no se toca nada: el comando
imprime las dos líneas.

El token ya estaba declarado. `<ENTIDAD>_TOKENS.repository` lo escribe
`generate module` y simplemente no lo registra nadie hasta que hay algo que
registrar, lo que le ahorra al generador tener que reabrir la tabla de tokens.

Lo que queda para ti es una línea en la BLL: inyectar
`<ENTIDAD>_TOKENS.repository` donde hoy inyecta `<ENTIDAD>_TOKENS.store`, y
ensanchar su tipo a la interfaz nueva. Esa sí es una decisión —puede que la BLL
quiera el almacén pelado— así que se imprime en vez de hacerse.

### `generate task`

Un backend no es sólo un servidor. Tiene el trabajo que adelanta los cargos
vencidos a las 3 de la mañana, el que manda los recordatorios, el que revisa un
buzón — y cada uno solía ser un script que construía el contenedor por su
cuenta, resolvía lo que necesitaba, se ejecutaba y salía. Esa parte es idéntica
en todos y fácil de hacer mal, así que se escribe una vez:

```bash
monolite g task advance-charges
```

```
src/tasks/advance-charges.task.ts    la tarea
src/tasks/index.ts                   listada aquí, encima de // monolite:tasks
```

```ts
export default defineTask({
  name: "advance-charges",
  async run({ container, logger }) {
    const charges = container.resolve<ChargeBLL>(CHARGE_TOKENS.bll);
    const advanced = await charges.advanceDue();
    logger.info(`${advanced} charges advanced`);
  },
});
```

```bash
npm run task advance-charges                 # en desarrollo, con tsx
node dist/scripts/task.js advance-charges    # tras un build: lo que ejecuta un timer
```

Todas las tareas pasan por un único runner, `src/scripts/task.ts`, sobre
`runTaskByName` de `monolite-di`. Lo que añade es lo que un script escrito a mano
olvida:

| Salida | Cuándo |
| --- | --- |
| `0` | El cuerpo terminó y las conexiones se cerraron limpiamente |
| `1` | El cuerpo lanzó o rechazó, no se pudo llegar a la base de datos, o el pool no se cerró |
| `64` | No hay tarea con ese nombre; se listan las que hay |
| `75` | Una ejecución anterior aún tiene el candado, así que ésta no arrancó |

- **Una salida distinta de cero al fallar.** El cuerpo se espera con `await`, así
  que una promesa rechazada es una ejecución fallida y no un rechazo sin manejar
  que puede salir con `0`.
- **Una guarda contra solapamientos.** Una ejecución que encuentra la anterior
  aún en marcha registra quién tiene el candado y desde cuándo, y sale con `75`
  — `EX_TEMPFAIL`, distinto de un fallo, para que `systemctl status` distinga
  "se rompió" de "seguía ejecutándose". El candado es un fichero con el pid de la
  ejecución: una ejecución matada con `SIGKILL` lo deja atrás, y la siguiente ve
  que el proceso ya no existe y se lo queda — igual que cuando el pid es el suyo
  pero nunca tomó el candado, que es lo que encuentra un contenedor reiniciado
  como PID 1.
- **Una línea de log en cada extremo**, con el nombre de la tarea y cuánto tardó,
  por el mismo logger en el que escribe el servidor.
- **Las conexiones**, comprobadas antes de ejecutar el cuerpo y cerradas después,
  terminara como terminara.

El candado vive en el directorio temporal del sistema, con el nombre de
`SERVICE_NAME` y de la tarea; `TASK_LOCK_DIR` lo mueve. Protege **un host**: dos
réplicas en dos máquinas tienen cada una el suyo. Un CronJob de Kubernetes
quiere además `concurrencyPolicy: Forbid`, y un trabajo que no deba ejecutarse
dos veces en ningún sitio necesita su candado en la base de datos en la que
escribe.

**La planificación se queda fuera, a propósito.** Un timer de systemd, una
entrada de cron o un CronJob ya saben ejecutar un comando a las 3 de la mañana,
ponerse al día tras una caída e informar de una salida distinta de cero; tener
un planificador propio significaría tener un proceso que debe seguir vivo. Lo que
el toolkit asume es lo que se planifica — una tarea que es seguro invocar. Un
timer para la tarea de arriba:

```ini
# /etc/systemd/system/advance-charges.service
[Service]
Type=oneshot
WorkingDirectory=/srv/billing-api
EnvironmentFile=/srv/billing-api/.env
ExecStart=/usr/bin/node dist/scripts/task.js advance-charges

# /etc/systemd/system/advance-charges.timer
[Timer]
OnCalendar=*-*-* 03:00
Persistent=true

[Install]
WantedBy=timers.target
```

Una tarea que siembra datos de referencia es la candidata natural para ejecutar
tras cada despliegue; ver [`seed`](data-access.md#sembrar-datos-de-referencia).

Como con los módulos, la entrada va encima de un marcador — `// monolite:tasks`
en `src/tasks/index.ts` — y sin él, o con `--no-wire`, se imprimen las dos líneas
en su lugar. Un fichero de tarea que nada lista es una tarea que nadie puede
invocar.

Los proyectos generados antes de esta versión no tienen runner. Basta con copiar
`src/scripts/task.ts` y `src/tasks/index.ts` de un proyecto recién generado y
añadir `"task": "tsx src/scripts/task.ts"` al `package.json`.

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
