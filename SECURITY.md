# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub private vulnerability reporting](../../security/advisories/new). You should get an answer within a few days.

## How this project is protected

- **No secrets in the repository.** API keys and allowed phone numbers live in Google Secret Manager and reach the
  server only in memory. The WhatsApp session never leaves the server and its private, versioned backup bucket.
- **Keyless CI/CD.** GitHub Actions authenticates to Google Cloud with short-lived OIDC tokens, limited to this
  repository; deploys and `terraform apply` are allowed only from `main` and wait for manual approval.
- **Supply chain.** Third-party actions are pinned to commit SHAs; dependencies, the Docker image and Terraform are
  scanned (CodeQL, Trivy, npm audit) and kept up to date by Dependabot; images are deployed by digest after a scan.
- **Runtime.** Shielded VM with no inbound ports, read-only non-root container without Linux capabilities.

See [infra/README.md](infra/README.md) for the full design.
