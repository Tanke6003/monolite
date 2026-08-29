# Autenticación

> 🇬🇧 [Read in English](../en/authentication.md) · paquete: `monolite-auth`

Opcional y enchufable. El paquete aporta lo que es igual en todas las aplicaciones
—el flujo de login, una BLL de tokens, un hasheador de contraseñas, el
middleware que protege una ruta— y se niega a propósito a saber lo que no lo es.

**Ningún otro paquete depende de este.** Una aplicación que ya se autentica por
otro lado puede llevarse sólo `requireAuth`, o nada en absoluto.

---

## Los tres contratos donde enchufas

| Contrato | Quién lo implementa | Por qué es una interfaz |
| --- | --- | --- |
| `IUserProvider` | **Tú** | Dónde viven los usuarios es decisión tuya: una tabla, un almacén de documentos, un arreglo. El paquete no debe imponer un esquema. |
| `IPasswordHasher` | Incluido (`ScryptPasswordHasher`), intercambiable | Lo que hoy es suficiente no lo será en cinco años. Cambiar a argon2 no debe tocar nada más. |
| `ITokenBLL` | Incluido (`JwtTokenBLL`), intercambiable | Una aplicación con tokens opacos respaldados por un almacén implementa los mismos dos métodos. |

```ts
export interface IUserProvider {
  // `null` cuando el usuario no existe — nunca lanza por "no encontrado".
  findByEmail(email: string): Promise<AuthUserWithSecret | null>;
}
```

Esa es toda la superficie de integración. `AuthUserWithSecret` es `{ id, name,
email, roles, passwordHash }`, y `passwordHash` es el único campo que nunca sale
de la BLL.

Y es también el límite de lo que este contrato puede hacer: entrega un hash, así
que la contraseña tiene que poder comprobarse aquí. Un directorio que comprueba
la suya —LDAP, Nextcloud, OIDC— jamás produce uno, y ese caso tiene una costura
propia, más abajo.

---

## Cablearlo

```ts
import {
  AuthController,
  AuthBLL,
  JwtTokenBLL,
  ScryptPasswordHasher,
  requireAuth,
  requireRoles,
} from "monolite-auth";

const tokens = new JwtTokenBLL({ secret: process.env.JWT_SECRET!, expiresIn: "1h" });
const hasher = new ScryptPasswordHasher();

const auth = new AuthBLL(new MyUserProvider(usersRepository), hasher, tokens);

const app = createApp({
  controllers: [...controllers, new AuthController(auth)],
  guard: requireAuth(tokens),
  logger,
  context,
});
```

`POST /auth/login` recibe `{ email, password }` y responde
`{ token, expiresIn, user }`. `expiresIn` viaja junto al token porque al cliente no
se le puede pedir que parsee el token para averiguarlo: para él, el token es una
cadena opaca.

---

## Dos cosas que el login hace a propósito

**Responde igual ante un correo desconocido y ante una contraseña equivocada.**
Los dos levantan el mismo 401 con el mismo mensaje. Distinguirlos convierte el
endpoint de login en un oráculo de existencia de cuentas: quien ataca averigua qué
direcciones están registradas sin adivinar ni una sola contraseña.

**Y tarda lo mismo en las dos.** Cuando el usuario no existe, la BLL ejecuta
igualmente la verificación del hash contra un hash señuelo. Saltársela devolvería
en microsegundos en vez de en los ~100 ms que cuesta una comparación real de
scrypt, y esa diferencia se mide por red: el mensaje idéntico se filtraría por el
reloj.

Ninguna de las dos es teórica: así se enumera en la práctica, y acertar la segunda
es la parte que la mayoría de implementaciones se salta.

---

## Cuando la contraseña no es tuya para comprobarla

`IUserProvider` entrega un hash y `AuthBLL` lo compara aquí. Eso está bien para
una tabla de usuarios y es imposible para un directorio: LDAP, Nextcloud y
cualquier proveedor OIDC comprueban la contraseña de su lado y contestan sí o
no; ninguno va a entregar nunca un hash que comparar. Así que la costura para
ellos no es el proveedor de usuarios, por natural que suene. Tiene que estar
donde ocurre la comparación, que es la BLL.

`ExternalAuthBLL` es esa BLL. Conserva todo lo que rodea a la comparación —el
token, el error único, la defensa de temporización, la cuenta suspendida— para
que conectar un directorio sean dos clases pequeñas y no un flujo de inicio de
sesión reescrito desde cero.

