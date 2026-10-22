# Custom Taxonome handler example

This project keeps authored taxonomy YAML and a compiled deterministic handler
together. The YAML references only the origin-independent handler ID
`acme/retry-loop-v1`; the CLI loads code only through explicit `--plugin`.

The relevant project files are:

- `taxonomy.yaml` and `elements/retry-loop.yaml` — authored taxonomy contract;
- `src/handlers/index.ts` — typed handler, config validator, and plugin export;
- `dist/handlers/index.js` — compiled explicit plugin entry point;
- `inputs/run.atif.json` and `inputs/run.tar.gz` — equivalent input forms.

```bash
cd examples/taxonome-custom-handler
pnpm build

# Without the explicit plugin, the authored handler remains unknown.
pnpm --silent exec taxonome run inputs/run.atif.json --taxonomy taxonomy.yaml

# The same handler and taxonomy run against plain ATIF and a Scope archive.
pnpm --silent exec taxonome run inputs/run.atif.json \
  --taxonomy taxonomy.yaml --plugin ./dist/handlers/index.js
pnpm --silent exec taxonome run inputs/run.tar.gz \
  --taxonomy taxonomy.yaml --plugin ./dist/handlers/index.js
```

An installed `taxonome` binary uses the same relative arguments from this
directory:

```bash
taxonome run inputs/run.atif.json \
  --taxonomy taxonomy.yaml --plugin ./dist/handlers/index.js
```

Omitting `--plugin` fails with a concise unknown-handler error. Taxonome never scans
directories, installs packages, performs network lookup, or imports a path from
YAML.

Plugin imports and top-level code run with the Taxonome process's permissions.
Frozen inputs plus config/result validation protect correctness; they are not a
security sandbox. Load only explicitly trusted compiled JavaScript.
