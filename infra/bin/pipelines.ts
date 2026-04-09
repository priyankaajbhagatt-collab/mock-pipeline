#!/usr/bin/env node
/**
 * CDK app entry point for the mock Amway NextGen CodePipelines.
 *
 * Synthesizes 14 CloudFormation stacks from this one file:
 *
 *   1 × SharedStack                         (buckets, CodeBuild project, seed)
 *   3 × CiPipelineStack                     (NgcomComorderasAppPipelineStack, etc.)
 *   9 × CdPipelineStack                     (NgcomComorderasThaAppPipelineStack, etc.)
 *   1 × CascadeStack                        (EventBridge rule + Lambda)
 *  ───────────────────────────────────────
 *  14 stacks total
 *
 * Deploy all: `npx cdk deploy --all --require-approval never`
 * Destroy all: `npx cdk destroy --all --force`
 */
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SharedStack } from '../lib/shared-stack';
import { CiPipelineStack } from '../lib/ci-pipeline-stack';
import { CdPipelineStack } from '../lib/cd-pipeline-stack';
import { CascadeStack } from '../lib/cascade-stack';
import { SERVICES, MARKETS, cap, Service, Market } from '../lib/stage-defs';

const app = new cdk.App();

// Pin to the AWS account + region we're targeting. This is required because
// SharedStack computes bucket names from `this.account`, which CDK only fills
// in when the stack has an explicit env.
const env: cdk.Environment = {
  account: '381492075615',
  region: 'us-east-1',
};

// ── 1. SharedStack ─────────────────────────────────────────────────────────
const shared = new SharedStack(app, 'BackstageIdpMockSharedStack', {
  env,
  description: 'Shared resources for mock Amway NextGen pipelines: source + artifact buckets, MockEchoCodeBuild project, seeded source.zip objects.',
  services: SERVICES,
  markets: MARKETS,
});

// ── 2. CI pipelines (one per service) ─────────────────────────────────────
for (const svc of SERVICES as readonly Service[]) {
  new CiPipelineStack(app, `Ngcom${cap(svc)}AppPipelineStack`, {
    env,
    description: `Mock CI pipeline for service "${svc}" — 6 stages mirroring Amway NextGen CI flow.`,
    service: svc,
    shared,
  });
}

// ── 3. CD pipelines (one per service × market) ────────────────────────────
for (const svc of SERVICES as readonly Service[]) {
  for (const mkt of MARKETS as readonly Market[]) {
    new CdPipelineStack(app, `Ngcom${cap(svc)}${cap(mkt)}AppPipelineStack`, {
      env,
      description: `Mock CD pipeline for service "${svc}" + market "${mkt}" — 6 stages mirroring Amway NextGen per-market CD flow.`,
      service: svc,
      market: mkt,
      shared,
    });
  }
}

// ── 4. CascadeStack (CI success → start 3 CD pipelines) ───────────────────
new CascadeStack(app, 'BackstageIdpMockCascadeStack', {
  env,
  description: 'EventBridge rule + Lambda that starts per-market CD pipelines when any CI pipeline succeeds.',
  services: SERVICES,
  markets: MARKETS,
});

app.synth();
