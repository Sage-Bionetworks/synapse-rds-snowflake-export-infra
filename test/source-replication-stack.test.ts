import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SourceReplicationStack } from '../lib/source-replication-stack';

function createStack(context: Record<string, string> = {}): Template {
  const app = new cdk.App({
    context: {
      synapseStack: 'dev',
      ...context,
    },
  });
  const stack = new SourceReplicationStack(app, 'TestStack');
  return Template.fromStack(stack);
}

describe('when destination parameters are specified', () => {
  const destContext = {
    destBucketArn: 'arn:aws:s3:::dest-bucket',
    destAccountId: '123456789012',
    destDataKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/dest-key-id',
  };

  let template: Template;

  beforeAll(() => {
    template = createStack(destContext);
  });

  test('replication role has the destination bucket write statement', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              's3:ReplicateObject',
              's3:ReplicateDelete',
              's3:ReplicateTags',
            ]),
            Resource: `${destContext.destBucketArn}/*`,
          }),
        ]),
      },
    });
  });

  test('source bucket has a replication configuration', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      ReplicationConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'replicate-rds-exports',
            Status: 'Enabled',
            Filter: { Prefix: 'rds-snapshot/' },
            Destination: Match.objectLike({
              Bucket: destContext.destBucketArn,
              Account: destContext.destAccountId,
              EncryptionConfiguration: {
                ReplicaKmsKeyID: destContext.destDataKeyArn,
              },
            }),
          }),
        ]),
      }),
    });
  });
});
