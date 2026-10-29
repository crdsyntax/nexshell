<p align="center">
  <img src="docs/logo.svg" width="96" height="96" alt="2Shell logo">
</p>

# 2Shell

Consola de operaciones remotas multi-terminal construida con **Rust + Tauri 2 + React**.
Abre varias terminales SSH (PTY real) dentro de la aplicación, vigila el rendimiento del
host en tiempo real y administra **nginx**, **apache2** y **httpd** sin salir del escritorio.

> Prototipo funcional. La arquitectura sigue el modelo por capas:
> `presentation/tauri → application → infrastructure`, con `russh`, pooling explícito,
> eventos Tauri y estado React (zustand).

![Terminal](docs/screenshot-terminal.jpg)

## Funcionalidades

- **Terminales SSH reales**: canal PTY (`xterm-256color`) con `russh`, redimensionado,
  scrollback y varias pestañas por host. xterm.js renderiza la salida en streaming.
- **Multi-terminal**: cada pestaña consume una conexión del pool del perfil; se pueden
  abrir terminales de distintos perfiles al mismo tiempo.
- **Perfiles de conexión**: contraseña o clave privada (ruta local elegida con el
  diálogo nativo de archivos o clave pegada), passphrase, color, entorno, tags y timeouts.
  Al elegir una clave cifrada se avisa y se enfoca el campo de passphrase.
- **Pool de conexiones** por perfil con tamaño máximo, timeout de adquisición, reciclado
  por inactividad y **reintentos con backoff exponencial + jitter**. Los fallos de
  autenticación o validación **no se reintentan** (evita bloqueos/fail2ban).
- **Detección del servidor**: SO, distro y familia, kernel, arquitectura, init system,
  gestor de paquetes, shell, CPU, RAM, contenedor, fingerprint SSH y servidores web
  instalados. Se muestra en la barra superior y en el test de conexión.
- **Monitor tipo htop**: CPU total y por núcleo, memoria/swap, load average, uptime,
  red (rx/tx), disco raíz y tabla de procesos, con muestreo configurable (1–10 s) y
  gráficas de historial. Cada proceso permite **abrir su directorio de trabajo en una
  terminal nueva** o **enviarle SIGTERM/SIGINT/SIGKILL** con confirmación. La tarjeta
  **Root filesystem** incluye un escaneo de los 20 archivos más grandes
  (`find / -xdev | du | sort -rh`), con acciones para abrir su carpeta, ver propiedades
  y eliminarlos.
- **Gestión de MariaDB/MySQL**: lista usuarios y hosts, muestra plugins y grants,
  cambia contraseñas con generación segura y prueba la nueva credencial. No modifica
  automáticamente el `.env` de la aplicación.
- **SSH Access**: lista claves autorizadas, añade/elimina claves públicas y activa el
  acceso **solo por clave**, deshabilitando `PasswordAuthentication` mediante un
  drop-in validado y reversible de `sshd`.
- **Cron**: visor de crontabs de root y usuarios, `/etc/crontab`, `/etc/cron.d`,
  tareas periódicas, systemd timers, `at` y anacron, con marca de entradas sospechosas
  (incluye `docker start`/`docker run`). Las entradas de crontab, `/etc/crontab` y
  `/etc/cron.d` se pueden **eliminar con backup previo y confirmación**.
- **Monitor en dos columnas**: Top processes a la izquierda y PM2 a la derecha, más un
  visor de procesos Node activos.
- **Network**: pestaña dedicada con puertos en escucha, conexiones establecidas, proceso
  y PID, marca de exposición pública y resumen de sockets/DNS/ruta.
- **Forensics**: historial de accesos SSH con IPs, artefactos de `/root` con fechas de
  creación y etiquetas (IDE/CLI de IA, herramientas, credenciales), búsqueda recursiva y
  detección de credenciales sin exponer valores.
- **Sudoers**: en Security, grupos con privilegios, reglas con `NOPASSWD` resaltado,
  cuentas referenciadas (existencia, UID, shell, estado de contraseña, último login,
  claves SSH) y acciones para **eliminar una regla** (backup + `visudo -c` + rollback) o
  **bloquear/desbloquear** la cuenta y ver el **origen** de la cuenta: quién la creó
  (`auid`), desde qué IP, cuándo, con evidencia de auditd/secure/sudo/last.
