import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as cpa from 'aws-cdk-lib/aws-codepipeline-actions';
import { SharedStack } from './shared-stack';
import {
  CD_STAGES,
  Service,
  Market,
  cdPipelineName,
  resolveStage,
  cap,
} from './stage-defs';

/**
 * CdPipelineStack — one Phase-2 CD pipeline for a given service × market.
 *
 * Structure mirrors Amway's NextGen CD pipeline naming + flow:
 *
 *   Ngcom<Service><Market>AppPipeline
 *     1. S3Source           (S3SourceAction, actionName "S3Action")
 *     2. <Market>Qa         (CodeBuild echo)
 *     3. <Market>UatApproval(CodeBuild echo — mock messaging, no real approval)
 *     4. <Market>Uat        (CodeBuild echo)
 *     5. <Market>ProdApproval(CodeBuild echo — mock messaging)
 *     6. <Market>Prod       (CodeBuild echo)
 *
 * The S3 source is a placeholder — nothing updates that object after the
 * initial seed. CD pipelines are triggered by the cascade Lambda calling
 * `codepipeline:StartPipelineExecution` after a CI pipeline succeeds.
 * The source action simply re-uses the last object version when that happens.
 */
export interface CdPipelineStackProps extends cdk.StackProps {
  service: Service;
  market: Market;
  shared: SharedStack;
}

export class CdPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CdPipelineStackProps) {
    super(scope, id, props);

    const { service, market, shared } = props;
    const pipelineName = cdPipelineName(service, market);

    const sourceOutput = new codepipeline.Artifact('SourceArtifact');

    const pipeline = new codepipeline.Pipeline(this, 'CdPipeline', {
      pipelineName,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket: shared.artifactBucket,
      restartExecutionOnUpdate: false,
      crossAccountKeys: false,
    });

    // Stage 1: S3 Source (placeholder — triggered via StartPipelineExecution by cascade Lambda)
    const sourceStageDef = CD_STAGES[0];
    pipeline.addStage({
      stageName: sourceStageDef.name,
      actions: [
        new cpa.S3SourceAction({
          actionName: sourceStageDef.actionName,
          bucket: shared.sourceBucket,
          bucketKey: `services/${service}/cd/${market}/source.zip`,
          output: sourceOutput,
          // POLL avoids installing an extra EventBridge rule that would race with
          // the cascade Lambda. Polls every 60s but we always invoke via
          // StartPipelineExecution, so the poll is effectively unused.
          trigger: cpa.S3Trigger.POLL,
        }),
      ],
    });

    // Stages 2-6: CodeBuild echo actions driven by CD_STAGES (with ${MARKET} substitution)
    for (let i = 1; i < CD_STAGES.length; i++) {
      const resolved = resolveStage(CD_STAGES[i], market);
      pipeline.addStage({
        stageName: resolved.name,
        actions: [
          new cpa.CodeBuildAction({
            actionName: resolved.actionName,
            project: shared.mockEchoCodeBuild,
            input: sourceOutput,
            environmentVariables: {
              PIPELINE_NAME: { value: pipelineName },
              STAGE_NAME: { value: resolved.name },
              ACTION_NAME: { value: resolved.actionName },
              SERVICE: { value: service },
              MARKET: { value: cap(market) },
              STAGE_DESCRIPTION: { value: resolved.description },
            },
          }),
        ],
      });
    }

    cdk.Tags.of(this).add('Component', 'backstage-idp-mock-pipelines');
    cdk.Tags.of(this).add('PipelineType', 'cd');
    cdk.Tags.of(this).add('Service', service);
    cdk.Tags.of(this).add('Market', market);

    new cdk.CfnOutput(this, 'CdPipelineName', {
      value: pipelineName,
      description: `Name of the CD pipeline for service ${service} / market ${market}`,
    });
  }
}
