# Arquitectura y flujos

## 1. Diagrama de despliegue

```text
┌──────────────────────────── 2Shell (proceso Tauri) ───────────────────────────┐
│                                                                                  │
│  WebView (React 19 + xterm.js)                                                   │
│    │ invoke(cmd, args)                     ▲ listen(event)                        │
│    ▼                                       │                                      │
│  presentation/tauri/commands.rs ───────────┴─────────────┐                        │
│    │                                                      │                        │
│    ├── ProfileService ── Storage(SQLite) ─ SecretBox(AES) │                        │
│    ├── PoolManager ── ConnectionPool ── SshConnection ────┼── TCP 22 ──► sshd     │
│    ├── TerminalManager ── ChannelRead/Write ──────────────┤                        │
│    ├── MetricsService ── exec /proc ──────────────────────┤                        │
│    └── ServiceManager ── exec systemctl/nginx/apache ─────┘                        │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Un único runtime Tokio (gestionado por Tauri) ejecuta handshakes, canales, lectores de
PTY, escritores y colectores. El estado compartido usa `Arc` + `RwLock`/`Mutex`.

## 2. Módulos y contratos

### `models`

DTOs serializables. Regla clave: los campos secretos de `ConnectionProfile` llevan
`#[serde(skip_serializing)]`; el frontend recibe `ProfileView` con flags booleanos.

### `infrastructure::storage`

- `open`: abre SQLite, crea el esquema, migra `nexshell.json` y ajusta permisos.
- `upsert/delete`: escritura bajo mutex; WAL.
- `known_host(host, port)` y `remember_host`.
- `insert_log/list_logs/clear_logs/prune_logs` para la auditoría.

No conoce el cifrado; recibe `secret_blob` ya cifrado.

### `ssh`

- `KnownHostsStore::verify_or_record` implementa TOFU.
- `SshConnection::connect` aplica timeouts de handshake y auth.
- `exec` abre un canal por comando y limita la salida a 4 MiB.
- `open_shell` solicita PTY 256 colores y divide el canal.
- `ShellWriter` oculta el tipo privado `russh::client::Msg` tras un trait object.

### `application::pool`

`ConnectionPool` mantiene `idle: Vec<IdleConnection>` y `total`.

Invariantes:

- `total <= maxConnections` en todo momento.
- `idle.len() <= total`.
- Un lease siempre posee exactamente un `Arc<SshConnection>`.
- Al soltar: si el transporte está vivo y el pool abierto → idle; si no → `total -= 1`.

El registro `PoolManager` crea pools perezosamente y los invalida al guardar/borrar
perfiles.

### `application::terminal`

El manager mantiene `sessionId → TerminalSession`. La sesión conserva el lease, el
`Sender` de entrada y un flag `closed`.

- El lector es el dueño del `ChannelReadHalf`; al terminar emite `terminal:closed`
  y elimina la sesión (libera lease).
- El escritor consume `InputMsg::{Data, Resize, Close}`.
- `terminal_close` es idempotente.

### `application::metrics`

`MetricsService` tiene un watcher por perfil. Cada muestra:

1. `pool.acquire()`.
2. `exec(script)` con timeout de 10 s.
3. Parseo y cálculo de deltas.
4. `emit("metrics:update")`.

El lease se libera al final de cada muestra: el monitor no monopoliza el pool.

### `application::services`

`ServiceSpec` encapsula rutas/binarios. Las operaciones privilegiadas usan
`maybe_sudo(profile, comando)` por comando. La escritura de configuración es una
transacción con backup y rollback.

## 3. Secuencia: abrir una terminal

```text
UI                Command               Pool                Host
│ terminal_open     │                    │                   │
├──────────────────►│ acquire ──────────►│                   │
│                   │                    ├─ connect ────────►│
│                   │                    │◄─ auth OK ────────┤
│                   │◄─ lease ───────────┤                   │
│                   │ open_shell ────────┼──────────────────►│ PTY + shell
│                   │◄─ read/write halves ───────────────────┤
│◄─ TerminalInfo ───┤                    │                   │
│◄─ terminal:data ──┼────────────────────┼───────────────────┤
│ terminal_write ──►│ mpsc ──► writer ───┼──────────────────►│
```

## 4. Secuencia: guardar configuración

```text
UI             ServiceManager                     Host
│ write          │                                  │
├───────────────►│ validate path/root               │
│                ├─ test -f ───────────────────────►│
│                ├─ cp path backup ────────────────►│
│                ├─ base64 | tee path ─────────────►│
│                ├─ nginx -t / apachectl ──────────►│
│                │◄─ rc=0 ──────────────────────────┤
│◄─ ok + backup ─┤                                  │
│                │  (si rc!=0 → cp backup path)     │
```

## 5. Concurrencia y ciclo de vida

- Los comandos async no bloquean el hilo de UI.
- Los locks no se mantienen a través de `.await` (excepto `RwLock` de mapas, con
  secciones cortas y sin I/O).
- `PoolLease::drop` es síncrono y no hace I/O.
- Los watchers de métricas se abortan al cerrar la pestaña.
- Al borrar un perfil: se cierran terminales, se detiene el monitor y se invalida el pool.

## 6. Puntos de extensión

- **Nuevo servicio web**: añadir variante a `WebService`, su `ServiceSpec`, y el mapeo
  en el frontend (el resto es genérico).
- **Nueva métrica**: añadir sección al script, parser y campo a `MetricsSnapshot`.
- **Acción de proceso**: `application/processes.rs` resuelve `/proc/<pid>/{cwd,exe}` y
  ejecuta `kill -SIG`; la terminal de proceso usa `TerminalOptions.initial_directory`.
- **Archivos grandes**: `application/filesystem.rs` ejecuta el pipeline de `find`/`du`,
  parsea tamaños humanos y ofrece `stat`/`du` y `rm` con las mismas reglas de elevación.
- **Auditoría**: `application/audit.rs` persiste eventos; `PoolManager` los genera para
  conexiones/exec, `TerminalManager` para sesiones y los comandos para test/detección.
- **Nuevo método de auth**: extender `AuthMethod` y el match en `SshConnection::connect`.
- **Nuevo transporte (túnel)**: reutilizar el pool y añadir un método a `SshConnection`.