- **Árbol de archivos en la terminal**: panel derecho tipo VS Code que sigue el `cd`
  (OSC 7), distingue carpetas/archivos/ocultos/vacíos y permite crear, renombrar,
  eliminar, copiar ruta y abrir terminal en la carpeta. Doble clic en un archivo de texto
  abre un **editor remoto** (vim/nano/vi) en un modal con PTY.
- **PM2**: en la pestaña Monitor se listan las apps con estado, CPU, memoria,
  reinicios y uptime; se pueden iniciar, detener, reiniciar o eliminar del listado y
  ver el tail de los logs `out`/`error`.
- **Incident**: escaneo de procesos desde directorios temporales, binarios/scripts
  ocultos, variables de entorno sospechosas, conexiones salientes, claves autorizadas,
  historial de root y contenedores. Permite **matar el proceso**, **poner en
  cuarentena** el binario con hash SHA-256 y **bloquear la IP** en iptables/firewalld.
- **Backups de cron**: cada borrado queda en `/var/backups/2shell/cron` y se puede
  **restaurar** desde la propia vista. Avisa si la entrada no era sospechosa.
- **Remediación**: los hallazgos corregibles muestran un botón **Solucionar** que aplica
  el fix con validación y rollback (sshd, permisos, puertos de base de datos y cron
  sospechoso). Los que requieren criterio humano se marcan como `manual`.
- **Auditoría de seguridad**: score 0–100 y hallazgos priorizados sobre SSH, firewall,
  SELinux/AppArmor, actualizaciones, cuentas UID 0, contraseñas vacías, permisos,
  puertos de bases de datos expuestos, SUID, `/tmp`, `ld.so.preload`, fuerza bruta y cron.
  Historial persistido en SQLite.
- **Gestión de nginx / apache2 / httpd**: estado, start/stop/restart/reload, `configtest`,
  exploración y edición de configuración con **backup + validación + rollback automático**,
  y tail de logs.
- **Seguridad de credenciales**: AES-256-GCM en reposo, secretos nunca serializados hacia
  el frontend y verificación de host keys (TOFU).
- **Persistencia SQLite y auditoría**: perfiles, host keys y un log de ejecuciones
  (conexiones, comandos, terminales, servicios, procesos y archivos) con filtros,
  búsqueda, detalle y limpieza desde la pestaña **Audit**.

![Monitor](docs/screenshot-monitor.jpg)

![Largest files](docs/screenshot-large-files.jpg)

![File properties](docs/screenshot-file-properties.jpg)

![Kill process](docs/screenshot-process-kill.jpg)

![Seguridad](docs/screenshot-security.jpg)

![Cron](docs/screenshot-cron.jpg)

![SSH access](docs/screenshot-ssh-access.jpg)

![Servicios](docs/screenshot-services.jpg)

![Service chip tooltip](docs/screenshot-service-tooltip.jpg)

![Audit](docs/screenshot-audit.jpg)

![Audit detail](docs/screenshot-audit-detail.jpg)

## Arquitectura

```mermaid
flowchart LR
  UI[React + xterm.js] -->|invoke| CMD[presentation/tauri/commands.rs]
  CMD --> PROF[application/profiles.rs]
  CMD --> POOL[application/pool.rs]
  CMD --> TERM[application/terminal.rs]
  CMD --> MET[application/metrics.rs]
  CMD --> SVC[application/services.rs]
  POOL --> SSH[ssh/mod.rs russh]
  TERM --> SSH
  MET --> SSH
  SVC --> SSH
  PROF --> STORE[infrastructure/storage.rs]
  PROF --> CRYPTO[infrastructure/crypto.rs]
  SSH --> EV[(Tauri events)]
  MET --> EV
  TERM --> EV
  EV -->|listen| UI
```

| Capa | Responsabilidad |
| --- | --- |
| `presentation/tauri` | Comandos IPC, validación de entrada, mapeo a servicios |
| `application` | Perfiles, pool, terminales, métricas, servicios web |
| `infrastructure` | Persistencia SQLite (WAL) y cifrado AES-256-GCM |
| `ssh` | Handshake, autenticación, known hosts, exec, PTY/shell |
| `frontend` | UI React, xterm.js, zustand, servicios de IPC |

### Flujo de una terminal

