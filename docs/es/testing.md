# Pruebas

> 🇬🇧 [Read in English](../en/testing.md)

La regla a la que este proyecto se somete: **una prueba tiene que fallar si se
quita el comportamiento que describe.** Todo lo que sigue se deriva de ahí.

---

## Ejecutar

```bash
npm test                  # todos los paquetes
npm test -- --coverage
npm test -- packages/data # un paquete
npm test -- -t "lockRow"  # una prueba por nombre
```

Jest corre una sola vez desde la raíz del repositorio sobre todos los workspaces.
Una ejecución significa un informe de cobertura, que es lo que de verdad te dice si
el toolkit está probado: siete informes separados con buena pinta cada uno pueden
seguir escondiendo un paquete que nadie cubre.

Las pruebas importan los paquetes por nombre (`monolite-core`), y Jest mapea esos
nombres a las **fuentes**, no a `dist`. Apuntar a la salida de compilación haría
que cada ejecución dependiera de un build previo, y un build viejo prueba en
silencio el código de ayer.

---

## Qué lleva prueba unitaria

Las pruebas unitarias cubren la **maquinaria**: las partes genéricas,
estructurales, cuyo comportamiento no es evidente al leerlas.

- Los compiladores de filtros — el mismo `WhereFilter` contra los compiladores de
  SQL, Mongo y memoria, incluido el escapado y el rechazo de propiedades no
  mapeadas.
- Las diferencias de dialecto — paginación, recuperación del identity y bloqueo de
  fila por motor.
- El registro de rutas — orden por especificidad, detección de duplicados,
  metadatos de los decoradores.
- El constructor de OpenAPI — que el documento coincide con las rutas de las que
  salió.
- El mapeador de errores — todas las ramas de "valor lanzado → estado + código".
- Los contextos de petición y de transacción — que sobreviven a un `await` y se
  mantienen aislados entre flujos concurrentes.

Lo que **no** lleva prueba unitaria es la ceremonia por entidad. Una prueba que
afirma que `UsersBLL.create` llama a `usersRepository.insert` reescribe la
implementación en un segundo idioma; pasa mientras los dos archivos estén de
acuerdo entre sí y no dice nada sobre si alguno de los dos es correcto. Esos flujos
van en pruebas de punta a punta, donde una petición real produce una fila real.

---

## Qué lleva prueba de punta a punta

Todo aquello cuya respuesta depende de que más de una capa se pongan de acuerdo:

- Una petición por la cadena completa de middlewares, incluido el sobre de error.
- Una validación rechazando un body, con el detalle por campo que ve el cliente.
- Un caso de uso transaccional, incluido el camino de rollback.
- Autenticación: un token emitido, luego aceptado, luego rechazado al caducar.

Corren contra el driver de memoria por defecto, así que no necesitan
infraestructura. Apunta `DATA_SOURCE` a un motor real para correr la misma suite
contra él.

---

## La prueba de contrato

`monolite-data` exporta un **kit de contrato de repositorio**: una suite que
cualquier implementación de `IGenericRepository` tiene que pasar.

```ts
import { runGenericRepositoryContract } from "monolite-data/testing";

// El nombre del driver es el primer argumento: entra en el nombre de cada test
// que genera el kit, así que un fallo dice qué implementación se rompió.
runGenericRepositoryContract("MiRepositorioPropio", {
  create: () => new MiRepositorioPropio(/* ... */),
});
```

Esto es lo que convierte "seis motores, un contrato" en una afirmación y no en un
deseo. Un driver nuevo es correcto cuando pasa esta suite, y un cambio en el
contrato rompe todos los drivers que no se hayan puesto al día.

---

## Escribir una prueba que discrimina

El modo de fallo que hay que vigilar es la prueba que pasa **con y sin** el
mecanismo que dice cubrir. Dos ejemplos reales de este código:

**Una prueba de concurrencia sobre el driver de memoria.** Ejercitaba la carrera de
comprobar-y-luego-escribir que el bloqueo de fila existe para cerrar, pero el
driver de memoria es de un solo hilo, así que el entrelazado nunca ocurría y la
prueba pasaba con el bloqueo quitado. El arreglo fue correrla contra SQL con
entrelazado forzado.

**Una prueba de transacción ambiental sobre la unidad de trabajo en memoria.**
Afirmaba que el repositorio se sumaba a la transacción, pero en el driver de
memoria el repositorio y su ámbito transaccional son el mismo objeto, así que
sumarse no hacía nada y la afirmación se cumplía de todos modos.

Las dos se cazaron con la misma técnica, y es la que merece la pena interiorizar:

> Rompe el mecanismo a propósito —coméntalo, o ponlo detrás de una variable de
> entorno— y confirma que la prueba se pone en rojo. Si sigue en verde, la prueba
> está midiendo otra cosa.

Haz esto una vez por cada prueba que cubra una invariante sutil. Cuesta un minuto y
es la diferencia entre una suite que te protege y una suite que te tranquiliza.

---

## Cobertura

```bash
npm test -- --coverage
```

La cobertura se recoge de `packages/*/src/**/*.ts` — **todos** los archivos fuente,
no sólo los que alguna prueba importa. Es una decisión deliberada y tiene un coste:
el número baja, porque los archivos que nadie prueba ahora aparecen al 0% en vez de
no aparecer.

