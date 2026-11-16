# Cloud deployment (Google Cloud + Terraform + GitHub Actions)

The bot runs 24/7 on a Google Cloud **e2-micro** VM (always-free tier), built with Terraform and deployed by
GitHub Actions with keyless authentication. Nothing listens on the internet; secrets never touch Git.

## Architecture

```
 GitHub                                   Google Cloud project
┌──────────────────────────┐             ┌──────────────────────────────────────────────────────┐
│ push / PR                │             │  Artifact Registry  ◀── image (pushed by digest)     │
│  ├ CI: lint, types, tests│  OIDC token │                                                      │
│  ├ Security: CodeQL,     │────────────▶│  Workload Identity Federation (this repo only)       │
│  │  Trivy (deps, secrets,│  (no keys)  │   ├ planner  SA: read-only, terraform plan on PRs    │
│  │  IaC, image)          │             │   ├ applier  SA: terraform apply, main + approval    │
│  ├ Terraform: plan → PR  │             │   └ deployer SA: push image, set VM metadata         │
│  │  apply (approval)     │             │                                                      │
│  └ Deploy (approval):    │ bot-image   │  VM e2-micro, Container-Optimized OS, Shielded VM    │
│     build→scan→push→     │──metadata──▶│   ├ deploy watcher: metadata change → restart bot    │
│     switch→verify→       │             │   ├ whatsapp-bot.service: read-only, non-root,       │
│     auto-rollback        │             │   │   no capabilities, memory/pid limits             │
└──────────────────────────┘             │   ├ .env from Secret Manager → RAM only (/run)       │
                                          │   └ session backup every 6h → versioned bucket       │
                                          │  Firewall: deny all inbound (SSH only via IAP)       │
                                          │  Cloud Logging + alerts: no heartbeat 20 min,        │
                                          │   logged out / code 440 → email                      │
                                          └──────────────────────────────────────────────────────┘
```

| Part | Where |
|---|---|
| Infrastructure | `infra/terraform/` (network, VM, registry, secret, bucket, OIDC, IAM, monitoring) |
| VM boot config | `infra/vm/` (cloud-init + systemd units + scripts) |
| Pipelines | `.github/workflows/` (`ci`, `security`, `terraform`, `deploy`) |
| One-time scripts | `infra/bootstrap.sh`, `infra/upload-config.sh`, `infra/upload-session.sh` |

## Cost

| Item | Cost |
|---|---|
| e2-micro VM + 30 GB standard disk (us-central1 / us-west1 / us-east1) | free tier |
| Public IPv4 for outbound traffic | a few dollars a month (covered by the $300 credit) |
| Artifact Registry (≤0.5 GB, old images auto-deleted), Secret Manager, Logging, bucket | free tier / cents |

A budget alert (counted **before** credits) emails you at 50/90/100% of the monthly amount.

## Setup (once, about 20 minutes)

Install on your Mac: `brew install --cask google-cloud-sdk && brew install terraform gh jq`.

1. **Google Cloud**: create a project at console.cloud.google.com and link the billing account that has the credit.
   ```bash
   gcloud auth login
   gcloud auth application-default login
   ```
2. **GitHub**: push this project to a repository (private is fine), then `gh auth login`.
3. **Create the infrastructure** (state bucket, Terraform apply, budget, GitHub variables and the `production` environment):
   ```bash
   infra/bootstrap.sh <project-id> <github-user>/<repo> <your-email>
   ```
4. **Bot settings** → Secret Manager (from your `.env`; `AUTH_DIR` is dropped automatically):
   ```bash
   infra/upload-config.sh <project-id> .env
   ```
5. **Move the WhatsApp login** (no new QR scan). Stop the bot on your Mac first (Ctrl+C), then:
   ```bash
   infra/upload-session.sh <project-id> auth
   ```
6. **Deploy**: merge a pull request into `main`. CI tests, builds and scans the image once and, if the bot's
   code changed, pushes it. *Deploy* then waits for your approval (GitHub → Actions), switches the VM to that
   exact image and checks the logs for a fresh "WhatsApp connected". If it doesn't appear within 5 minutes it
   rolls back to the previous image automatically. Docs- or infra-only merges don't redeploy the bot.

From now on: open a pull request → checks + Terraform plan as a comment → merge → approve → live.

## Day-to-day

| Task | How |
|---|---|
| Logs | Cloud Console → Logging, or `gcloud logging read 'resource.type="gce_instance"' --limit 50` |
| Shell on the VM | `gcloud compute ssh wfb-bot --zone us-central1-a --tunnel-through-iap` |
| Restart the bot | `… --tunnel-through-iap -- sudo systemctl restart whatsapp-bot` |
| Change settings | edit `.env` → `infra/upload-config.sh <project> .env` → restart |
| Roll back | Actions → Deploy → Run workflow → paste an earlier `…/bot@sha256:…` (empty = rebuild current `main`) |
| Gemini quota / models | `… --tunnel-through-iap -- sudo cat /var/lib/wfb/auth/gemini-quota.json` |

### Link WhatsApp from scratch (no session to move)

Put `WHATSAPP_PAIRING_NUMBER=9725…` in `.env`, upload it, restart, then read the code from the logs:
`gcloud logging read 'resource.type="gce_instance" AND "Pairing code"' --limit 1`.
On the phone: WhatsApp → Linked devices → Link a device → *Link with phone number instead*.

### When the bot stops on purpose

Exit code 3 means a person must act, so the service doesn't restart in a loop (you also get an email):
- **Logged out**: re-link (above), after deleting the old session: `sudo rm -rf /var/lib/wfb/auth/*`.
- **Code 440**: another copy (e.g. on your Mac) uses the same login. Stop it, then restart the bot.

## Security notes

- **No keys anywhere**: GitHub gets 1-hour Google tokens through OIDC, and only for this repository.
  `terraform apply` and deploys work only from `main` and wait for approval in the `production` environment.
- **Least privilege**: the VM can read one secret, pull images, write logs and its own backup bucket; the deployer
  can only push images and change the VM's metadata; PR plans run read-only.
- **No inbound ports**: deploys go through instance metadata, admin SSH only through IAP with OS Login.
- **Hardened runtime**: Shielded VM, auto-updating Container-Optimized OS, read-only container, non-root,
  no Linux capabilities, `no-new-privileges`, memory/PID limits, npm removed from the image.
- **Secrets**: `.env` lives in Secret Manager and is written only to RAM on the VM. The WhatsApp session is
  equivalent to a password: it stays on the VM disk and in a private, versioned bucket.
- **Supply chain**: images deployed by digest after a Trivy scan; CodeQL, Trivy (deps, secrets, IaC) and
  Dependabot (npm, actions, Docker, Terraform) run continuously.

## Changing the VM scripts

`infra/vm/*` reaches the VM as cloud-init, which runs at boot. After a Terraform apply that changes it,
restart the VM: `gcloud compute instances reset wfb-bot --zone us-central1-a` (the session is on disk and backed up).
