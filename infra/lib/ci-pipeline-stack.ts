import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpa from 'aws-cdk-lib/aws-codepipeline-actions';
import { SharedStack } from './shared-stack';
import {
  CI_STAGES,
  Service,
  ciPipelineName,
} from './stage-defs';

/**
 * CiPipelineStack — one Phase-1 CI pipeline for a given service.
 *
 * Structure mirrors Amway's NextGen CI pipeline naming + flow:
 *
 *   Ngcom<Service>AppPipeline
 *     1. Source           (S3SourceAction, actionName "GitHub_Source")
 *     2. ImageBuild       (CodeBuild echo)
 *     3. GlobalDev        (CodeBuild echo)
 *     4. TaggingApproval  (CodeBuild echo — mock messaging, no real approval)
 *     5. TaggingController(CodeBuild echo)
 *     6. AllTenantApproval(CodeBuild echo — mock messaging)
 *
 * The Source action is produced by the private `buildSourceAction()` helper
 * below — this is the ONE place in the codebase the source provider is chosen.
 * To swap from S3 → Bitbucket in the future, only that one helper needs
 * changing (see the commented migration stub at the bottom of this file).
 */
export interface CiPipelineStackProps extends cdk.StackProps {
  service: Service;
  shared: SharedStack;
}

export class CiPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CiPipelineStackProps) {
    super(scope, id, props);

    const { service, shared } = props;
    const pipelineName = ciPipelineName(service);

    // ── Source artifact handed to downstream CodeBuild stages ────────────
    const sourceOutput = new codepipeline.Artifact('SourceArtifact');

    // ── Build the pipeline ────────────────────────────────────────────────
    const pipeline = new codepipeline.Pipeline(this, 'CiPipeline', {
      pipelineName,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: shared.artifactBucket,
      restartExecutionOnUpdate: false,
      crossAccountKeys: false,
    });

    // Stage 1: Source (via the swap-ready helper)
    pipeline.addStage({
      stageName: CI_STAGES[0].name,
      actions: [this.buildSourceAction(service, sourceOutput, shared)],
    });

    // Stages 2-6: CodeBuild echo actions driven by CI_STAGES constants
    for (let i = 1; i < CI_STAGES.length; i++) {
      const stage = CI_STAGES[i];
      pipeline.addStage({
        stageName: stage.name,
        actions: [
          new cpa.CodeBuildAction({
            actionName: stage.actionName,
            project: shared.mockEchoCodeBuild,
            input: sourceOutput,
            environmentVariables: {
              PIPELINE_NAME: { value: pipelineName },
              STAGE_NAME: { value: stage.name },
              ACTION_NAME: { value: stage.actionName },
              SERVICE: { value: service },
              MARKET: { value: 'global' },
              STAGE_DESCRIPTION: { value: stage.description },
            },
          }),
        ],
      });
    }

    // Tag the pipeline stack so it's easy to find in the console.
    cdk.Tags.of(this).add('Component', 'backstage-idp-mock-pipelines');
    cdk.Tags.of(this).add('PipelineType', 'ci');
    cdk.Tags.of(this).add('Service', service);

    new cdk.CfnOutput(this, 'CiPipelineName', {
      value: pipelineName,
      description: `Name of the CI pipeline for service ${service}`,
    });
  }

  /**
   * Swap-ready source action helper.
   *
   * This is the ONLY place in the entire CDK app where the source provider
   * is chosen. Changing from S3 to Bitbucket is a ~10-line diff here — no
   * other file needs to change.
   */
  private buildSourceAction(
    service: Service,
    output: codepipeline.Artifact,
    shared: SharedStack,
  ): cpa.Action {
    // ── CURRENT: S3 source (no Bitbucket workspace admin required) ───────
    return new cpa.S3SourceAction({
      actionName: 'GitHub_Source', // visual fidelity to Amway's real stage name
      bucket: shared.sourceBucket,
      bucketKey: `services/${service}/source.zip`,
      output,
      trigger: cpa.S3Trigger.EVENTS, // ~1s latency via EventBridge + S3 notifications
    });

    // ── FUTURE: swap to Bitbucket once workspace admin installs the AWS
    // CodeStar Connections Bitbucket app on the altimetrikgit workspace.
    //
    // 1. Create the CodeStar Connection in the AWS console (manual, 5 min)
    // 2. Copy the connection ARN
    // 3. Uncomment and return the block below; delete the S3 block above.
    // 4. cdk deploy the 3 Ngcom*AppPipelineStack stacks — everything else
    //    (CD pipelines, cascade, Backstage plugin) stays unchanged.
    //
    // return new cpa.CodeStarConnectionsSourceAction({
    //   actionName: 'GitHub_Source',
    //   connectionArn: 'arn:aws:codestar-connections:us-east-1:381492075615:connection/<UUID>',
    //   owner: 'altimetrikgit',
    //   repo: 'backstage-idp-mock-pipelines',
    //   branch: 'main',
    //   triggerOnPush: true,
    //   output,
    // });
  }
}
