/**
 * Stage definitions for the mock Amway NextGen CI/CD pipelines.
 *
 * These constants are consumed by ci-pipeline-stack.ts and cd-pipeline-stack.ts
 * to build the per-stage CodeBuildActions. Adding/renaming a stage here and
 * re-deploying the CDK app updates every pipeline at once — no per-pipeline
 * edits required.
 *
 * Each stage is implemented as a CodeBuildAction referencing the single shared
 * MockEchoCodeBuild project (see shared-stack.ts). The action passes these
 * fields as environment variables; the universal echo buildspec prints them to
 * CloudWatch Logs so the Backstage Live Pipelines feature can surface them.
 */

export interface StageDef {
  /** Stage name as it appears in the AWS CodePipeline console (e.g. "ImageBuild"). */
  name: string;
  /** Action name inside the stage (e.g. "ImageBuildArm64"). Supports ${MARKET} templating. */
  actionName: string;
  /** Human-readable description printed to the build logs via the echo buildspec. */
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — CI pipeline: Ngcom<Service>AppPipeline
// ─────────────────────────────────────────────────────────────────────────────

export const CI_STAGES: StageDef[] = [
  {
    name: 'Source',
    actionName: 'GitHub_Source',
    description: 'Source artifact from S3 (swap-ready — see buildSourceAction helper in ci-pipeline-stack.ts)',
  },
  {
    name: 'ImageBuild',
    actionName: 'ImageBuildArm64',
    description: 'Docker build → Prisma/Twistlock scan → ECR push → DynamoDB metadata insert (commitId, execId, tagStatus, sourceChange, infraChange, opaconfigChange)',
  },
  {
    name: 'GlobalDev',
    actionName: 'GlobalDevLive',
    description: 'Deploy snapshot (commit SHA tag) to Global-Dev EKS cluster via ArgoCD. nextgen-cli --tenantEnv=dev --businessArea --domain',
  },
  {
    name: 'TaggingApproval',
    actionName: 'TaggingApproval',
    description: '[MOCK APPROVAL] In production: Slack approval asking "Should we tag this build with a semver release?"',
  },
  {
    name: 'TaggingController',
    actionName: 'TaggingController',
    description: 'Auto-bump semver based on commit message convention, create git tag + GitHub release, generate changelog. Output: semver tag (e.g. 1.247.5) applied to the image.',
  },
  {
    name: 'AllTenantApproval',
    actionName: 'AllTenantApproval',
    description: '[MOCK APPROVAL] In production: Slack approval asking "Which markets should receive this release?" Triggers market-specific CD pipelines via mutation.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — CD pipeline: Ngcom<Service><Market>AppPipeline
//
// actionName values contain ${MARKET} placeholders that ci-pipeline-stack.ts
// replaces with the market code (e.g. "Tha", "Jp", "Latam") at stack construction.
// ─────────────────────────────────────────────────────────────────────────────

export const CD_STAGES: StageDef[] = [
  {
    name: 'S3Source',
    actionName: 'S3Action',
    description: 'Placeholder S3 source — satisfies CodePipeline\'s required source stage. Actual triggering happens via cascade Lambda calling StartPipelineExecution.',
  },
  {
    name: '${MARKET}Qa',
    actionName: '${MARKET}QaLive',
    description: 'Deploy tagged image to ${MARKET} QA EKS cluster via ArgoCD. nextgen-cli --tenantEnv=qa --domain=${MARKET}',
  },
  {
    name: '${MARKET}UatApproval',
    actionName: '${MARKET}UatApproval',
    description: '[MOCK APPROVAL] In production: Slack approval asking "QA validated, promote to UAT?" (configurable per team — some teams skip this).',
  },
  {
    name: '${MARKET}Uat',
    actionName: '${MARKET}UatLive',
    description: 'Deploy tagged image to ${MARKET} UAT EKS cluster via ArgoCD. nextgen-cli --tenantEnv=uat --domain=${MARKET}. Market team / functional testing.',
  },
  {
    name: '${MARKET}ProdApproval',
    actionName: '${MARKET}ProdApproval',
    description: '[MOCK APPROVAL] In production: Slack approval asking "UAT validated, promote to Production?"',
  },
  {
    name: '${MARKET}Prod',
    actionName: '${MARKET}ProdLive',
    description: 'Deploy to ${MARKET} PROD with preview → live promotion. Sub-stages: Preview deployment → Slack approval → Live deployment. nextgen-cli --tenantEnv=prod --domain=${MARKET}',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Configured universe — services × markets
// ─────────────────────────────────────────────────────────────────────────────

export const SERVICES = ['comorderas', 'copayment', 'coprofile'] as const;
export const MARKETS = ['tha', 'jp', 'latam'] as const;

export type Service = (typeof SERVICES)[number];
export type Market = (typeof MARKETS)[number];

/** Capitalize the first letter of a string — used to build pipeline names. */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Pipeline name for a CI pipeline. Mirrors Amway's naming convention. */
export function ciPipelineName(service: Service): string {
  return `Ngcom${cap(service)}AppPipeline`;
}

/** Pipeline name for a per-market CD pipeline. Mirrors Amway's naming convention. */
export function cdPipelineName(service: Service, market: Market): string {
  return `Ngcom${cap(service)}${cap(market)}AppPipeline`;
}

/** Substitute ${MARKET} template in stage names/descriptions with the uppercase market code. */
export function resolveStage(stage: StageDef, market: string): StageDef {
  const m = cap(market);
  return {
    name: stage.name.replace(/\$\{MARKET\}/g, m),
    actionName: stage.actionName.replace(/\$\{MARKET\}/g, m),
    description: stage.description.replace(/\$\{MARKET\}/g, m.toUpperCase()),
  };
}
