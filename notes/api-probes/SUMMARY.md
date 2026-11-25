# Flagsmith Admin API Day-0 probes

Project `blast-radius` (id 56400), environment `Development` (key in `$FLAGSMITH_ENV_KEY`), test feature `probe_flag` (id 304837). Raw responses: `NN_name.json` in this folder. The admin key is redacted everywhere; grep confirms it is absent from `notes/`.

| endpoint | method | works | note |
|---|---|---|---|
| `/api/v1/projects/` | GET | Y | returns list, find project by name |
| `/api/v1/projects/{id}/environments/` | GET | Y | Development `api_key` is the env key used below |
| `/api/v1/environments/?project=` | GET | not tried | fallback unused, first path worked |
| `/api/v1/projects/{id}/features/` | POST | Y | 201; `{"name","type":"STANDARD","default_enabled"}` |
| `/api/v1/projects/{id}/features/` | GET | Y | list |
| `/api/__future__/environments/{env_key}/features/{feature_id}/` | GET | Y | works with env api_key; env id not tried (not needed) |
| `/api/__future__/environments/{env_key}/features/{feature_id}/` | PATCH | Y | `environment_default.enabled` true and false both 200; re-read confirms state change |
| `/api/v1/environments/{env_key}/featurestates/` | GET | Y, empty | returned `[]` (plain array, not paginated); no featurestate rows matched `probe_flag`, so step e's patch was skipped |
| `/api/v1/environments/{env_key}/featurestates/{id}/` | PATCH | not verified | skipped: no featurestate id found (see above) |
| `/api/v1/audit/` | GET | N | HTTP 500 (server error page) |
| `/api/v1/projects/{id}/audit/` | GET | Y, but empty | 200 `[]`; toggles from the __future__ PATCH do **not** appear |
| `/api/v1/environments/{key}/audit/` | GET | N | 404 |
| `/api/v1/environments/{key}/webhooks/` | GET | Y | 200 `[]`; plan has the endpoint, none configured |
| `/api/v1/projects/{id}/integrations/` | GET | N | 404 |
| `/api/v1/projects/{id}/segments/` | POST | Y | 201, created `probe_segment` (id 1204518) |
| `/api/v1/projects/{id}/features/{id}/` | PATCH | Y | sets 2 multivariate options (`default_percentage_allocation` 50/50); 200 response |

## Exact working calls

Disable a flag (verified: toggled on then off, re-read showed `enabled: false`):

```
curl -X PATCH "https://api.flagsmith.com/api/__future__/environments/$FLAGSMITH_ENV_KEY/features/$FEATURE_ID/" \
  -H "Authorization: Api-Key $FLAGSMITH_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"environment_default":{"enabled":false}}'
```

Read current state: same URL with `GET`.

Audit log: the only read path that responds is the project-scoped one, but it did **not** record our toggles:

```
curl "https://api.flagsmith.com/api/v1/projects/$PROJECT_ID/audit/" \
  -H "Authorization: Api-Key $FLAGSMITH_ADMIN_KEY"
```

Result: `[]`. The audit log can't be relied on for the change history yet. Options are to verify it in the dashboard (the audit log may be filtered or lag), or to record our own `.blast/audit.jsonl` as the spec already says.

## Open issues for the tech spec

1. Audit log: the REST read returns empty for toggles made via the experimental endpoint. Check the dashboard audit log to see whether those toggles appear there. If not, the spec's local `audit.jsonl` is the only record.
2. Experimental endpoint: works, but still marked experimental. Keep a fallback to `featurestates` once that list returns rows (the test flag had no featurestate rows in the list, which needs a follow-up probe with an explicit env-level featurestate).
3. Webhooks: endpoint exists and returns an empty list on this plan. Creating one was not attempted, so delivery is unverified.
4. Percentage rollout: segment creation works. A segment override with a percentage-split rule was not built; only the multivariate option change was tested.

## Not done (needs your confirmation)

- `probe_flag` feature (id 304837) and `probe_segment` (id 1204518) still exist in blast-radius. `probe_flag` was converted to multivariate. Waiting on your OK to delete.
