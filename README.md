# backstage-idp-mock-pipelines

Mock AWS CodePipelines that imitate Amway's **NextGen CI/CD** topology. This repository provisions realistic-looking pipelines (same naming, same stage flow, same stage names as Amway's production setup) using AWS CDK. Every stage is a trivial echo step that runs for ~5 seconds, so a full end-to-end run finishes in ~65 seconds at a cost of less than $0.03 per run.

**Primary use case:** serves as the dataset for the Backstage **IDP Cockpit → Live Pipelines** feature, which reads real CodePipeline state and CloudWatch logs via AWS APIs. With these mocks deployed, you can iterate on the Backstage plugin locally without needing access to Amway's production pipelines.

---

## Table of Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Pipeline topology](#2-pipeline-topology)
3. [Prerequisites](#3-prerequisites)
4. [Repository layout](#4-repository-layout)
5. [One-time setup](#5-one-time-setup)
6. [Deployment](#6-deployment)
7. [Triggering a pipeline run](#7-triggering-a-pipeline-run)
8. [Validation — verify everything works](#8-validation--verify-everything-works)
9. [Viewing logs](#9-viewing-logs)
10. [Customization](#10-customization)
11. [Future: swap to Bitbucket source](#11-future-swap-to-bitbucket-source)
12. [Troubleshooting](#12-troubleshooting)
13. [Cleanup / teardown](#13-cleanup--teardown)
14. [Cost breakdown](#14-cost-breakdown)
15. [FAQ](#15-faq)

---

## 1. What gets deployed

14 CloudFormation stacks from one AWS CDK app, deployed to **AWS account `381492075615`** in region **`us-east-1`**:

| Kind | Count | Stacks |
|---|---|---|
| Shared | 1 | `BackstageIdpMockSharedStack` — S3 buckets (source + artifact), single `MockEchoCodeBuild` project, seeded initial `source.zip` objects |
| CI pipelines | 3 | `NgcomComorderasAppPipelineStack`, `NgcomCopaymentAppPipelineStack`, `NgcomCoprofileAppPipelineStack` |
| CD pipelines | 9 | 3 services × 3 markets (`tha`, `jp`, `latam`) — e.g. `NgcomComorderasThaAppPipelineStack` |
| Cascade | 1 | `BackstageIdpMockCascadeStack` — EventBridge rule + Lambda that triggers the 3 market CD pipelines when any CI pipeline succeeds |

**Services:** `comorderas`, `copayment`, `coprofile`
**Markets:** `tha`, `jp`, `latam`
**Total pipelines:** 12 (3 CI + 9 CD)

Every stage in every pipeline is implemented as a **single shared** `MockEchoCodeBuild` project running the same inline buildspec. Each invocation prints the stage name, action name, service, market, and the mock stage description to CloudWatch Logs, then sleeps 5 seconds and exits. No Docker builds, no ECR pushes, no actual deployments — it's a pure visual/API mock.

---

## 2. Pipeline topology

### Phase 1 — CI pipeline (per service)

`Ngcom<Service>AppPipeline`

```
1. Source             → Bitbucket_Source     → S3SourceAction (watches services/<svc>/source.zip)
2. ImageBuild         → ImageBuildArm64      → Docker build → Prisma scan → ECR push → DynamoDB metadata
3. GlobalDev          → GlobalDevLive        → Deploy snapshot to Global-Dev EKS via ArgoCD
4. TaggingApproval    → TaggingApproval      → [MOCK APPROVAL] Slack: "Tag this build with a semver release?"
5. TaggingController  → TaggingController    → Auto-bump semver, create git tag + release, generate changelog
6. AllTenantApproval  → AllTenantApproval    → [MOCK APPROVAL] Slack: "Which markets receive this release?"
```

### Phase 2 — CD pipeline (per service × market)

`Ngcom<Service><Market>AppPipeline`

```
1. S3Source            → S3Action              → Placeholder (triggered by cascade Lambda via StartPipelineExecution)
2. <Market>Qa          → <Market>QaLive        → Deploy tagged image to <Market> QA EKS via ArgoCD
3. <Market>UatApproval → <Market>UatApproval   → [MOCK APPROVAL] Slack: "QA validated, promote to UAT?"
4. <Market>Uat         → <Market>UatLive       → Deploy to <Market> UAT EKS via ArgoCD
5. <Market>ProdApproval→ <Market>ProdApproval  → [MOCK APPROVAL] Slack: "UAT validated, promote to PROD?"
6. <Market>Prod        → <Market>ProdLive      → Deploy to <Market> PROD with preview → live promotion
```

### End-to-end flow

```
Trigger (./trigger.sh comorderas)
          │
          ▼
Upload source.zip → S3 PutObject event → EventBridge rule → CodePipeline starts
          │
          ▼
┌─────────────────────────┐
│ NgcomComorderasAppPipe- │ Phase 1 CI
│ line (~3 min: 6 stages) │
└───────────┬─────────────┘
            │ on SUCCEEDED → EventBridge rule → Cascade Lambda
            │
     ┌──────┼──────┐
     ▼      ▼      ▼
  ┌─────┐┌─────┐┌─────┐
  │ THA ││ JP  ││LATAM│ Phase 2 CD (~3 min each, run in parallel)
  └─────┘└─────┘└─────┘
```

**Total end-to-end time:** ~6–7 minutes from trigger to all 4 pipelines complete (CI runs serially, 3 CD pipelines run in parallel after CI).

---

## 3. Prerequisites

### 3.1 AWS account + permissions

| Requirement | Value |
|---|---|
| AWS Account ID | `381492075615` |
| AWS Region | `us-east-1` |
| AWS SSO profile | `Altimetrik-PowerUserAccess-381492075615` |
| IAM permissions needed | Equivalent to `AdministratorAccess` (CDK creates IAM roles, CloudFormation stacks, S3 buckets, CodePipeline, CodeBuild, Lambda, EventBridge rules, CloudWatch log groups). The `AWSPowerUserAccess` role granted via Altimetrik SSO is sufficient. |

### 3.2 Local tools

| Tool | Minimum version | Check command | Install |
|---|---|---|---|
| AWS CLI | v2.x | `aws --version` | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| Node.js | 20.x or later | `node --version` | https://nodejs.org/ (recommend installing via `nvm`) |
| npm | 10.x or later (bundled with Node) | `npm --version` | (ships with Node.js) |
| Git | 2.x | `git --version` | https://git-scm.com/downloads |
| SSH client + Bitbucket SSH key | — | `ssh -T git@bitbucket.org` should print `authenticated via ssh key` | Add your SSH key at https://bitbucket.org/account/settings/ssh-keys/ |
| `zip` CLI | — | `which zip` | Pre-installed on macOS/Linux |

**Note on CDK CLI:** you do **not** need to install `aws-cdk` globally. The CLI is a devDependency in `infra/package.json` and runs via `npx`.

### 3.3 AWS SSO login

The Altimetrik AWS account uses SSO. Log in once per session:

```bash
aws sso login --profile Altimetrik-PowerUserAccess-381492075615
```

Verify:

```bash
aws sts get-caller-identity --profile Altimetrik-PowerUserAccess-381492075615
```

Expected output (partial):
```json
{
  "UserId": "AROA...:askumar@altimetrik.com",
  "Account": "381492075615",
  "Arn": "arn:aws:sts::381492075615:assumed-role/AWSReservedSSO_Altimetrik-PowerUserAccess_.../askumar@altimetrik.com"
}
```

If this fails with `Error loading SSO Token`, rerun `aws sso login`.

### 3.4 Bitbucket access

The repository lives at `bitbucket.org/altimetrikgit/backstage-idp-mock-pipelines`. You need:

- Read access to the `altimetrikgit` workspace (any Bitbucket Cloud user in the workspace should have this by default)
- SSH key uploaded to your Bitbucket Cloud account (for `git clone` / `git push`)

Verify:

```bash
ssh -T git@bitbucket.org
# Expected: "authenticated via ssh key."
```

> **Note:** Office firewalls sometimes block SSH on port 22. If `ssh -T git@bitbucket.org` times out, add this to your `~/.ssh/config`:
> ```
> Host bitbucket.org
>   Hostname altssh.bitbucket.org
>   Port 443
>   User git
> ```
> Then retry.

---

## 4. Repository layout

```
backstage-idp-mock-pipelines/
├── README.md                              ← this file
├── .gitignore                             ← node_modules, cdk.out, etc.
├── trigger.sh                             ← ./trigger.sh <service> → fires a CI pipeline run
└── infra/                                 ← CDK app
    ├── package.json                       ← aws-cdk-lib, constructs, typescript, ts-node
    ├── package-lock.json
    ├── tsconfig.json
    ├── cdk.json                           ← CDK entry: "app": "npx ts-node --prefer-ts-exts bin/pipelines.ts"
    ├── bin/
    │   └── pipelines.ts                   ← CDK app entry — loops over SERVICES × MARKETS
    └── lib/
        ├── stage-defs.ts                  ← CI_STAGES + CD_STAGES constants, SERVICES + MARKETS lists
        ├── shared-stack.ts                ← MockSourceBucket, MockArtifactBucket, MockEchoCodeBuild, SeedSources
        ├── seed-sources.ts                ← CDK construct that seeds initial source.zip via BucketDeployment
        ├── ci-pipeline-stack.ts           ← Phase 1 CI pipeline + swap-ready buildSourceAction() helper
        ├── cd-pipeline-stack.ts           ← Phase 2 per-market CD pipeline
        └── cascade-stack.ts               ← EventBridge rule + inline Node.js cascade Lambda
```

---

## 5. One-time setup

These steps only need to be run once per machine (or after cloning the repo fresh).

### Step 1 — Clone the repository

```bash
git clone git@bitbucket.org:altimetrikgit/backstage-idp-mock-pipelines.git
cd backstage-idp-mock-pipelines
```

### Step 2 — Install CDK dependencies

```bash
cd infra
npm install
```

This installs `aws-cdk-lib`, `constructs`, `typescript`, `ts-node`, and the CDK CLI (`aws-cdk`) as local devDependencies. The `npx cdk` commands below all resolve to this local install.

### Step 3 — AWS SSO login

```bash
aws sso login --profile Altimetrik-PowerUserAccess-381492075615
```

This opens a browser for authentication. The session stays valid for ~8–12 hours; you'll need to rerun this when the token expires.

### Step 4 — CDK bootstrap (first time per account/region)

```bash
cd infra  # if not already there
export AWS_PROFILE=Altimetrik-PowerUserAccess-381492075615
npx cdk bootstrap aws://381492075615/us-east-1
```

This creates a `CDKToolkit` CloudFormation stack with:
- An S3 bucket for CDK asset uploads (Lambda code zips, seed source.zip, etc.)
- IAM roles CDK uses to deploy stacks
- An ECR repo for container assets (unused by us but auto-created)

**Bootstrap is idempotent** — running it again is safe. It simply confirms the toolkit stack is up-to-date. If the toolkit already exists in the account from a previous project, this command is effectively a no-op.

---

## 6. Deployment

### Step 1 — Synthesize templates (dry run, no AWS writes)

```bash
cd infra
export AWS_PROFILE=Altimetrik-PowerUserAccess-381492075615
npx cdk synth --quiet
```

This compiles the TypeScript and validates the CloudFormation templates without touching AWS. Expected output:

```
Successfully synthesized to /path/to/infra/cdk.out
Supply a stack id (BackstageIdpMockSharedStack, NgcomComorderasAppPipelineStack, ...) to display its template.
```

The list of stack IDs confirms all **14 stacks** compiled correctly.

### Step 2 — Deploy all stacks

```bash
npx cdk deploy --all --require-approval never --concurrency 4
```

`--concurrency 4` deploys up to 4 stacks in parallel (CDK handles dependency ordering automatically — the shared stack goes first, then pipelines in parallel, then the cascade stack). Total time: **8–10 minutes**.

Expected output at the end:
```
 ✅  BackstageIdpMockSharedStack
 ✅  NgcomComorderasAppPipelineStack
 ✅  NgcomCopaymentAppPipelineStack
 ✅  NgcomCoprofileAppPipelineStack
 ✅  NgcomComorderasThaAppPipelineStack
 ...
 ✅  BackstageIdpMockCascadeStack
```

### Step 3 — Verify the deploy landed all 14 stacks

```bash
aws cloudformation list-stacks \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1 \
  --query "StackSummaries[?(starts_with(StackName, 'Ngcom') || starts_with(StackName, 'BackstageIdpMock')) && StackStatus!='DELETE_COMPLETE'].[StackName,StackStatus]" \
  --output table
```

Expected: **14 rows**, all showing `CREATE_COMPLETE` or `UPDATE_COMPLETE`.

> **Note on initial auto-runs:** When the pipeline stacks are first created, CodePipeline automatically starts one execution of each pipeline using the seeded source.zip objects. You'll see 3 CI pipelines running + 9 CD pipelines running on their own shortly after `cdk deploy` completes. This is expected. All 12 should reach `SUCCEEDED` within ~4–5 minutes.

---

## 7. Triggering a pipeline run

### Interactive usage

From the repo root:

```bash
./trigger.sh comorderas
```

Valid service names: `comorderas`, `copayment`, `coprofile`.

### What happens under the hood

1. Creates a tmp dir, writes `trigger.txt` with a timestamp inside
2. Zips it → `source.zip`
3. `aws s3 cp source.zip s3://backstage-idp-mock-source-381492075615/services/<svc>/source.zip`
4. S3 produces a new object version
5. S3 PutObject event → EventBridge → CodePipeline receives `StartPipelineExecution`
6. CI pipeline `Ngcom<Svc>AppPipeline` transitions to `InProgress` (~1s latency)

### Expected timeline for `./trigger.sh comorderas`

```
T+0.0s   ./trigger.sh invoked
T+0.5s   source.zip uploaded to S3
T+1.0s   NgcomComorderasAppPipeline → InProgress (Source stage)
T+30s    → ImageBuild
T+60s    → GlobalDev
T+90s    → TaggingApproval
T+120s   → TaggingController
T+150s   → AllTenantApproval
T+180s   NgcomComorderasAppPipeline → SUCCEEDED
T+181s   EventBridge rule fires → cascade Lambda invoked
T+182s   Lambda calls StartPipelineExecution for 3 market CD pipelines
T+183s   NgcomComorderasThaAppPipeline, NgcomComorderasJpAppPipeline,
         NgcomComorderasLatamAppPipeline → InProgress (in parallel)
T+360s   All 3 CD pipelines → SUCCEEDED
```

Total: ~6 minutes.

### Triggering all 3 services at once

```bash
./trigger.sh comorderas && ./trigger.sh copayment && ./trigger.sh coprofile
```

You'll see 3 CI pipelines running, followed by 9 CD pipelines firing via cascade.

---

## 8. Validation — verify everything works

### 8.1 List all 12 pipelines

```bash
aws codepipeline list-pipelines \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1 \
  --query "pipelines[?starts_with(name, 'Ngcom')].name" \
  --output table
```

Expected: 12 pipeline names.

### 8.2 Check current state of a pipeline

```bash
aws codepipeline get-pipeline-state \
  --name NgcomComorderasAppPipeline \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1 \
  --query "stageStates[].[stageName,latestExecution.status]" \
  --output table
```

Expected (when the last run succeeded):
```
+--------------------+------------+
|  Source            |  Succeeded |
|  ImageBuild        |  Succeeded |
|  GlobalDev         |  Succeeded |
|  TaggingApproval   |  Succeeded |
|  TaggingController |  Succeeded |
|  AllTenantApproval |  Succeeded |
+--------------------+------------+
```

### 8.3 List recent executions of a pipeline

```bash
aws codepipeline list-pipeline-executions \
  --pipeline-name NgcomComorderasAppPipeline \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1 \
  --max-results 5 \
  --query "pipelineExecutionSummaries[].[pipelineExecutionId,status,startTime]" \
  --output table
```

### 8.4 Verify the cascade Lambda fired

After a CI pipeline succeeds, check that the 3 market CD pipelines started within seconds:

```bash
# CI start + success time
aws codepipeline list-pipeline-executions \
  --pipeline-name NgcomComorderasAppPipeline \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1 \
  --max-results 1 \
  --query "pipelineExecutionSummaries[0].[pipelineExecutionId,status,startTime,lastUpdateTime]" \
  --output table

# CD start times (should be within ~5s of CI's lastUpdateTime)
for mkt in Tha Jp Latam; do
  echo "=== NgcomComorderas${mkt}AppPipeline ==="
  aws codepipeline list-pipeline-executions \
    --pipeline-name "NgcomComorderas${mkt}AppPipeline" \
    --profile Altimetrik-PowerUserAccess-381492075615 \
    --region us-east-1 \
    --max-results 1 \
    --query "pipelineExecutionSummaries[0].[status,startTime]" \
    --output text
done
```

### 8.5 Check cascade Lambda logs (debug)

```bash
aws logs tail /aws/lambda/BackstageIdpMockCascadeLambda \
  --since 10m \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1
```

Expected log lines (example):
```
INFO  Incoming event: { ... pipeline: 'NgcomComorderasAppPipeline' ... state: 'SUCCEEDED' }
INFO  CI pipeline NgcomComorderasAppPipeline succeeded — starting CD pipelines: NgcomComorderasThaAppPipeline, NgcomComorderasJpAppPipeline, NgcomComorderasLatamAppPipeline
INFO  Started NgcomComorderasThaAppPipeline → executionId=<uuid>
INFO  Started NgcomComorderasJpAppPipeline → executionId=<uuid>
INFO  Started NgcomComorderasLatamAppPipeline → executionId=<uuid>
```

### 8.6 Visual check in AWS Console

Open: https://us-east-1.console.aws.amazon.com/codesuite/codepipeline/pipelines?region=us-east-1

Expected: all 12 pipelines listed. Click any pipeline → stages should mirror Amway's exact naming. Click any stage → "View logs" → CloudWatch log stream with the echo output (see next section).

---

## 9. Viewing logs

All stages from all pipelines log to a **single CloudWatch log group**: `/aws/codebuild/MockEchoCodeBuild`.

### Tail all logs live

```bash
aws logs tail /aws/codebuild/MockEchoCodeBuild \
  --follow \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1
```

### Tail logs from the last 5 minutes

```bash
aws logs tail /aws/codebuild/MockEchoCodeBuild \
  --since 5m \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1
```

### Example log output for a single stage

```
=================================================================
  Pipeline : NgcomComorderasAppPipeline
  Stage    : ImageBuild
  Action   : ImageBuildArm64
  Service  : comorderas
  Market   : global
=================================================================

Docker build → Prisma/Twistlock scan → ECR push → DynamoDB metadata insert (commitId, execId, tagStatus, sourceChange, infraChange, opaconfigChange)

Simulating work...
Done.
```

Every stage produces 1 log stream in the shared log group, tagged with the CodeBuild build ID. The Backstage **Live Pipelines** plugin will fetch these via `logs:GetLogEvents` and display them in the stage drill-down panel.

---

## 10. Customization

### 10.1 Add/remove services or markets

Edit `infra/lib/stage-defs.ts`:

```typescript
export const SERVICES = ['comorderas', 'copayment', 'coprofile', 'newservice'] as const;
export const MARKETS  = ['tha', 'jp', 'latam', 'us', 'eu'] as const;
```

Then redeploy:

```bash
cd infra
npx cdk deploy --all --require-approval never
```

CDK creates only the **new** stacks and updates the cascade Lambda's env vars. Existing pipelines are untouched. To remove a service or market, delete it from the array and run `cdk deploy` — CDK will destroy the stacks that correspond to removed entries.

### 10.2 Change stage names or descriptions

Edit the `CI_STAGES` or `CD_STAGES` arrays in `infra/lib/stage-defs.ts`. Each entry has:

```typescript
{
  name: 'ImageBuild',         // appears as the stage title in AWS console + Backstage
  actionName: 'ImageBuildArm64', // appears as the action name inside the stage
  description: 'Docker build → Prisma scan → ...', // printed in build logs
}
```

Redeploy with `npx cdk deploy --all`. CloudFormation will update the affected pipelines in-place (no data loss, no ARN changes).

### 10.3 Change sleep duration per stage

Edit `infra/lib/shared-stack.ts`, find the `buildSpec` section, and change `sleep 5` to the desired value in seconds. Redeploy.

### 10.4 Change AWS account or region

Edit `infra/bin/pipelines.ts`:

```typescript
const env: cdk.Environment = {
  account: '<NEW_ACCOUNT_ID>',
  region: '<NEW_REGION>',
};
```

And update the SSO profile everywhere it appears (trigger.sh, deploy commands in this README). Rerun `cdk bootstrap` for the new account/region before deploying.

---

## 11. Future: swap to Bitbucket source

The CI pipelines currently use **S3 source** because installing the AWS CodeStar Connections Bitbucket app on the `altimetrikgit` Bitbucket Cloud workspace requires **workspace admin** rights, which were not available at initial setup. When that access becomes available, swapping the source provider to real Bitbucket is a **single-function change** in one file.

### Migration steps

1. **Install the AWS CodeStar Bitbucket app on the `altimetrikgit` workspace** (workspace admin action, one-time):
   - Bitbucket → Workspace settings → Installed apps → Find or install "AWS CodeStar Connections"
2. **Create a CodeStar Connection** (AWS console, ~5 min):
   - AWS Console → Developer Tools → Settings → Connections → Create connection → Bitbucket
   - Name: `backstage-idp-mock-bitbucket`
   - Select the pre-installed app from step 1
   - Click "Connect"
   - Confirm status = `Available`
   - Copy the connection ARN, e.g. `arn:aws:codestar-connections:us-east-1:381492075615:connection/<UUID>`
3. **Edit one function in `infra/lib/ci-pipeline-stack.ts`** — find `buildSourceAction()` and swap the commented-out Bitbucket block in place of the S3 block:

   ```typescript
   private buildSourceAction(
     service: Service,
     output: codepipeline.Artifact,
     shared: SharedStack,
   ): cpa.Action {
     return new cpa.CodeStarConnectionsSourceAction({
       actionName: 'GitHub_Source',
       connectionArn: 'arn:aws:codestar-connections:us-east-1:381492075615:connection/<UUID>',
       owner: 'altimetrikgit',
       repo: 'backstage-idp-mock-pipelines',
       branch: 'main',
       triggerOnPush: true,
       output,
     });
   }
   ```
4. **Redeploy the CI pipeline stacks only:**
   ```bash
   cd infra
   npx cdk deploy Ngcom\*AppPipelineStack --require-approval never
   ```
   (Only the 3 CI pipeline stacks will be updated. CD pipelines, shared stack, cascade stack are all unchanged.)
5. **Trigger a run by pushing to Bitbucket instead of `./trigger.sh`:**
   ```bash
   echo "trigger $(date)" >> some-file.md
   git add some-file.md
   git commit -m "trigger CI"
   git push origin main
   ```

Pipeline names, stage names, ARNs, CloudWatch log groups, and the Backstage Live Pipelines plugin see zero changes.

---

## 12. Troubleshooting

### Problem: `aws sso login` opens a browser but never completes

**Cause:** Browser popup blocker or VPN issue.
**Fix:** Use the URL printed in the terminal manually. If it hangs, run `aws sso logout && aws sso login --profile ...`.

### Problem: `cdk bootstrap` fails with `ExpiredToken`

**Cause:** AWS SSO session expired.
**Fix:** Rerun `aws sso login --profile Altimetrik-PowerUserAccess-381492075615`.

### Problem: `cdk deploy` fails with `STS region endpoint...`

**Cause:** `AWS_PROFILE` not exported for the current shell.
**Fix:** `export AWS_PROFILE=Altimetrik-PowerUserAccess-381492075615` before running `npx cdk`.

### Problem: `cdk synth` reports `aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated`

**Cause:** Using an older `aws-cdk-lib` version.
**Fix:** Already fixed in this repo — we use an explicit `logGroup` on the cascade Lambda. If you see this warning after pulling updates, run `npm install` in `infra/` to sync `package-lock.json`.

### Problem: Pipeline source stage fails with `NoSuchKey: The specified key does not exist`

**Cause:** The initial `source.zip` seed didn't run, or was deleted manually.
**Fix:** Redeploy the shared stack — `npx cdk deploy BackstageIdpMockSharedStack --require-approval never`. The `SeedSources` construct will re-upload the placeholder objects.

### Problem: Cascade doesn't fire — CI succeeds but no CD pipelines start

**Checks:**
1. **EventBridge rule exists:**
   ```bash
   aws events list-rules \
     --name-prefix BackstageIdpMockCi \
     --profile Altimetrik-PowerUserAccess-381492075615 \
     --region us-east-1
   ```
2. **Lambda was invoked:**
   ```bash
   aws logs tail /aws/lambda/BackstageIdpMockCascadeLambda \
     --since 10m \
     --profile Altimetrik-PowerUserAccess-381492075615 \
     --region us-east-1
   ```
3. **Lambda has StartPipelineExecution permission:**
   ```bash
   aws lambda get-policy \
     --function-name BackstageIdpMockCascadeLambda \
     --profile Altimetrik-PowerUserAccess-381492075615 \
     --region us-east-1
   ```

If the Lambda was invoked but CD pipelines didn't start, the Lambda logs will show the exact error (usually a permissions issue — the Lambda's IAM role grants `StartPipelineExecution` on the specific CD pipeline ARNs only).

### Problem: `trigger.sh` fails with `command not found: aws`

**Cause:** AWS CLI not on PATH, or running in a shell where PATH isn't inherited.
**Fix:** `export PATH="/usr/local/bin:$PATH"` or install AWS CLI v2.

### Problem: `trigger.sh` fails with `zip: command not found`

**Cause:** Rare — `zip` is pre-installed on macOS/Linux.
**Fix:** Install via package manager (e.g. `brew install zip` on macOS, `sudo apt install zip` on Ubuntu).

### Problem: The pipelines show "Running" for many hours

**Cause:** Rare — CodeBuild build failed to start (e.g. capacity issue) or logs aren't being reported.
**Fix:**
1. Check the pipeline execution detail in the AWS console for the exact failed action
2. Check `/aws/codebuild/MockEchoCodeBuild` log group for build errors
3. Cancel the stuck execution:
   ```bash
   aws codepipeline stop-pipeline-execution \
     --pipeline-name <name> \
     --pipeline-execution-id <id> \
     --profile Altimetrik-PowerUserAccess-381492075615 \
     --region us-east-1
   ```
4. Retry with `./trigger.sh <service>`

### Problem: `cdk destroy --all` fails with "Bucket not empty"

**Cause:** Something uploaded objects to the bucket after CDK deployed it (e.g. a CI run that completed after the `cdk destroy` started).
**Fix:** The shared stack uses `autoDeleteObjects: true`, so CDK *should* handle this. If it doesn't, manually empty the buckets and retry:
```bash
aws s3 rm s3://backstage-idp-mock-source-381492075615 --recursive --profile Altimetrik-PowerUserAccess-381492075615
aws s3 rm s3://backstage-idp-mock-artifact-381492075615 --recursive --profile Altimetrik-PowerUserAccess-381492075615
npx cdk destroy --all --force
```

---

## 13. Cleanup / teardown

### Teardown everything

```bash
cd infra
export AWS_PROFILE=Altimetrik-PowerUserAccess-381492075615
npx cdk destroy --all --force
```

This removes all 14 CloudFormation stacks:
- All 12 pipelines (CodePipeline + IAM roles + action artifacts)
- `MockEchoCodeBuild` CodeBuild project
- `MockSourceBucket` and `MockArtifactBucket` S3 buckets (contents deleted automatically via `autoDeleteObjects: true`)
- Cascade Lambda + EventBridge rule + CloudWatch log groups
- All generated IAM roles and policies

**Tear-down time:** ~5 minutes.

### Teardown only the pipelines (keep shared resources)

```bash
npx cdk destroy Ngcom\*AppPipelineStack BackstageIdpMockCascadeStack --force
```

This keeps the S3 buckets + CodeBuild project intact so you can redeploy the pipelines quickly without re-seeding the source objects.

### Teardown the CDK bootstrap (optional, unusual)

Only do this if you will never use CDK in this account/region again. The `CDKToolkit` stack is shared by every CDK project in the account.

```bash
aws cloudformation delete-stack \
  --stack-name CDKToolkit \
  --profile Altimetrik-PowerUserAccess-381492075615 \
  --region us-east-1
```

---

## 14. Cost breakdown

All estimates are for `us-east-1` pricing as of 2026.

| Resource | Cost when idle | Cost per end-to-end run |
|---|---|---|
| CloudFormation stacks | $0 | $0 |
| CodePipeline | $1/month per active pipeline (first per month free) | $0 |
| CodeBuild (`general1.small`) | $0 | ~$0.005 × (6 CI stages + 15 CD stages × 30s each) ≈ **$0.01–0.03** |
| S3 storage (buckets < 1MB each) | < $0.01/month | $0 |
| S3 requests | $0 | $0 (few PutObject calls; first 2k/month free) |
| Lambda (cascade) | $0 | $0 (under 1k free tier invocations/month) |
| EventBridge | $0 | $0 (first 1M events/month free) |
| CloudWatch Logs | < $0.01/month (7-day retention) | $0 |
| **Total** | **< $15/month** (CodePipeline active pipelines dominate) | **< $0.03 per run** |

> **Cost reduction tip:** if you only need the pipelines to exist for occasional demos, run `cdk destroy --all --force` between demos. Each full deploy/destroy cycle takes ~15 minutes total and costs pennies in CloudFormation operations. This avoids the per-pipeline monthly charge.

---

## 15. FAQ

### Q: Can I use this in a different AWS account?

**A:** Yes. Edit `infra/bin/pipelines.ts`:
```typescript
const env: cdk.Environment = {
  account: '<NEW_ACCOUNT_ID>',
  region: 'us-east-1',
};
```
Update the profile name in `trigger.sh` and run `cdk bootstrap` in the new account. Everything else is account-agnostic.

### Q: How do I add more realism — actual ECR pushes, real ArgoCD, etc.?

**A:** Extend the buildspec in `infra/lib/shared-stack.ts`. Right now it only runs `echo` + `sleep`. You can add:
- Actual `docker build` (needs `privileged: true` on the CodeBuild project)
- Actual ECR push (needs IAM policy for `ecr:*` on the CodeBuild role)
- Actual ArgoCD deployment (needs VPC access + ArgoCD auth setup)

But the whole point of this mock is to *avoid* that complexity. If you need realism, use real Amway prod pipelines via AWS cross-account access instead.

### Q: Why are there two executions showing when I only triggered once?

**A:** When CodePipeline stacks are first created (or any time a stack is updated), CodePipeline automatically starts **one execution per pipeline** using the latest source version. These show up alongside any executions you trigger via `./trigger.sh`. Look at the `startTime` column in `list-pipeline-executions` to identify which is yours.

### Q: The CI pipeline succeeded but the cascade didn't fire the CD pipelines. What's wrong?

**A:** Check the cascade Lambda logs (see § 12 Troubleshooting). Common causes:
- EventBridge rule was deleted manually
- Lambda's IAM role was modified
- The CI pipeline name doesn't match the expected pattern (`Ngcom*AppPipeline`)

### Q: Why does Market show as `Global` in CI stage logs?

**A:** CI pipelines deploy to Global-Dev only, they're not market-specific. The `MARKET` env var is explicitly set to `"global"` for CI stages in `ci-pipeline-stack.ts`. Market-specific values (`Tha`, `Jp`, `Latam`) only appear in CD stage logs.

### Q: Can I trigger a CD pipeline directly without running the CI first?

**A:** Yes — `aws codepipeline start-pipeline-execution --name NgcomComorderasThaAppPipeline`. But the normal flow is CI → cascade → CD. Direct CD triggering is useful for testing the CD pipeline in isolation.

### Q: How do I pause auto-triggering on deploy without losing the pipeline definitions?

**A:** Not currently configurable — CodePipeline V2 auto-triggers on pipeline creation. If you want to disable this, you'd need to disable the S3 source trigger (`S3Trigger.NONE`) and use `StartPipelineExecution` exclusively.

### Q: What happens if I delete a source.zip object from S3?

**A:** The next pipeline execution will fail at the Source stage with `NoSuchKey`. To fix: redeploy the shared stack (`npx cdk deploy BackstageIdpMockSharedStack`) — the `SeedSources` construct will re-seed all missing objects.

### Q: How do I check which Backstage-Live-Pipelines feature branch is consuming these mock pipelines?

**A:** Check the `CodePipelineLiveProvider` in `plugins/idp-cockpit-backend/src/providers/` in the main Backstage repo. It should list pipelines via `codepipeline:ListPipelines` and filter by name prefix `Ngcom`.

---

## Maintainer

Ashok Kumar Thiruppathi — askumar@altimetrik.com

## Related docs

- Backstage IDP Cockpit plugin: `/Users/ashokkumarthiruppathi/Documents/ALTIMETRIK/ASSESSMENTS/AMWAY/BACKSTAGE_DEMO/plugins/idp-cockpit-*`
- Amway NextGen CI/CD reference: see the conversation history in `.claude/plans/majestic-gliding-sketch.md` for the end-to-end flow diagram this project mocks
