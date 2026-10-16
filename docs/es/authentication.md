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
| `IUserProvider` | **Tú** | Dónde viven los usuarios es decisión tuya: una tabla, un directorio LDAP, un arreglo. El paquete no debe imponer un esquema. |
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

## Cerrar sesión y revocar tokens

Un JWT vale hasta su `exp` por construcción: la firma no se puede retirar.
Revocarlo es recordar, en algún sitio que todas las instancias lean, que ya no
cuenta. `CacheTokenRevocation` guarda esa lista en el `ICache` compartido, y sólo
durante el tiempo que a cada token le quedaba de vida, así que se vacía sola.

```ts
import { CacheTokenRevocation } from "monolite-auth";

const revocation = new CacheTokenRevocation(cache, { maxTokenLifetime: 3600 });

const auth = new AuthBLL(users, hasher, tokens, { revocation });
const guard = requireAuth(tokens, { revocation, context });
```

La guarda y la BLL tienen que recibir **la misma instancia**; si no, el cierre de
sesión se escribe donde nadie lee.

- **`POST /auth/logout`** revoca el token que trae la petición y responde 204.
  Está protegida como cualquier otra ruta, así que cerrar sesión dos veces da un
  401 `TOKEN_REVOKED`, no un segundo 204.
- **`revocation.revokeAllFor(userId)`** retira todos los tokens emitidos hasta
  ahora a ese usuario: cuenta deshabilitada, contraseña cambiada, dispositivo
  perdido. Los tokens emitidos después siguen funcionando; mantener fuera una
  cuenta deshabilitada es trabajo de tu `IUserProvider`, no encontrándola al
  iniciar sesión.
- Todo token que firma `JwtTokenBLL` lleva ahora un **`jti`**, el nombre por el
  que se revoca. Un token firmado antes de actualizar no lo tiene, y `logout`
  responde 400 `TOKEN_NOT_REVOCABLE` hasta que caduque solo.

Con la revocación configurada, cada petición protegida lee la caché: dos claves,
en paralelo. Si la caché no responde, la guarda contesta **503
`AUTH_UNAVAILABLE`** en vez de dejar pasar la petición: un token revocado porque
lo robaron es justo el que no debe colarse durante una caída. El limitador del
login toma la misma decisión.

| `code` | Estado | Significado |
| --- | --- | --- |
| `TOKEN_REVOKED` | 401 | Se cerró la sesión del token o se le cortó el acceso al usuario. Hay que volver a iniciar sesión. |
| `AUTH_UNAVAILABLE` | 503 | El almacén de revocaciones está caído. Reintentar. |
| `TOKEN_NOT_REVOCABLE` | 400 | `logout` con un token sin `jti`. |
| `LOGOUT_UNAVAILABLE` | 501 | `logout` en un servidor sin revocación configurada. |

`revokeAllFor` se compara con el `iat` del token, que va en segundos enteros: un
token emitido en el mismo segundo que el corte sigue aceptándose. Rechazarlo
rechazaría también el token nuevo que se entrega justo después de cambiar la
contraseña.

Con `CACHE_DRIVER=memory` un cierre de sesión sólo vale en el proceso que lo
recibió. Con más de una réplica, usa Redis.

---

## Lo que este paquete no hace

Explícitamente, porque los huecos importan más que las funcionalidades:

- **Nada de refresh tokens.** Un refresh token hay que guardarlo, rotarlo en cada
  uso y atarlo a la cuenta que extiende, y esa tabla es una decisión de la
  aplicación. Emitir un segundo JWT y llamarlo token de refresco no aporta nada.
- **Ni registro, ni recuperación de contraseña, ni verificación de correo.** Los
  tres necesitan enviar correo, limitar por dirección y decidir una política. Son
  funcionalidades de la aplicación que casualmente tocan la autenticación.
- **Ni OAuth ni OIDC.** Si los necesitas, verifica el token del proveedor con tu
  propia implementación de `ITokenBLL` y deja el resto del paquete como está.

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
