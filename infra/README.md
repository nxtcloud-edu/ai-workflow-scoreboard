# AI Workflow Scoreboard Infrastructure

This Terraform config recreates the EC2-hosted scoreboard server for
`nxtcloud-edu/ai-workflow-scoreboard`.

It creates:

- Amazon Linux 2023 arm64 EC2 instance
- Security group for HTTP and SSH
- IAM role and instance profile
- systemd service for the Astro app
- nginx reverse proxy on port 80

The app source is cloned from GitHub during first boot. Secrets are not stored
in Terraform files; the instance reads them from SSM Parameter Store.

## Secret Parameters

Create these SecureString parameters before `terraform apply`:

```bash
aws ssm put-parameter \
  --region ap-northeast-2 \
  --name /ai-workflow-scoreboard/github-token \
  --type SecureString \
  --value "REPLACE_WITH_REPO_SCOPED_TOKEN" \
  --overwrite

aws ssm put-parameter \
  --region ap-northeast-2 \
  --name /ai-workflow-scoreboard/admin-password \
  --type SecureString \
  --value "REPLACE_WITH_ADMIN_PASSWORD" \
  --overwrite

aws ssm put-parameter \
  --region ap-northeast-2 \
  --name /ai-workflow-scoreboard/session-secret \
  --type SecureString \
  --value "REPLACE_WITH_RANDOM_SESSION_SECRET" \
  --overwrite
```

The GitHub token should only need repository access to the class repositories
with read permissions for contents, pull requests, issues, and metadata.

## Deploy

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
terraform -chdir=infra init
terraform -chdir=infra plan
terraform -chdir=infra apply
terraform -chdir=infra output url
```

## Stop Or Remove

To stop without destroying the server:

```bash
aws ec2 stop-instances --region ap-northeast-2 --instance-ids "$(terraform -chdir=infra output -raw instance_id)"
```

To remove Terraform-created infrastructure:

```bash
terraform -chdir=infra destroy
```

## LLM Operation Report Checklist

When an LLM is asked to deploy this server, report:

- created EC2 instance ID
- public URL
- whether `/api/score.json` returns JSON
- whether `ai-workflow-scoreboard.service` is active
- whether nginx is active
- any failed step and rollback action
