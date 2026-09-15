# GitHub Actions setup

Use a GitHub Actions callback for deployment or CI completion. Do not create a
GitHub App or a native GitHub webhook for this flow.

## Agent procedure

1. Ask for explicit approval naming the GitHub repository and the HTTPS
   callback URL. This command writes repository secrets.
2. Confirm `gh` is authenticated and that agenthook has an available token.
3. Configure the approved repository:

   ```sh
   agenthook github configure OWNER/REPO \
     --url https://agenthook.example.com \
     --topic github.OWNER.REPO.deploy \
     --confirm
   ```

The command writes these repository Actions secrets without exposing their
values in command arguments or output:

- `AGENTHOOK_URL`
- `AGENTHOOK_TOKEN`
- `AGENTHOOK_TOPIC`

The agenthook default topic is `github.OWNER.REPO` when `--topic` is omitted.

## Workflow callback

Add a final job after the deployment job. Replace `deploy` with the actual job
ID. Keep the payload compact and do not send logs, artifact contents, or
secrets.

```yaml
notify-agenthook:
  needs: [deploy]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - name: Send result to agenthook
      env:
        AGENTHOOK_URL: ${{ secrets.AGENTHOOK_URL }}
        AGENTHOOK_TOKEN: ${{ secrets.AGENTHOOK_TOKEN }}
        AGENTHOOK_TOPIC: ${{ secrets.AGENTHOOK_TOPIC }}
        STATUS: ${{ needs.deploy.result }}
      run: |
        curl --fail --silent --show-error --retry 3 \
          --request POST \
          --header "Authorization: Bearer ${AGENTHOOK_TOKEN}" \
          --header "Content-Type: application/json" \
          --data "$(jq -nc \
            --arg status "$STATUS" \
            --arg repo "$GITHUB_REPOSITORY" \
            --arg branch "$GITHUB_REF_NAME" \
            --arg sha "$GITHUB_SHA" \
            --arg run_url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
            '{kind:"deployment",status:$status,repository:$repo,branch:$branch,sha:$sha,run_url:$run_url}')" \
          "${AGENTHOOK_URL}/v1/webhooks/${AGENTHOOK_TOPIC}"
```

Use one topic per independent work stream. A stable HTTPS tunnel URL avoids
reconfiguring the repository whenever a temporary tunnel changes.
