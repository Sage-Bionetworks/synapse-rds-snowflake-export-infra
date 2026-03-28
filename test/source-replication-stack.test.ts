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

describe('Lambda and EventBridge', () => {
  let template: Template;

  beforeAll(() => {
    template = createStack();
  });

  test('Lambda function is created with correct environment variables', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Environment: {
        Variables: Match.objectLike({
          SYNAPSE_STACK: 'dev',
          S3_PREFIX: 'rds-snapshot/',
        }),
      },
    });
  });

  test('Lambda execution role has RDS and iam:PassRole permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'rds:DescribeDBSnapshots',
              'rds:DescribeExportTasks',
              'rds:StartExportTask',
            ]),
            Resource: '*',
          }),
        ]),
      },
    });

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:PassRole',
          }),
        ]),
      },
    });
  });

  test('EventBridge rule exists with daily 05:00 UTC schedule', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 5 * * ? *)',
      State: 'ENABLED',
    });
  });

  test('EventBridge rule targets the Lambda', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^RdsExportLambda')]) }),
        }),
      ]),
    });
  });
});

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
