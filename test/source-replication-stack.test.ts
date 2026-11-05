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

const destContext = {
  destBucketArn: 'arn:aws:s3:::dest-bucket',
  destAccountId: '123456789012',
  destDataKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/dest-key-id',
};

describe('Export Lambda (dev, with destination)', () => {
  let template: Template;

  beforeAll(() => {
    template = createStack(destContext);
  });

  test('export Lambda has expected env vars', () => {
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

  test('export Lambda role has RDS and iam:PassRole permissions', () => {
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
});

describe('EventBridge schedule', () => {
  test.each(['dev', 'prod'])('%s has a daily 06:00 UTC schedule rule', (synapseStack) => {
    const template = createStack({ ...destContext, synapseStack });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 6 * * ? *)',
      State: 'ENABLED',
    });
  });
});

describe('Copy Lambda + event rule (dev, with destination)', () => {
  let template: Template;

  beforeAll(() => {
    template = createStack(destContext);
  });

  test('copy Lambda exists with expected env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Timeout: 900,
      MemorySize: 1024,
      Environment: {
        Variables: Match.objectLike({
          SYNAPSE_STACK: 'dev',
          SOURCE_PREFIX: 'rds-snapshot/',
          DEST_PREFIX: 'rds-snapshot/',
          DEST_KMS_KEY_ARN: destContext.destDataKeyArn,
        }),
      },
    });
  });

  test('event-pattern rule targets the export-completion event', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.rds'],
        'detail-type': ['RDS DB Snapshot Event'],
        detail: { EventID: ['RDS-EVENT-0161'] },
      }),
    });
  });

  test('copy Lambda role has source read + source KMS decrypt', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject', 's3:GetObjectTagging']),
          }),
          Match.objectLike({
            Action: Match.arrayWith(['kms:Decrypt', 'kms:DescribeKey']),
          }),
        ]),
      },
    });
  });

  test('copy Lambda role has dest-bucket write to destBucketArn/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              's3:PutObject',
              's3:PutObjectAcl',
              's3:AbortMultipartUpload',
            ]),
            Resource: `${destContext.destBucketArn}/*`,
          }),
        ]),
      },
    });
  });

  test('copy Lambda role has unconditional dest KMS Encrypt (no ViaService / ResourceAliases)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Encrypt', 'kms:GenerateDataKey*']),
            Resource: destContext.destDataKeyArn,
            Condition: Match.absent(),
          }),
        ]),
      },
    });
  });

  test('DLQ and duration alarm exist', () => {
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  });

  test('exposes copy Lambda role ARN as a stack output', () => {
    template.hasOutput('RdsExportCopyLambdaRoleArn', {});
  });
});

describe('when destination parameters are absent', () => {
  let template: Template;

  beforeAll(() => {
    template = createStack();
  });

  test('no Lambdas are created', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    expect(Object.keys(fns)).toHaveLength(0);
  });

  test('no EventBridge rules are created', () => {
    template.resourceCountIs('AWS::Events::Rule', 0);
  });

  test('no DLQ or alarm is created', () => {
    template.resourceCountIs('AWS::SQS::Queue', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });
});
