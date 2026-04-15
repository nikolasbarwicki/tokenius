# Preferred Bun APIs

Use Bun built-ins over third-party equivalents:

| Use                  | Instead of                 |
| -------------------- | -------------------------- |
| `Bun.serve()`        | express                    |
| `bun:sqlite`         | better-sqlite3             |
| `Bun.redis`          | ioredis                    |
| `Bun.sql`            | pg/postgres.js             |
| `Bun.file`           | node:fs readFile/writeFile |
| `Bun.$`              | execa                      |
| Built-in `WebSocket` | ws                         |
