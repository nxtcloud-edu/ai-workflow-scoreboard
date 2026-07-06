# AI Workflow Team Scoreboard

NxtCloud AI Workflow classroom operations dashboard. The service scores team GitHub collaboration activity across the public `nxtcloud-edu/2026-kookmin-ai-workflow-team1` through `team5` repositories.

## Run

```bash
npm ci
npm run dev
```

For production:

```bash
npm run build
npm start
```

## Environment

- `GITHUB_TOKEN`: optional GitHub token for higher API limits. Use repository read-only access for Contents, Pull requests, Issues, and Metadata.
- `SCOREBOARD_EXCLUDED_LOGINS`: comma-separated operator accounts excluded from scoring. Default: `glen15,Dang-Mu`.
- `SCOREBOARD_ADMIN_PASSWORD`: enables admin endpoints and admin mode.
- `PORT`: production port, commonly `4324`.

## Deployment Notes

The live deployment used an EC2 host with nginx reverse proxy and systemd:

- app path: `/opt/ai-workflow-scoreboard`
- service: `ai-workflow-scoreboard.service`
- public URL: `http://13.125.43.70/`
- API: `http://13.125.43.70/api/score.json`

Do not commit real GitHub tokens, admin passwords, or systemd environment files.
