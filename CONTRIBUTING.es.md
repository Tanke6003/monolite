# Contribuir

> 🇬🇧 [Read in English](./CONTRIBUTING.md)

Gracias por dedicarle tiempo. Este documento recoge las convenciones que no se
deducen leyendo el código.

## Por dónde empezar

Si buscas algo que coger: los
[issues abiertos](https://github.com/Tanke6003/monolite/issues) llevan el
razonamiento detrás de cada uno, porque las plantillas lo piden. Cualquiera con
la etiqueta `documentation` es un buen primer cambio: las guías se comprueban en
CI, así que sabrás al momento si el ejemplo que escribiste funciona.

No hace falta una base de datos para contribuir. `npm run check` corre sin nada
instalado, y el driver en memoria es un motor completo.

Dos cosas antes de abrir nada:

- **Discrepar con argumentos es bienvenido y es el objetivo.** Aquí se discute de
  diseño en abierto; en el [código de conducta](./CODE_OF_CONDUCT.md) está la
  única regla que hace que eso funcione.
- **Nada sensible en materia de seguridad va en un issue.** Desde aquí se
  publican siete paquetes: ver [SECURITY.md](./SECURITY.md).

## Puesta en marcha

```bash
git clone <repo>
cd monolite
npm install
npm run check     # typecheck + lint + pruebas
```

El repositorio es un workspace de npm con referencias de proyecto de TypeScript,
así que `npm run typecheck` (`tsc --build`) recompila sólo lo que cambió. Si de
pronto un paquete no encuentra los tipos de otro, borra los archivos
`*.tsbuildinfo` y vuelve a compilar: casi siempre es un estado incremental viejo.

## Dónde va cada cosa

| Si… | Va en |
| --- | --- |
| no tiene dependencias y todos los demás paquetes lo necesitan | `core` |
| toca un driver de base de datos o compila una consulta | `data` |
| toca Express, semántica HTTP u OpenAPI | `http` |
| es CRUD genérico o fontanería de transacciones | `crud` |
| autentica o autoriza | `auth` |
| menciona tsyringe | `di` |
| genera archivos para el proyecto de alguien | `cli` |

Dos reglas duras: **`core` tiene que seguir sin dependencias** y **nada puede
depender de `di`**. Las dos existen para que alguien pueda adoptar un paquete sin
heredar las decisiones de los otros. A un pull request que rompa cualquiera de las
dos se le pedirá reestructurar, no añadir una excepción.

## Estilo

- **Todo en inglés**: identificadores, comentarios, bloques de documentación,
  mensajes de error, mensajes de commit y descripciones de PR. El proyecto es
  bilingüe sólo en su documentación, y los documentos en español son traducciones
  de los ingleses, no una segunda fuente de verdad.
- **Los comentarios explican por qué, no qué.** `// incrementa el contador` encima
  de `i++` es ruido. `// El bloqueo tiene que ser la primera sentencia: el
  REPEATABLE READ de MySQL fija la foto en la primera lectura` es de los que se
  quedan. Si un comentario repite el código, bórralo; si registra una decisión,
  una restricción o un bug que vivió ahí, consérvalo.
- Indentación de dos espacios, límite blando de 100 columnas, finales de línea LF
  — lo cubre `.editorconfig`.
- Prefiere tipos explícitos en la superficie pública. Dentro del cuerpo de una
  función, la inferencia está bien.

## Pruebas

```bash
npm test
npm test -- --coverage
```

La cobertura se recoge de todos los archivos fuente, no sólo de los que alguna
prueba importa. Un archivo sin pruebas que nunca aparece en el informe se lee como
"cubierto" para quien sólo mira el número, así que la configuración saca los
huecos a la luz a propósito.

Una prueba tiene que **discriminar**: debe fallar si se quita el comportamiento que
describe. La forma más rápida de comprobarlo es romper el mecanismo a propósito y
confirmar que la prueba se pone en rojo. Una prueba que pasa con y sin la
funcionalidad es peor que ninguna prueba, porque da una confianza que no se ha
ganado.

### Contra motores reales

`npm test` verifica los drivers contra un array y dos dobles. Buenos dobles
—evalúan el SQL generado en vez de asentir— e incapaces igualmente de detectar la
clase de fallo en la que el motor y el doble no coinciden. Esa clase se ha
publicado varias veces: una marca de borrado lógico que el driver SQL nunca
escribía, una cláusula `ON DELETE` que un motor no sabe decir, un `CALL` que el
conector no podía hacer, y un `like` que ignoraba mayúsculas en dos de los cuatro.

```bash
npm run engines:up          # PostgreSQL, MySQL, SQL Server, MongoDB, Oracle
npm run test:integration
npm run engines:down
```

Tocar un driver, un dialecto, un conector o el generador de DDL implica ejecutar
esto. CI lo corre en cada push, así que un cambio que solo pase la suite de
unidad se detectará igualmente — pero una hora después y con menos contexto del
que tienes ahora.

`MONOLITE_IT_ENGINES=postgres` lo acota mientras trabajas.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), en inglés:

```
feat(data): add a MySQL row-lock statement to the dialect
fix(http): sort routes by specificity before mounting
docs(es): translate the CRUD guide
```

El scope es el nombre del paquete (`core`, `data`, `http`, `crud`, `auth`, `di`,
`cli`) o `docs`, `build`, `ci`.

## Documentación

Todo cambio visible para el usuario actualiza `docs/en/` y `docs/es/`. El inglés se
escribe primero y el español lo refleja; los dos directorios tienen los mismos
nombres de archivo y cada página enlaza a su equivalente arriba del todo.

## Publicación

Nadie publica a mano. Un push a `master` ejecuta `.github/workflows/release.yml`,
que lee los commits desde la última etiqueta `v*` y decide a cuánto suman:

| Commit | Versión |
| --- | --- |
| `fix:`, `perf:`, `revert:` | patch — `0.1.0` → `0.1.1` |
| `feat:` | minor — `0.1.0` → `0.2.0` |
| `feat!:`, o un pie `BREAKING CHANGE:` | major, con la salvedad de abajo |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `style:` | ninguna |

Gana el salto más fuerte del rango, y una rama que sólo mueve documentación y
pruebas entra sin cortar versión — que es justo el sentido de la última fila.
Por debajo de `1.0.0` un cambio rompedor mueve la minor: declarar estabilidad es
una decisión que toma una persona, no un mensaje de commit.

Ya decidido, el workflow escribe esa versión en los siete manifiestos, en los
rangos que usan entre ellos y en `MONOLITE_VERSION` de la CLI, compila, lo
registra como `chore(release): vX.Y.Z`, etiqueta, publica cada paquete en orden
de dependencias y hace push. Publicar va al final, porque es el único paso que
no se puede deshacer.

Para ver qué publicaría un merge antes de hacerlo:

```bash
npm run release:dry
```

Los paquetes se versionan juntos —un solo número para los siete— porque la API
no es estable y las versiones independientes sólo fomentarían instalaciones
descuadradas. `MONOLITE_VERSION` en `packages/cli/src/config/answers.ts` es la
misma decisión vista del otro lado: un scaffold que fijara `core` y `http` en
minors distintas sería un ticket de soporte esperando a ocurrir.

La decisión en sí está probada —`npm run test:scripts`, parte de `npm run
check`— porque se toma una vez por merge, sin que nadie la mire, y una versión
publicada no se puede retirar.
