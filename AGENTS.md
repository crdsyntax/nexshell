# AGENTS — 2Shell

## Contexto

Prototipo de consola SSH multi-terminal (Tauri 2 + Rust + React). La arquitectura de
referencia es `../toketeo`: capas `presentation/tauri → application → infrastructure`,
`russh` para SSH, eventos Tauri para streaming y zustand en el frontend.

Antes de cambios no triviales, lee:

- `specs/remote-terminal/spec.md`
- `specs/remote-terminal/design.md`
- `docs/architecture.md`
- `docs/security.md`

## Comandos

```bash
bun install
cd frontend && bun install && cd ..
bun run dev

cd frontend && bun run check && bun run build
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo clippy --lib --all-targets -- -D warnings
cd src-tauri && cargo test --lib
```

## Estructura

- `src-tauri/src/presentation/tauri/commands.rs`: comandos IPC. Sin lógica de negocio.
- `src-tauri/src/application/`: perfiles, pool, terminal, métricas, servicios, procesos, archivos y auditoría.
- `src-tauri/src/infrastructure/`: SQLite (WAL), migración JSON y AES-256-GCM.
- `src-tauri/src/ssh/`: handshake, auth, known hosts, exec, PTY.
- `src-tauri/src/models/`: DTOs serde; los secretos nunca se serializan.
- `frontend/src/store/useAppStore.ts`: estado de UI.
- `frontend/src/lib/terminalBus.ts`: puente eventos Tauri → xterm.

## Reglas

1. Ningún secreto en texto plano en disco ni en respuestas IPC.
2. Todo acceso remoto pasa por `SshConnection`/`PoolManager`; no uses `std::process`.
3. Comandos de servicio: enums + `shell_quote` + `maybe_sudo` por comando.
4. Rutas de configuración confinadas a `configRoot`; rechaza `..` y controles.
5. Toda escritura de config debe validar y restaurar el backup si falla.
6. Los paneles de terminal/monitor se mantienen montados; no añadas polling en la UI
   si el backend ya emite eventos.
7. Actualiza `spec.md` (R/AC) y `tasks.md` al añadir funcionalidad.
8. Añade tests unitarios para parsers, validaciones y cálculos.
9. No commitees, publiques ni abras PRs sin pedido explícito.

## Convenciones

- Rust 2021, `AppResult`, errores accionables en `AppError`.
- TypeScript estricto; sin `any` implícito.
- Nombres de comandos `snake_case`; argumentos camelCase desde JS (Tauri).
- Eventos: `terminal:data`, `terminal:closed`, `metrics:update`, `metrics:error`.
- UI en español o inglés consistente; el README está en español.

## Seguridad al tocar privilegios

- No introduzcas `sudo sh -c`; prefija binarios concretos.
- `elevated` requiere NOPASSWD y debe documentarse en la UI.
- Si añades una ruta de configuración, valídala con `validate_config_path`.
