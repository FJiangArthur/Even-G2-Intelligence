# Contributing to Helix G2

Thanks for helping. This is a small project; a short issue before a large change saves everyone time.

## Setup

Node.js 22+ and npm.

```bash
npm install
npm run dev:plugin
npx evenhub-simulator http://localhost:5173 --automation-port 9898
```

## Before you open a pull request

```bash
bash scripts/run_gate.sh
```

The gate builds all three workspaces, runs every test, and fails if anything that looks like a credential is in the tree. CI runs the same script, and `main` only accepts pull requests whose gate passed.

- Keep orchestration in `packages/conversation-sdk` and Even SDK / display / input code in `apps/g2-plugin` ([AGENTS.md](AGENTS.md) lists the boundaries).
- Add or update tests with the change. Tests use fake providers and a fake bridge: no network, no keys.
- Say what you verified and where: unit test, simulator, or real glasses. Simulator success is not hardware acceptance.
- One topic per pull request. Describe the behaviour change, not only the code change.

## Secrets and personal data

- Never commit API keys, tokens, `.env` files, real transcripts, recordings or screenshots that show someone's conversation.
- Test fixtures must be synthetic. Fake keys in tests must be short and obviously fake (the gate rejects `sk-` followed by 20 or more characters).
- Keys are runtime input on the phone. Do not add `VITE_*` variables or build steps that carry credentials into the package.
- If you find a committed secret, do not open a public issue: follow [SECURITY.md](SECURITY.md).

## Reporting bugs

For a freeze or crash on the phone, reopen Helix, go to Setup → Diagnostics → Copy, and paste the log into the issue. It contains lifecycle events, control names and timings, and no keys or transcripts. Include the Helix version, phone model and OS, and whether it was a private, beta or store build.

## Conduct

Be respectful and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