| Contrato | Quién lo implementa | Qué contesta |
| --- | --- | --- |
| `IIdentityProvider` | **Tú** | Una `ExternalIdentity` si la credencial se confirmó, `null` si se rechazó, y **lanza** cuando el proveedor no contestó en absoluto. |
| `IExternalUserProvider` | **Tú** | Dónde vive la cuenta local detrás de esa identidad. Extiende `IUserProvider`, así que una sola clase sirve a los dos flujos. |

```ts
export interface IIdentityProvider {
  verify(login: string, password: string): Promise<ExternalIdentity | null>;
}

export interface ExternalIdentity {
  /** Su llave allá: un `uid`, un nombre de cuenta, el `sub` de un OIDC. */
  key: string;
  name: string;
  email: string | null;
  /** Se traen para poder registrarlos. Nunca se leen como rol: ver abajo. */
  groups: string[];
}
```

**`null` y lanzar son respuestas distintas, y ese es el punto del contrato.**
`null` significa que la credencial se rechazó; lanzar significa que el proveedor
no contestó. Si se confunden, una caída le dice al despacho entero que se
equivocó al teclear —lo cual es falso, y además es la forma más rápida de
enterrar el único dato que un operador necesitaba—. `ExternalAuthBLL` contesta
401 para lo primero y 503 `IDENTITY_PROVIDER_UNAVAILABLE` para lo segundo.

### Elegir un flujo u otro al arrancar

```ts
const auth = directoryUrl
  ? new ExternalAuthBLL(new DirectoryIdentityProvider(directoryUrl), users, hasher, tokens, {
      logger,
    })
  : new AuthBLL(users, hasher, tokens);
```

`IExternalUserProvider` extiende `IUserProvider`, así que `users` es la misma
clase en los dos casos y la elección es una línea en la raíz de composición. Eso
es lo que permite que una copia de la aplicación sin acceso al directorio siga
iniciando sesión contra su propia tabla: así corren las pruebas, y así se trabaja
desde una laptop.

### Qué decide, y por qué

- **Los roles son tuyos, nunca del proveedor.** `identity.groups` se transporta
  y no se lee. Mapear grupos del directorio a roles suena a comodidad justo
  hasta el día en que alguien entra a un grupo llamado `admin` por una razón
  ajena y se lleva tu aplicación de paso.
- **El `sub` del token sigue siendo el id local.** Ese claim llena las columnas
  de auditoría y es contra lo que se resuelve cualquier regla sobre *quién*
  pregunta. La llave externa identifica a la persona ante el proveedor, no ante
  ti; se guarda al lado de la cuenta, y se mantiene actualizable, porque en
  algunos proveedores renombrar una cuenta es borrarla y crear otra.
- **Una caída es un 503, no un 401.** No filtra nada: que el directorio no
  conteste es un hecho del despliegue, idéntico para una dirección que existe y
  para una que no.
- **La contraseña local sigue sirviendo.** `localPasswordFallback` viene
  encendida, así que la cuenta de emergencia entra mientras el directorio está
  caído. Apágala para que el proveedor sea la única autoridad; entonces nada
  llama nunca al hasheador.
- **Una cuenta suspendida lo dice en voz alta.** `ExternalAuthUser.disabled`, en
  lugar de un `null` desde `findByEmail`. Ocultarla manda el siguiente inicio de
  sesión —que el directorio sigue aceptando— por el camino del alta automática,
  y una cuenta nueva deshace en silencio la suspensión. La respuesta a la
  petición sigue siendo el 401 de siempre.
- **El primer inicio de sesión crea la cuenta**, con el privilegio mínimo que le
  dé tu `provision`. `autoProvision: false` lo apaga, y entonces una identidad
  verificada sin cuenta local recibe el mismo 401: contestar otra cosa le
  confirma la contraseña a quien la estaba adivinando.

---

## Hasheo de contraseñas

`ScryptPasswordHasher` usa el `crypto.scrypt` que trae Node — una KDF dura en
memoria, una sal aleatoria por contraseña y `timingSafeEqual` para la comparación.
No necesita ninguna dependencia, y por eso es el valor por defecto.

No es la opción más fuerte que existe. argon2id es la recomendación actual allí
donde puedas añadir una dependencia nativa, y bcrypt sigue estando bien. Las dos
caben detrás de `IPasswordHasher` sin tocar nada más:

