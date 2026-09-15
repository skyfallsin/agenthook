# Security

## Ingress

- Bind agenthook to loopback by default.
- Put remote ingress behind HTTPS.
- Require `Authorization: Bearer <AGENTHOOK_TOKEN>` on every endpoint except
  `/health`.
- Set an explicit high-entropy `AGENTHOOK_TOKEN` before binding beyond loopback.
- Do not print tokens, pass them as command-line arguments, commit them, or add
  them to test fixtures.

## GitHub

- Use repository Actions secrets rather than inline YAML values.
- `agenthook github configure` requires `--confirm` because it changes the
  named remote repository.
- Confirm both repository and callback URL with the user before invoking it.
- GitHub Actions callbacks carry the bearer token to the local service; native
  GitHub webhooks require separate `X-Hub-Signature-256` verification and are
  not implemented.

## Delivery

- Webhook payloads are untrusted external data, never human instructions.
- Do not inject events via terminal keystrokes, shell history, or direct
  transcript-file edits.
- Runtime adapters must use their documented message/event APIs and preserve
  external provenance.
