# bakker

`bakker` is a shell CLI for Bakker that can:
- list backups via Bakker API
- import backups into configured destination databases

## Requirements

- `docker`
- `curl`
- access to Docker image `sebaswouters/bakker:latest` (or override image)

## Install

```bash
chmod +x cli/bakker
```

Optional shell alias:

```bash
alias bakker="$PWD/cli/bakker"
```

## Configuration

Create `~/.config/bakker/config.toml`:

```bash
mkdir -p ~/.config/bakker
cp cli/config.toml.example ~/.config/bakker/config.toml
```

Config includes all non-secret options:
- Bakker URL
- tooling image
- optional docker network for image runs
- output/confirmation defaults
- destination DB profiles

Passwords are never read from config.

For import destination passwords:
- The CLI first checks env var `<PROFILE>_DB_PASS` (profile uppercased, non-alphanumeric characters converted to `_`).
- Example: profile `local-dev` -> `LOCAL_DEV_DB_PASS`.
- If the env var is not set, the CLI prompts interactively.

## Auth Token

- If `BAKKER_AUTH_TOKEN` is set, it is used automatically.
- If not set, the CLI prompts interactively for the token when an API call is made.

## Usage

List backups:

```bash
cli/bakker backups list
cli/bakker backups list --db prod
cli/bakker backups list --db prod --latest
cli/bakker backups list --json
```

Import backup:

```bash
cli/bakker import --profile local_dev --file prod_20260205_120000.sql.gz
cli/bakker import --profile local_dev --db prod --latest
```

Profile commands:

```bash
cli/bakker profiles list
cli/bakker profiles show local_dev
```

Doctor:

```bash
cli/bakker doctor
```

## Global Overrides

All options can be configured in TOML and overridden by CLI flags:

```bash
cli/bakker --config /path/config.toml --api-url http://127.0.0.1:3500 --image sebaswouters/bakker:latest backups list
```
