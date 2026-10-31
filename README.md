# @sayedameer/bruno-openapi-sync

Sync an OpenAPI spec into a Bruno collection with interactive git-style diffs.

When your API spec changes, this tool imports the new spec into a temp dir, diffs each file against your existing Bruno collection, and lets you review/accept/skip changes one by one — just like `git add -p`.

## Installation

```bash
npm install -g @sayedameer/bruno-openapi-sync
```

Or run without installing:

```bash
npx @sayedameer/bruno-openapi-sync -s ./openapi.json -o ./bruno
```

## Prerequisites

`@usebruno/cli` must be available. Install it globally or as a project dependency:

```bash
npm install -g @usebruno/cli
# or
npm install --save-dev @usebruno/cli
```

## Usage

```
bruno-openapi-sync [options]

Options:
  -s, --source <path>  Path to OpenAPI JSON file (required)
  -o, --output <path>  Path to Bruno output directory (required)
  -y, --yes            Auto-accept all changes without prompting
      --sync-collection-headers  Sync collection headers (default: preserve Bruno headers)
  -h, --help           Show help
```

### Examples

```bash
# Interactive sync
bruno-openapi-sync -s ./openapi.json -o ./bruno

# Auto-accept all changes
bruno-openapi-sync -s ./openapi.json -o ./bruno --yes
```

### Interactive prompts

For each changed file you'll be prompted:

```
Apply this change? [y/n/a(all)/q(quit)]
```

- **y** — apply this change
- **n** — skip this change
- **a** — apply this and all remaining changes
- **q** — quit without applying further changes

New files are always added automatically. Deleted files (removed from spec) prompt for confirmation.

Collection headers configured in Bruno are preserved by default. Pass `--sync-collection-headers` to replace them with headers from the imported collection instead. If the import has no collection headers, this flag allows existing collection headers to be removed. Changes still follow the usual diff and confirmation flow (`--yes` accepts them automatically). Request-level headers sync as usual.

Collection variables configured in Bruno are always preserved, including when `--sync-collection-headers` is enabled. This applies to `request.variables` in OpenCollection YAML and the `vars:pre-request` / `vars:post-response` blocks in `collection.bru`.

Collection authentication is also always preserved, including its mode, credentials, and OAuth2 parameters. This applies to `request.auth` in OpenCollection YAML and all `auth` / `auth:*` blocks in `collection.bru`. If an existing collection has no authentication configured, imported authentication is removed. New collections use authentication from the import.

Existing JSON request bodies keep filled values (including `0` and `false`), nested object fields, and non-empty arrays. New fields are added from the import; `null`, empty strings, and empty arrays use imported values. Existing custom object fields are kept. This applies when both versions have a JSON body, in OpenCollection YAML or `.bru` files. Invalid JSON stops the sync before collection files are changed.

Filled query and path parameter values are preserved by matching parameter name and type, including `0`, `false`, and variable references. New parameters and other parameter settings come from the import; parameters removed from the spec are removed. Empty values use imported defaults. This applies to `http.params` in OpenCollection YAML and `params:query`, `params:path`, and legacy `query` blocks in `.bru` files.

Existing `auth: inherit` settings are preserved when syncing OpenCollection YAML and `.bru` requests, so imported authentication does not override inheritance. Other request authentication modes sync as usual.

Sync preserves existing folder names when they differ from imported names only by spaces versus underscores (for example, `Admin merchant management` and `Admin_merchant_management`). New folders use spaces instead of underscores; existing folders are never renamed. Exact names take priority; ambiguous matches stop the sync before collection files are changed.

## Programmatic API

```ts
import { sync } from '@sayedameer/bruno-openapi-sync';

await sync({
  source: './openapi.json',
  output: './bruno',
  yes: true, // optional, auto-accept all
  syncCollectionHeaders: true, // optional, default: false (preserve Bruno collection headers)
});
```

## License

MIT
