# Remis app update policy

Temporary public hosting for the Remis staging mobile update policy.

Policy URL:

```text
https://jadapema.github.io/remis-app-update-policy/mobile-update.json
```

## Automatic updates

The `Sync Remis update policy` workflow runs every five minutes. It publishes a
new policy only when:

1. the latest `Staging CI/CD` workflow in `remisapp/remis-app` completed
   successfully;
2. both the Android and iOS deploy jobs succeeded; and
3. a Semantic Release tag was created during that workflow.

The repository secret `REMIS_REPO_TOKEN` must contain a fine-grained personal
access token with read-only access to:

- Actions
- Contents
- Metadata

for `remisapp/remis-app`.

## Emergency rollback

Run `Disable update policy` from the Actions tab. It publishes an empty policy
list immediately.
