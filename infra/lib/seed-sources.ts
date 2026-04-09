import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * SeedSources — seeds the initial source.zip objects that every pipeline's
 * S3SourceAction expects to exist.
 *
 * Why this is needed:
 *   - An S3SourceAction in a CodePipeline REQUIRES the watched object to exist
 *     when the pipeline is first created, otherwise the source stage fails
 *     immediately with "Object does not exist".
 *   - `cdk deploy` creates the pipelines, but nothing uploads source.zip to the
 *     bucket, so we need a one-shot seed step.
 *
 * How it works:
 *   - At synth time we build a trivial source.zip (single file containing a
 *     timestamp) on the local machine and hand it to a BucketDeployment
 *     construct.
 *   - BucketDeployment uses a CDK-managed Lambda at deploy time to copy the
 *     object(s) into the target bucket. It also handles updates idempotently
 *     on re-deploys.
 *
 * Upload targets:
 *   - CI pipelines: services/<svc>/source.zip
 *   - CD pipelines: services/<svc>/cd/<mkt>/source.zip
 *
 * These are all seeded with the SAME trivial zip — the contents don't matter
 * because the mock buildspec ignores them.
 */
export interface SeedSourcesProps {
  sourceBucket: s3.IBucket;
  services: readonly string[];
  markets: readonly string[];
}

export class SeedSources extends Construct {
  constructor(scope: Construct, id: string, props: SeedSourcesProps) {
    super(scope, id);

    // Build a trivial source.zip on the local machine at synth time.
    // It contains a single placeholder file — the mock buildspec never reads
    // it, but the archive must be a valid zip so CodePipeline can unzip it.
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-src-'));
    const srcDir = path.join(stageDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'placeholder.txt'),
      `mock source placeholder\nseeded at synth time: ${new Date().toISOString()}\n`,
    );

    // Zip it up using the system zip command (present on macOS + Linux).
    const zipPath = path.join(stageDir, 'source.zip');
    execSync(`cd "${srcDir}" && zip -q -r "${zipPath}" .`);

    // We need one BucketDeployment per destination key because the
    // BucketDeployment construct deploys an entire directory to a single
    // bucket prefix. To get a single source.zip at a specific key, we create
    // a dir with exactly one file named source.zip, then deploy to that
    // prefix.
    for (const svc of props.services) {
      this.deployOneZip(
        `SeedCiSource${cap(svc)}`,
        zipPath,
        props.sourceBucket,
        `services/${svc}`,
      );

      for (const mkt of props.markets) {
        this.deployOneZip(
          `SeedCdSource${cap(svc)}${cap(mkt)}`,
          zipPath,
          props.sourceBucket,
          `services/${svc}/cd/${mkt}`,
        );
      }
    }
  }

  /** Helper: stage a single source.zip into a directory and deploy it to the
   * given bucket prefix so the object ends up at `${prefix}/source.zip`. */
  private deployOneZip(id: string, zipPath: string, bucket: s3.IBucket, prefix: string): void {
    // Stage the single file into a temp dir named by the construct ID.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), `stage-${id}-`));
    fs.copyFileSync(zipPath, path.join(stage, 'source.zip'));

    new s3deploy.BucketDeployment(this, id, {
      sources: [s3deploy.Source.asset(stage)],
      destinationBucket: bucket,
      destinationKeyPrefix: prefix,
      prune: false,          // don't delete other objects in the bucket
      retainOnDelete: false, // clean up on stack destroy
    });
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
