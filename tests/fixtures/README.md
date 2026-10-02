# Git fixtures

Deterministic Git repositories for Rust, browser/native E2E and performance tests. Each shell script describes one fixture; `gen-perf-100k.py` generates the large history. Tests copy generated fixtures into isolated temporary directories.

```sh
node tests/fixtures/build.mjs --list
node tests/fixtures/build.mjs
node tests/fixtures/build.mjs linear divergent
node tests/fixtures/build.mjs --all
node tests/fixtures/build.mjs --check
node tests/fixtures/build.mjs --update-manifest
bash tests/fixtures/verify.sh
```

The Node entrypoint delegates to `build.sh`. Additional options include `--out DIR`, `--force`, `--tar`, `--fsck` and `--help`. Heavy fixtures are generated only when explicitly selected or with `--all`.

## Isolation and determinism

Output defaults to `target/fixtures/<name>/repo`, with sibling bare remotes or helper clones where required. Remote URLs are relative, so a copied fixture cannot mutate the original. Script hashes invalidate cached fixtures, and a lock protects concurrent generation.

The fixture library fixes Git identity, timestamps, locale, configuration and line-ending behavior. It ignores inherited Git environment variables and disables signing and maintenance. Call the fixture helpers for dated commits, tags and stashes to preserve deterministic timestamps.

`manifest.json` records HEAD and refs. Stashes are checked by message and tree, since their OIDs can vary with Git versions. When translating or changing fixture contents, regenerate the manifest, review it and check a second generation for determinism. Unicode path samples are retained to test encoding and normalization.

## Script conventions

Each `<name>.sh` declares `fixture`, `description`, `refs`, `head`, `worktree` and optionally `heavy` in its header. Source `lib.sh`, call `fx_init`, construct the history and finish with `fx_done`. Common shapes are in `shapes.sh`. Keep scripts compatible with Bash 3.2 and use the helper functions for predictable Git configuration.

Set `GITMINI_TEST_GIT` to test a particular Git executable (minimum 2.30). Rust and TypeScript test helpers use the same selection rules. See [testing](../../docs/testing.md) for the surrounding test suites.