1. `terminal_open(profileId, cols, rows)` adquiere un lease del pool.
2. `SshConnection::open_shell` abre un canal, solicita PTY y shell.
3. El canal se divide en `ChannelReadHalf` / `ChannelWriteHalf`.
4. El lector emite `terminal:data` con base64 (preserva UTF-8 entre paquetes).
5. El escritor consume un `mpsc` con datos, resize y close.
6. Al cerrarse el canal remoto se emite `terminal:closed` y se libera el lease.

### Pool y reintentos

- Máximo de transportes por perfil (`pool.maxConnections`).
- `acquire_timeout_ms` para esperar un transporte libre.
- `idle_timeout_secs` descarta transportes ociosos o cerrados.
- Cada intento de conexión usa `connect_timeout_secs`; los fallos se reintentan
  `max_retries` veces con backoff `base * 2^n`, limitado por `max_delay_ms` y jitter.
- El estado (`inUse`, `idle`, `total`) se muestra en la barra de estado.

## Estructura del proyecto

```text
nexshell/
├── frontend/
│   └── src/
│       ├── components/     # Sidebar, terminal, monitor, servicios, modal
│       ├── services/       # wrappers tipados de comandos Tauri
│       ├── store/          # zustand: perfiles, pestañas, métricas
│       ├── lib/            # IPC, bus de terminal, formato, acciones
│       └── types/
├── src-tauri/
│   └── src/
│       ├── presentation/tauri/commands.rs
│       ├── application/{profiles,pool,terminal,metrics,services}.rs
│       ├── infrastructure/{crypto,storage}.rs
│       ├── ssh/mod.rs
│       ├── models/mod.rs
│       └── state.rs
├── specs/remote-terminal/  # spec, design y tasks (SDD)
├── docs/
└── package.json
```

## Almacenamiento y auditoría

Linux:

```text
~/.local/share/com.nexshell.app/
├── nexshell.db          # SQLite (WAL): profiles, known_hosts, execution_logs
├── nexshell.db-wal
├── nexshell.db-shm
├── master.key           # clave AES-256-GCM, modo 0600
└── nexshell.json.migrated  # backup del almacén JSON anterior
```

- `profiles`: configuración completa del perfil en `config_json` y credenciales
  cifradas en `secret_blob`. Los secretos no se guardan en claro.
- `known_hosts`: fingerprint SSH por `host:port` (TOFU).
- `execution_logs`: timestamp, perfil, categoría, acción, objetivo, comando, estado,
  exit code, duración, salida y error. Retención: 10.000 entradas.
- `security_audits`: informe completo de cada auditoría (score, hallazgos y cron) para
  consultar el historial desde la pestaña Security.
- `cron_backups`: origen, ruta del backup, entradas eliminadas y fecha de cada borrado
  de cron, para poder restaurarlo.
- Migración automática: al arrancar, si la base está vacía y existe `nexshell.json`,
  importa perfiles y host keys y renombra el JSON a `.migrated`.
- La base y sus sidecars `-wal`/`-shm` se fuerzan a modo `0600`.

> El identificador interno de la aplicación y la carpeta de datos siguen siendo
> `com.nexshell.app` / `nexshell.db` para no perder perfiles, host keys ni el log al
> rebrandear. La marca visible es **2Shell**.

El log **no** registra las pulsaciones dentro de una terminal (privacidad y volumen):
registra la apertura/cierre de sesiones y todos los comandos ejecutados por la app
(conexión, detección, servicios, procesos, archivos, `remote_exec`). Los sondeos de
métricas y de estado de servicios se excluyen para no inundar el log.

## Requisitos

