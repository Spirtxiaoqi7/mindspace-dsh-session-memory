# Contributing

Bug reports and focused pull requests are welcome. Please include the DeepSeek
Harness commit or release, Node version, profile patch, and the smallest session
event sequence that reproduces the problem.

Before opening a pull request, run:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm pack --pack-destination dist
```

Memory extraction changes must remain conservative: persist explicit user
statements, do not infer sensitive attributes, and preserve per-session isolation.
