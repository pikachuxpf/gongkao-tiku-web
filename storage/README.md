# Runtime database

The server creates `mojuan.sqlite` here on first start. SQLite files are intentionally ignored because they contain user accounts, session tokens, answer drafts, and private learning records.

The portable schema, migrations, and bootstrap administrator logic live in `server/sqlite-store.mjs`. Use `MOJUAN_DB` to place the database on a persistent volume in deployment, and back up the SQLite database together with its `-wal` file when the service is stopped.