Ese es justamente el punto. Un informe que sólo lista los archivos importados se lee
como completo para quien lo ojea, y los archivos con más probabilidad de estar sin
probar —el código de arranque, el cableado de middlewares, el apagado a nivel de
proceso— son exactamente los que ninguna prueba unitaria importa.

No persigas el porcentaje. Un módulo al 70% con todas sus ramas ejercitadas de
verdad está mejor que uno al 95% rellenado con aserciones sobre getters.

---

## Ejecutarlo contra todos los motores

La suite de unidad verifica los paquetes contra un array y dos dobles, y los
dobles son buenos: evalúan el SQL generado en vez de asentir. Lo que no pueden
detectar es la clase de fallo en la que el motor y el doble no coinciden, y esa
clase se publicó más de una vez: una transacción a la que los repositorios no se
sumaban, una marca de borrado lógico que el driver SQL nunca escribía, una
cláusula `ON DELETE` que un motor no sabe decir, y una llamada a procedimiento
que el conector no podía hacer. Todas pasaban todas las pruebas de unidad.

```bash
npm run engines:up          # cinco contenedores, espera a que estén sanos
npm run test:integration
npm run engines:down        # y sus volúmenes
```

`docker/integration/docker-compose.yml` levanta PostgreSQL, MySQL, SQL Server,
MongoDB y Oracle Free en puertos elegidos para no chocar con lo que ya tengas
corriendo. CI ejecuta la misma suite en cada push, contra los mismos cinco.

Para acotar mientras trabajas:

```bash
MONOLITE_IT_ENGINES=postgres,mysql npm run test:integration
MONOLITE_IT_VERBOSE=true npm run test:integration    # cada sentencia, al log
```

Cada dato de conexión tiene su `MONOLITE_IT_<MOTOR>_<CAMPO>`, así que la suite
puede apuntar a un servidor que no hayas levantado tú desde ese fichero.

### Qué comprueba de verdad

- **El esquema es el que genera este repositorio.** `emitSchema` lo escribe a
  partir de los mismos metadatos que lee el repositorio, y la suite aplica eso.
  Un esquema escrito a mano escondería justo el desacuerdo que el generador
  existe para evitar —y escondió uno durante meses: el mapeo escribe un booleano
  como `1`, que una columna `BOOLEAN` rechaza—.
- **El contrato común, en los cinco.** `runGenericRepositoryContract` es el
  conjunto de aserciones que toda implementación debe pasar. Hasta ahora solo se
  había ejecutado contra los dos que ya estaban bien.
- **Transacciones sobre tres tablas**, confirmando y revirtiendo, incluido el
  caso que más importa: un almacén inyectado al arrancar, dentro de una
  transacción que nadie le pasó.
- **Bloqueos de fila**, tomados antes de la lectura que depende de ellos.
- **Procedimientos almacenados** por `executeRaw`: uno que lee, uno que escribe,
  y uno llamado dentro de una transacción que luego revierte —que es lo que
  demuestra que la vía de escape corre sobre la conexión de la transacción y no
  sobre la del pool—.

MongoDB se salta los cuatro casos que solo aplican a SQL y lo dice: no tiene
procedimientos ni claves foráneas, y fingir lo contrario sería inventarse una
forma que nadie escribe.

### Falla en vez de saltarse

Un motor nombrado en `MONOLITE_IT_ENGINES` que no responda hace fallar la
ejecución. Una suite que verifica nada en silencio es peor que una que nadie
ejecuta, porque CI sigue informando de que las pruebas de integración pasaron.

---


## Probar tu propio proyecto

Un proyecto generado por la CLI llega con dos suites y las dos pasan a la primera:
una unitaria sobre los ayudantes de configuración y otra de extremo a extremo sobre
la aplicación misma — salud, el documento de OpenAPI, el módulo de ejemplo y, en un
proyecto con autenticación, la ruta de login y el guardia que hay delante de todo
lo demás.

No necesitan nada levantado. `tests/setup/test-env.ts` fuerza `DATA_SOURCE=memory`
antes de que se cargue un solo módulo, así que las pruebas reciben el repositorio
real, las BLL reales y las rutas reales sobre el driver en memoria. Apunta esa
variable a un motor y las mismas pruebas corren contra él: la metadata de la entidad
no cambia.

La aplicación se maneja en memoria, no por un socket:

```ts
import { api, API, headers, type Api } from "./support/api";

let http: Api;
let auth: Record<string, string>;

beforeAll(async () => {
  http = await api();       // Server.configure(), nunca Server.run()
  auth = await headers();   // un token real, de la ruta de login real
});

it("rechaza un body que no pasa la validación", async () => {
  const response = await http.post(`${API}/branches`).set(auth).send({ name: "" });

  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(response.body.errors[0]).toMatchObject({ field: "name" });
});
```

`Server.configure()` es `run()` sin ponerse a escuchar, que es lo que permite correr
la suite junto a un servidor de `dev` sin pelearse con él por el puerto. La cadena
que monta es la misma, en el mismo orden.

Una advertencia que conviene conocer: un manejador de errores de Express sólo cubre
las rutas registradas **antes** que él. Si montas una app a mano en una prueba en
vez de usar `createApp` o el `Server` generado, registra el manejo de errores al
final o tus errores se escaparán como el HTML por defecto de Express y la aserción
de arriba fallará por un motivo que no tiene nada que ver con la validación.
