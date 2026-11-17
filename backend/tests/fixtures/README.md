# Isolated database fixtures

Tests create disposable SQLite databases in temporary directories. No
production database or cartridge data belongs in this directory. A local
developer may place a disposable `store.sqlite` here for the
read-only Docker Compose backend profile; SQLite files in this directory are
ignored by Git.
