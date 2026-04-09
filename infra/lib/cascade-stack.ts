import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { cap, Service, Market } from './stage-defs';

/**
 * CascadeStack — CI → CD trigger plumbing.
 *
 * Flow:
 *   1. A CI pipeline (Ngcom<Service>AppPipeline) reaches SUCCEEDED state
 *   2. CodePipeline emits a "CodePipeline Pipeline Execution State Change" event on the default bus
 *   3. EventBridge rule (pattern below) matches the event
 *   4. Rule targets a Lambda (inline Node.js, ~30 lines)
 *   5. Lambda parses the service name from the pipeline name, computes the
 *      3 per-market CD pipeline names, and calls StartPipelineExecution for each
 *
 * Security: the Lambda role is scoped to exactly the ~12 pipeline ARNs
 * matching the Ngcom*AppPipeline naming pattern.
 */
export interface CascadeStackProps extends cdk.StackProps {
  services: readonly Service[];
  markets: readonly Market[];
}

export class CascadeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CascadeStackProps) {
    super(scope, id, props);

    const { services, markets } = props;

    // Full list of CI pipeline names (we want to match ONLY these, not the CD ones)
    const ciPipelineNames = services.map((svc) => `Ngcom${cap(svc)}AppPipeline`);

    // Full list of CD pipeline ARNs the Lambda needs permission to start
    const cdPipelineArns: string[] = [];
    for (const svc of services) {
      for (const mkt of markets) {
        cdPipelineArns.push(
          `arn:aws:codepipeline:${this.region}:${this.account}:Ngcom${cap(svc)}${cap(mkt)}AppPipeline`,
        );
      }
    }