```ts
class Argon2Hasher implements IPasswordHasher {
  hash(plain: string) { return argon2.hash(plain); }
  verify(plain: string, hash: string) { return argon2.verify(hash, plain); }
}
```

`verify` devuelve `false` —en vez de lanzar— cuando el hash guardado es ilegible.
Una fila corrupta tiene que hacer fallar el login, no la petición.

---

## Proteger rutas

```ts
// Todo lo que monte la app, salvo lo que se declare público.
createApp({ controllers, guard: requireAuth(tokens), logger, context });
```

O ruta a ruta, con el guardia como middleware extra:

```ts
class ReportsController {
  @Get("/admin/reports", { use: [requireRoles("admin")] })
  public reports = async (req: Request, res: Response) => { /* ... */ };
}
```

`requireAuth` lee `Authorization: Bearer …`, verifica el token y publica la
identidad en el contexto de la petición — el mismo contexto que leen los
repositorios para sus columnas de auditoría y el manejador de errores para su log.
Nada aguas abajo parsea un token.

Una ruta marcada con `public: true` en las opciones de su decorador se salta la
guarda, y el constructor de OpenAPI omite en consecuencia su bloque `security` y su
401 automático. Una declaración, los dos efectos.

`requireRoles(...roles)` comprueba `CurrentUser.roles` y responde 403. Las dos
fallan a través de `AppError`, así que el manejador de errores existente las
renderiza en el sobre estándar con un `code` estable: no aparece un segundo formato
de error sólo porque el fallo haya sido de autorización.

`authenticatedUser(req)` devuelve el `CurrentUser` o `null`, para los pocos sitios
que necesitan ramificar en vez de rechazar.

### Nombres de los claims

Los proveedores no se ponen de acuerdo en los nombres, así que el mapeo prueba una
lista en orden:

| | Claims que prueba, en orden |
| --- | --- |
| id | `sub`, `userId`, `id`, `oid` |
| name | `name`, `nameComplete`, `preferred_username`, `samaccountname`, `username` |
| email | `email`, `emails`, `upn` |
| roles | `roles`, `role` — cadena o arreglo, siempre normalizado a arreglo |

Si no hay ningún claim de nombre se usa el correo, y a falta de eso el id: así una
escritura autenticada nunca queda registrada como `System`.

Usa el **id**, nunca el nombre, para cualquier cosa que dependa de quién pregunta.
Los nombres cambian; los ids no.

---

## Lo que este paquete no hace

Explícitamente, porque los huecos importan más que las funcionalidades:

- **Nada de refresh tokens.** Un flujo de refresco necesita dónde guardarlos y
  revocarlos, y ese almacén es una decisión de la aplicación. Emitir un segundo JWT
  y llamarlo token de refresco no aporta nada: tampoco se puede revocar.
- **Ni registro, ni recuperación de contraseña, ni verificación de correo.** Los
  tres necesitan enviar correo, limitar por dirección y decidir una política. Son
  funcionalidades de la aplicación que casualmente tocan la autenticación.
- **Ni almacén de sesiones ni logout.** Un JWT vale hasta que caduca; "cerrar
  sesión" es que el cliente lo tire. La revocación de verdad necesita una lista de
  bloqueo, que es la misma decisión de almacenamiento de arriba.
- **Ni el baile de redirección de OAuth ni el de OIDC.** No hay flujo de código
  de autorización, ni parámetro `state`, ni ruta de retorno. Lo que sí hay, para
  un proveedor dispuesto a comprobar una contraseña directamente, es el
  `IIdentityProvider` de arriba; y para uno que emite sus propios tokens,
  verifícalos con tu propia implementación de `ITokenBLL` y deja el resto del
  paquete como está.

Cada una de esas es una omisión deliberada, no una funcionalidad que falta. Un
framework que las adivina te entrega algo que luego tienes que deshacer.

---

## Configuración

| Variable | Notas |
| --- | --- |
| `JWT_SECRET` | Obligatoria cuando se usa la BLL de tokens JWT. **No tiene valor por defecto**: un framework que trae una clave de firma de respaldo le entrega una vulnerabilidad de tokens falsificados a todo el que se olvide de sobreescribirla. |
| `JWT_EXPIRES_IN` | Por defecto `1h`. Acepta la sintaxis de duración de `jsonwebtoken`. |

Comprueba que el secreto está al arrancar y falla a gritos si no lo está. Fallar en
el arranque es un problema de cinco segundos; descubrirlo en producción no.