- Linux (probado) con `webkit2gtk-4.1`, `gtk+-3.0` y dependencias de Tauri 2.
- Rust estable ≥ 1.77.
- [Bun](https://bun.sh) ≥ 1.1 (o npm/pnpm adaptando los scripts).
- Un host SSH accesible. Para gestionar servicios, sudo sin contraseña o permisos
  equivalentes.

## Arranque

```bash
# dependencias
bun install
cd frontend && bun install && cd ..

# desarrollo (levanta Vite + Tauri)
bun run dev
```

> Si aparece `tauri: command not found`, falta instalar las dependencias del
> proyecto raíz. Ejecuta `bun install` en `nexshell/` (no solo en `frontend/`).

Build de producción:

```bash
bun run build          # tauri build (deb/appimage)
# o solo el binario:
bun run frontend:build
cd src-tauri && cargo build --release
```

Comprobaciones:

```bash
cd frontend && bun run check && bun run build
cd src-tauri && cargo test --lib && cargo clippy --lib --all-targets -- -D warnings
```

## Uso

1. **Nueva conexión** → host, puerto, usuario y credenciales.
2. **Test connection** valida el handshake, detecta el servidor y muestra fingerprint,
   SO, kernel, CPU/RAM y servidores web.
3. **Terminal** abre una pestaña PTY. El botón `+` del host abre otra terminal.
4. **Monitor** inicia el muestreo (por defecto 2 s) y pinta CPU, memoria, red,
   disco y procesos.
5. **Services** detecta nginx/apache2/httpd. Permite operar el servicio y editar
   archivos `.conf`: guarda un backup, escribe, ejecuta el `configtest` y restaura
   si falla.

### Sudo para servicios

La opción *Use `sudo -n` for service actions* prefija **cada comando** con `sudo -n`
(no envuelve scripts completos), de modo que sudoers puede limitar binarios.
Ejemplo orientativo en `/etc/sudoers.d/twoshell`:

```sudoers
Cmnd_Alias TWOSHELL = /usr/bin/systemctl, /usr/sbin/service, \
  /usr/sbin/nginx, /usr/sbin/apache2ctl, /usr/sbin/httpd, \
  /usr/bin/cp, /usr/bin/find, /usr/bin/cat, /usr/bin/readlink, /usr/bin/tee, \
  /usr/bin/tail, /usr/bin/journalctl, /usr/bin/test, /usr/bin/base64, \
  /usr/bin/stat, /usr/bin/du, /usr/bin/rm, /usr/bin/kill, \
  /usr/bin/mariadb, /usr/bin/mysql

deploy ALL=(root) NOPASSWD: TWOSHELL
```

Si al abrir un archivo aparece **“permission denied”**, el usuario SSH no puede
leerlo (habitual en configuraciones propiedad de root con modo 600). Activa
*Use `sudo -n` for service actions* en el perfil y configura NOPASSWD para los
binarios de la whitelist, o ajusta los permisos del archivo en el servidor.
Si aparece **“sudo requires a password”**, falta NOPASSWD; la app no solicita ni
almacena la contraseña de sudo.

> Esta whitelist es amplia: `tee`/`cp` con argumentos arbitrarios permiten escribir
> archivos como root. Para producción, sustitúyela por un helper privilegiado que
> valide rutas y acciones, o por polkit.

## Comandos IPC

| Comando | Descripción |
| --- | --- |
| `list_profiles`, `save_profile`, `delete_profile` | CRUD de perfiles (secretos cifrados) |
| `test_profile` | Handshake + detección sin persistir |
| `connect_profile`, `disconnect_profile` | Abrir/cerrar un transporte del pool |
| `detect_server` | Inspección del host vía SSH |
| `pool_stats` | Estado del pool del perfil |
| `remote_exec` | Ejecución puntual de un comando |
| `terminal_open/write/resize/close/list` | Ciclo de vida de terminales |
| `terminal_open_process` | Nueva terminal en el `cwd` de un proceso |
| `process_locate` | `cwd`, ejecutable y comando de un PID |
| `process_kill` | Envía TERM, INT o KILL a un PID |
| `disk_large_files` | Top 20 de archivos grandes en `/` (`-xdev`) |
| `file_properties` | `stat`/`du` de un archivo |
| `file_delete` | Elimina un archivo con confirmación en la UI |
| `terminal_open_directory` | Nueva terminal en un directorio |
| `list_execution_logs` | Consulta el log con filtros y paginación |
| `clear_execution_logs` | Borra logs (global o de un perfil) |
| `audit_db_path` | Ruta de la base SQLite |
| `database_info/users/grants` | Inspección de MariaDB/MySQL |
| `database_change_password` | Cambia una clave y prueba el login |
| `cron_list` | Crontabs, timers, at jobs y actividad reciente |
| `cron_delete_entry` | Elimina una entrada de cron con backup |
| `ssh_keys`, `ssh_config` | Claves autorizadas y estado de sshd |
| `ssh_add_key`, `ssh_remove_key` | Alta/baja de claves públicas |
| `ssh_set_key_only` | Activa/desactiva PasswordAuthentication |
| `run_security_audit` | Auditoría completa y persistencia |
| `list_security_audits`, `get_security_audit` | Historial de auditorías |
| `apply_security_fix` | Aplica un fix validado con rollback |
| `cron_list_backups`, `cron_restore_backup` | Historial y restauración de cron |
| `incident_scan` | Procesos, archivos, entorno, red y persistencia |
| `incident_kill_process` | Mata un proceso de `/tmp`, `/dev/shm` o borrado |
| `incident_quarantine` | Mueve un binario a cuarentena con hash |
| `incident_block_ip` | Bloquea/desbloquea una IP |
| `pm2_list` | Apps de PM2 con métricas |
| `pm2_action` | start/stop/restart/reload/delete |
| `pm2_logs` | Tail de out/error logs |
| `node_processes` | Procesos Node/PM2 con CPU y memoria |
| `network_scan` | Puertos y conexiones |
| `sudoers_report` | Grupos, reglas y cuentas de sudoers |
| `sudoers_remove_rule` | Elimina una regla con backup y visudo |
| `system_user_lock` | Bloquea/desbloquea una cuenta |
| `account_origin` | Forense de creación: actor, IP y fecha |
| `monitor_start/stop/snapshot` | Colector de métricas y última muestra |
| `service_detect/status/action` | Detección y control de servicios |
| `service_config_list/read/write` | Configuración con validación y rollback |
| `service_logs` | Tail de log o journalctl |

Eventos: `terminal:data`, `terminal:closed`, `metrics:update`, `metrics:error`.

## Pruebas

```bash
cd src-tauri && cargo test --lib
```

Cubren cifrado, persistencia sin secretos, parser de detección de servidor, parser
de `/proc` (CPU por deltas, memoria, red, procesos), backoff/jitter del pool y
confinamiento de rutas de configuración.

Para una prueba manual de extremo a extremo hay un host de demo con OpenSSH, nginx y
Apache (sin systemd, para probar el fallback a `service`):

```bash
docker build -f dev/Dockerfile.demo -t 2shell-demo .
docker run --rm -p 2222:22 --name 2shell-demo 2shell-demo
```

Conéctate a `127.0.0.1:2222` con `deploy/deploy` (marca *elevated*). Instrucciones en
[`docs/demo.md`](docs/demo.md).

## Limitaciones del prototipo

- La clave maestra AES se guarda en `app_data_dir/master.key` (0600). En producción
  debe vivir en el keyring del SO o Tauri Stronghold.
- El log de auditoría guarda comandos y salidas; puede contener rutas o datos
  sensibles. Usa la pestaña Audit para revisarlo o limpiarlo.
- Host keys por TOFU: la primera conexión confía; una discrepancia posterior se rechaza
  sin diálogo de aceptación.
- Solo autenticación por contraseña o clave; no keyboard-interactive/2FA, agent
  forwarding ni SFTP.
- Las métricas asumen Linux (`/proc`, `ps`, `df`). No hay soporte BSD/macOS/Windows.
- `service_config_list` usa `find -printf` (GNU find); en BusyBox puede devolver vacío.
- Los symlinks de `sites-enabled` se validan con `readlink -f`; un destino fuera del
  `configRoot` se rechaza.
- Las rutas de configuración son las de distros Debian/RHEL; nginx en rutas no estándar
  requiere ampliar `ServiceSpec`.
- No hay persistencia de pestañas ni reconexión automática infinita: la terminal ofrece
  un botón *Reconnect* y el backend reintenta la conexión inicial.
- La gestión de SSH keys y `sshd` espera un perfil SSH **root**. Si se usa un perfil
  no-root con `elevated`, el backend emplea `sudo -n sh -c`, lo que equivale a root;
  no lo uses en producción sin asumir ese riesgo.
- Deshabilitar `PasswordAuthentication` puede dejar fuera a los usuarios sin clave
  válida. La app exige confirmación y al menos una clave, pero no puede probar el login
  por ti: conserva la sesión abierta y prueba en otra terminal antes de cerrarla.
- La auditoría es una capa de detección, no un sustituto de un análisis forense. El
  estado de parches depende de los backports de la distribución.
- Cambiar la contraseña de MariaDB no actualiza el `.env` ni reinicia la aplicación;
  hazlo manualmente después.

## Roadmap

- Keyring del SO y firma de actualizaciones.
- Agent forwarding, SFTP y túneles locales/remotos.
- Soporte de `systemd` units arbitrarias y Caddy.
- Historial de comandos y auditoría firmada.
- Tests de integración contra un servidor SSH embebido.