    // ── Cascade Lambda ────────────────────────────────────────────────────
    //
    // Inline Node.js — parses the CI pipeline name from the incoming event,
    // figures out which service it is, then starts the 3 market CD pipelines
    // for that service in parallel.
    //
    // The list of valid services + markets is baked into the code at deploy
    // time via env vars, so the Lambda doesn't need any config lookup at
    // runtime.
    // Explicit log group so we can set a 7-day retention without the deprecated
    // `logRetention` property on the Function itself.
    const cascadeLogGroup = new logs.LogGroup(this, 'CascadeLambdaLogGroup', {
      logGroupName: '/aws/lambda/BackstageIdpMockCascadeLambda',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cascadeFn = new lambda.Function(this, 'CascadeLambda', {
      functionName: 'BackstageIdpMockCascadeLambda',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: cascadeLogGroup,
      environment: {
        SERVICES: services.join(','),
        MARKETS: markets.join(','),
        REGION: this.region,
        ACCOUNT: this.account,
      },
      code: lambda.Code.fromInline(`
const { CodePipelineClient, StartPipelineExecutionCommand } = require('@aws-sdk/client-codepipeline');

const cp = new CodePipelineClient({ region: process.env.REGION });

const SERVICES = (process.env.SERVICES || '').split(',').filter(Boolean);
const MARKETS  = (process.env.MARKETS  || '').split(',').filter(Boolean);

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

exports.handler = async (event) => {
  console.log('Incoming event:', JSON.stringify(event));

  const pipelineName = event?.detail?.pipeline;
  const state = event?.detail?.state;

  if (state !== 'SUCCEEDED') {
    console.log(\`Ignoring state=\${state} for pipeline=\${pipelineName} — only SUCCEEDED triggers cascade\`);
    return { ok: true, skipped: true };
  }

  // Figure out which service this CI pipeline belongs to.
  // CI pipeline naming: Ngcom<Cap(service)>AppPipeline
  // CD pipeline naming: Ngcom<Cap(service)><Cap(market)>AppPipeline
  // We need to match CI only — reject anything that already contains a market suffix.
  const match = /^Ngcom(.+)AppPipeline$/.exec(pipelineName || '');
  if (!match) {
    console.log(\`Pipeline name "\${pipelineName}" does not match Ngcom*AppPipeline — ignoring\`);
    return { ok: true, skipped: true };
  }

  const middle = match[1]; // e.g. "Comorderas" (CI) or "ComorderasTha" (CD)

  // Find the service whose capitalized form is a prefix of 'middle'.
  // The remaining suffix must EITHER be empty (CI) or equal to a known market (CD).
  let matchedService = null;
  let suffix = '';
  for (const svc of SERVICES) {
    const capSvc = cap(svc);
    if (middle === capSvc) {
      matchedService = svc;
      suffix = '';
      break;
    }
    if (middle.startsWith(capSvc)) {
      const rest = middle.slice(capSvc.length);
      // Is the rest a known market? If so, this is a CD pipeline — skip.
      // If the rest is not empty, it must be a market — which means this
      // event is from a CD pipeline and we ignore it.
      matchedService = svc;
      suffix = rest;
      break;
    }
  }

  if (!matchedService) {
    console.log(\`No known service matched for pipeline "\${pipelineName}"\`);
    return { ok: true, skipped: true };
  }

  if (suffix !== '') {
    console.log(\`Pipeline "\${pipelineName}" is a CD pipeline (service=\${matchedService}, suffix=\${suffix}) — ignoring to avoid cascade loop\`);
    return { ok: true, skipped: true };
  }

  // It's a CI pipeline for a known service — fan out to the 3 CD pipelines.
  const cdPipelineNames = MARKETS.map((mkt) => \`Ngcom\${cap(matchedService)}\${cap(mkt)}AppPipeline\`);

  console.log(\`CI pipeline \${pipelineName} succeeded — starting CD pipelines: \${cdPipelineNames.join(', ')}\`);

  const results = await Promise.allSettled(
    cdPipelineNames.map((name) =>
      cp.send(new StartPipelineExecutionCommand({ name })),
    ),
  );

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(\`Started \${cdPipelineNames[i]} → executionId=\${r.value.pipelineExecutionId}\`);
    } else {
      console.error(\`Failed to start \${cdPipelineNames[i]}:\`, r.reason);
    }
  });

  return {
    ok: true,
    sourcePipeline: pipelineName,
    startedCdPipelines: cdPipelineNames.filter((_, i) => results[i].status === 'fulfilled'),
    failedCdPipelines:  cdPipelineNames.filter((_, i) => results[i].status === 'rejected'),
  };
};
`),
    });

    // Scope the Lambda's IAM permissions to exactly the CD pipeline ARNs
    cascadeFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['codepipeline:StartPipelineExecution'],
        resources: cdPipelineArns,
      }),
    );

    // ── EventBridge rule ──────────────────────────────────────────────────
    //
    // Matches Pipeline Execution State Change events where:
    //   - state = SUCCEEDED
    //   - pipeline name starts with "Ngcom" (broad; Lambda does final filtering)
    //
    // We could use a tighter event pattern with the exact CI pipeline name list,
    // but that requires maintaining two lists in sync. The Lambda already
    // filters out CD pipelines by name, so a broad pattern is fine.
    new events.Rule(this, 'CiPipelineSuccessRule', {
      ruleName: 'BackstageIdpMockCiSuccessRule',
      description: 'Fires when any mock CI pipeline (Ngcom*AppPipeline, not CD) succeeds, triggering the cascade Lambda to start the 3 market CD pipelines.',
      eventPattern: {
        source: ['aws.codepipeline'],
        detailType: ['CodePipeline Pipeline Execution State Change'],
        detail: {
          state: ['SUCCEEDED'],
          pipeline: ciPipelineNames, // exact match against the CI pipeline names
        },
      },
      targets: [new targets.LambdaFunction(cascadeFn)],
    });

    cdk.Tags.of(this).add('Component', 'backstage-idp-mock-pipelines');
    cdk.Tags.of(this).add('PipelineType', 'cascade');

    new cdk.CfnOutput(this, 'CascadeLambdaName', {
      value: cascadeFn.functionName,
      description: 'Name of the cascade Lambda that starts CD pipelines on CI success',
    });
  }
}
