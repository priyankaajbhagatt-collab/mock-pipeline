import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SeedSources } from './seed-sources';

/**
 * SharedStack — resources used by every CI and CD pipeline in the mock universe.
 *
 * Contents:
 *   1. MockSourceBucket   — versioned S3 bucket holding per-pipeline source.zip
 *                           objects. S3SourceActions in the CI and CD pipelines
 *                           watch objects here.
 *   2. MockArtifactBucket — separate versioned S3 bucket for CodePipeline run
 *                           artifacts (CDK default pattern; keeping it isolated
 *                           from the source bucket avoids any accidental
 *                           cross-contamination).
 *   3. MockEchoCodeBuild  — single shared CodeBuild PipelineProject referenced
 *                           by every CodeBuildAction in every pipeline. The
 *                           buildspec is inline and prints the stage name +
 *                           description (passed via environment variables by
 *                           the caller).
 *
 * Exported via the `SharedResources` type so the per-pipeline stacks can wire
 * them up in-process (single CDK app → all stacks share in-memory references).
 */
export interface SharedStackProps extends cdk.StackProps {
  services: readonly string[];
  markets: readonly string[];
}

export class SharedStack extends cdk.Stack {
  public readonly sourceBucket: s3.IBucket;
  public readonly artifactBucket: s3.IBucket;
  public readonly mockEchoCodeBuild: codebuild.PipelineProject;
  public readonly codeBuildLogGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, props);

    // ── 1. Source bucket ──────────────────────────────────────────────────
    //
    // Must be:
    //   - Versioned  (required by S3Trigger.EVENTS — CodePipeline tracks object
    //                 versions, not just object keys)
    //   - EventBridge-notifications enabled (so S3 PutObject events go to
    //                 EventBridge rules the S3SourceAction installs)
    //
    // Bucket name includes the account ID to guarantee global uniqueness.
    this.sourceBucket = new s3.Bucket(this, 'MockSourceBucket', {
      bucketName: `backstage-idp-mock-source-${this.account}`,
      versioned: true,
      eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── 2. Artifact bucket ────────────────────────────────────────────────
    //
    // Required by CodePipeline to hand artifacts between stages. Keep it
    // separate from the source bucket so destroys/debugging stay clean.
    this.artifactBucket = new s3.Bucket(this, 'MockArtifactBucket', {
      bucketName: `backstage-idp-mock-artifact-${this.account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Artifacts from old runs eat no space in the demo, but set a lifecycle
      // rule anyway so this doesn't become a surprise over months.
      lifecycleRules: [
        {
          id: 'expire-old-artifacts',
          enabled: true,
          expiration: cdk.Duration.days(14),
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ],
    });

    // ── 3. CodeBuild log group ────────────────────────────────────────────
    //
    // All stages log to a single group so `aws logs tail` can show the whole
    // run in one stream. 7-day retention keeps costs negligible.
    this.codeBuildLogGroup = new logs.LogGroup(this, 'MockEchoCodeBuildLogGroup', {
      logGroupName: '/aws/codebuild/MockEchoCodeBuild',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 4. Shared CodeBuild PipelineProject ───────────────────────────────
    //
    // ONE project serves every stage of every pipeline. The stage-specific
    // information (stage name, description, service, market) is passed per
    // invocation via `environmentVariablesOverride` on each CodeBuildAction.
    //
    // The buildspec is inline and does nothing but echo those env vars and
    // sleep for a few seconds to simulate work. No Docker, no ECR push, no
    // deployment — it's a pure visual mock.
    this.mockEchoCodeBuild = new codebuild.PipelineProject(this, 'MockEchoCodeBuild', {
      projectName: 'MockEchoCodeBuild',
      description: 'Shared mock CodeBuild project used by every stage of every mock CI/CD pipeline. Each invocation prints its stage name + description and exits 0.',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL, // cheapest tier — ~$0.005/minute
        privileged: false,
      },
      // Inline buildspec — see `phases.build.commands` below for what runs.
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "================================================================="',
              'echo "  Pipeline : ${PIPELINE_NAME:-unknown}"',
              'echo "  Stage    : ${STAGE_NAME:-unknown}"',
              'echo "  Action   : ${ACTION_NAME:-unknown}"',
              'echo "  Service  : ${SERVICE:-unknown}"',
              'echo "  Market   : ${MARKET:-global}"',
              'echo "================================================================="',
              'echo ""',
              'echo "${STAGE_DESCRIPTION:-no description provided}"',
              'echo ""',
              'echo "Simulating work..."',
              'sleep 5',
              'echo "Done."',
            ],
          },
        },
      }),
      // Route logs to our explicit log group (keeps all stages in one place).
      logging: {
        cloudWatch: {
          logGroup: this.codeBuildLogGroup,
          enabled: true,
        },
      },
    });

    // Grant CodeBuild service role read access to the source bucket so it can
    // download source artifacts that the S3SourceAction passes to it.
    this.sourceBucket.grantRead(this.mockEchoCodeBuild);
    this.artifactBucket.grantReadWrite(this.mockEchoCodeBuild);

    // ── 5. Seed initial source.zip objects ───────────────────────────────
    //
    // Every pipeline's S3SourceAction expects its watched object to already
    // exist at stack creation time — otherwise the source stage immediately
    // fails. SeedSources uses s3-deployment to upload a trivial source.zip
    // for every CI and CD pipeline key. Runs once per deploy, idempotent.
    new SeedSources(this, 'SeedSources', {
      sourceBucket: this.sourceBucket,
      services: props.services,
      markets: props.markets,
    });

    // ── Stack outputs ─────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: this.sourceBucket.bucketName,
      description: 'Versioned S3 bucket holding per-pipeline source.zip objects',
      exportName: 'BackstageIdpMockSourceBucketName',
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description: 'Versioned S3 bucket for CodePipeline run artifacts',
      exportName: 'BackstageIdpMockArtifactBucketName',
    });

    new cdk.CfnOutput(this, 'MockEchoCodeBuildName', {
      value: this.mockEchoCodeBuild.projectName,
      description: 'Shared CodeBuild project name used by every pipeline stage',
      exportName: 'BackstageIdpMockEchoCodeBuildName',
    });
  }
}
