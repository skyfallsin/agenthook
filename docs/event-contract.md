# Event contract

An agenthook event is external data. It is never a user message and must not be
presented as one by a runtime adapter.

## Example payload

Payload fields depend on the service; the inbox does not require deployment
fields. This is a deployment example.

```json
{
  "kind": "deployment",
  "status": "success",
  "repository": "owner/repo",
  "branch": "main",
  "sha": "short-or-full-sha",
  "run_url": "https://github.com/owner/repo/actions/runs/123"
}
```

The server adds trusted delivery metadata:

```json
{
  "id": "event UUID",
  "topic": "github.owner.repo.deploy",
  "payload": { "...": "external payload" },
  "source": "webhook",
  "receivedAt": 0
}
```

## Rules

- Keep callbacks compact: status, relevant identifiers, URLs, and a short
  failure summary only.
- Do not include bearer tokens, deployment logs, artifact contents, environment
  values, or unbounded third-party text.
- Treat every payload field as untrusted, including repository names and URLs.
- An adapter must label the event's external source and topic before it reaches
  the model.
- A matched event is delivered once. Retain the event ID for future
  acknowledgement and deduplication support.
