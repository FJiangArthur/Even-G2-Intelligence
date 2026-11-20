# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting), or
2. if that is unavailable, open an issue that says only "security contact requested" with no details, and a maintainer will set up a private channel.

Include what you found, how to reproduce it, and the Helix version. You should get a first response within a week. Please give a reasonable time to fix the problem before publishing details.

## Scope

Helix runs as a web plugin inside the Even Realities phone app and calls AI providers directly with the user's own keys. Things that are in scope:

- a key, transcript or saved session leaving the phone to anywhere other than the provider the user selected;
- credentials ending up in the package, the logs, the diagnostics report or local history;
- content from a transcript, an imported note or a provider response being executed as code or markup in the companion UI;
- requests to hosts outside the `app.json` network whitelist.

Out of scope: the Even Realities app, SDK, firmware and Even Hub (report those to Even Realities), and the AI providers' own services.

## Design notes that matter for security

- API keys are runtime input. They are kept in memory unless the user chooses "save on phone", which uses the Even app's plugin storage; that storage is not an encrypted vault.
- No key is read from build-time environment variables, and `scripts/run_gate.sh` fails the build when credential-like strings or `VITE_*` secret variables appear in the tree.
- Provider calls use fixed URLs with redirects disabled, so a key is not forwarded to another host.
- The diagnostics log redacts key-like strings and records control ids, never on-screen text.

## Supported versions

Only the latest release on `main` receives fixes.
