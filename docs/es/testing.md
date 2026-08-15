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

Las pruebas importan los paquetes por nombre (`@monolite/core`), y Jest mapea esos
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
afirma que `UsersService.create` llama a `usersRepository.insert` reescribe la
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

`@monolite/data` exporta un **kit de contrato de repositorio**: una suite que
cualquier implementación de `IGenericRepository` tiene que pasar.

```ts
import { runRepositoryContract } from "@monolite/data/testing";

describe("MiRepositorioPropio", () => {
  runRepositoryContract({
    create: () => new MiRepositorioPropio(/* ... */),
  });
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

## Probar tu propio proyecto

Un proyecto generado por la CLI viene con `jest.config.js`, el mismo mapeo a
fuentes en vez de a `dist`, y una prueba de humo que pasa a la primera. Añade sobre
eso de la misma forma:

```ts
import request from "supertest";
import { createApp } from "@monolite/http";

it("rechaza un body que no pasa la validación", async () => {
  const { app } = createApp({ controllers, /* ... */ });

  const response = await request(app).post("/api/v1/branches").send({ name: "" });

  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ code: "VALIDATION_ERROR" });
  expect(response.body.errors[0]).toMatchObject({ field: "name" });
});
```

Una advertencia que conviene conocer: un manejador de errores de Express sólo cubre
las rutas registradas **antes** que él. Si montas una app a mano en una prueba en
vez de usar `createApp`, registra el manejo de errores al final o tus errores se
escaparán como el HTML por defecto de Express y la aserción de arriba fallará por
un motivo que no tiene nada que ver con la validación.
