import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as path from 'path';

export class SourceReplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const synapseStack = this.node.tryGetContext('synapseStack') as string;
    if (!synapseStack) throw new Error('Missing context: synapseStack ("dev | prod")');

    const destBucketArn = this.node.tryGetContext('destBucketArn') as string;
    const destAccountId = this.node.tryGetContext('destAccountId') as string;
    const destDataKeyArn = this.node.tryGetContext('destDataKeyArn') as string;
    const replicationPrefix = (this.node.tryGetContext('replicationPrefix') as string) || 'rds-snapshot/';
    const setupDestinationAccess = destAccountId && destBucketArn && destDataKeyArn;

    // KMS key to encrypt source bucket objects
    const sourceDataKey = new kms.Key(this, 'SourceBucketKey', {
      enableKeyRotation: true,
      alias: `alias/${synapseStack.toLowerCase()}-source-rds-repl-bucket-key`,
    });

    const sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName : `${synapseStack.toLowerCase()}-source-rds-snapshot-replication`,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: sourceDataKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // Role to allow RDS Snapshot Export to S3 in THIS (source) account.
    const rdsExportRole = new iam.Role(this, 'RdsSnapshotExportRole', {
      roleName: 'rds-snapshot-export-to-s3-role',
      assumedBy: new iam.ServicePrincipal('export.rds.amazonaws.com'),
    });

    rdsExportRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        's3:ListMultipartUploadParts',
        's3:ListBucketMultipartUploads',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        sourceBucket.bucketArn,
        sourceBucket.arnForObjects(`${replicationPrefix}*`),
      ],
    }));

    rdsExportRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kms:Encrypt',
        'kms:GenerateDataKey*',
        'kms:Decrypt',
        'kms:DescribeKey',
      ],
      resources: [sourceDataKey.keyArn],
    }));

    sourceDataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow administration by account root',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['kms:*'],
      resources: ['*'],
    }));

    sourceDataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow use of the key by RDS export role',
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ArnPrincipal(rdsExportRole.roleArn)
      ],
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:DescribeKey',
        'kms:CreateGrant',
      ],
      resources: ['*'],
    }));

    if (setupDestinationAccess) {
      // Lambda to discover latest RDS snapshot and export it to S3
      const exportLambda = new lambda.NodejsFunction(this, 'RdsExportLambda', {
        entry: path.join(__dirname, '../lambda/rds-export/index.ts'),
        handler: 'handler',
        runtime: lambdaBase.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(60),
        environment: {
          SYNAPSE_STACK: synapseStack,
          S3_BUCKET_NAME: sourceBucket.bucketName,
          S3_PREFIX: replicationPrefix,
          RDS_EXPORT_ROLE_ARN: rdsExportRole.roleArn,
          KMS_KEY_ID: sourceDataKey.keyArn,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
        },
      });

      exportLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['rds:DescribeDBSnapshots', 'rds:DescribeExportTasks', 'rds:StartExportTask'],
        resources: ['*'],
      }));

      exportLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [rdsExportRole.roleArn],
      }));

      exportLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:CreateGrant'],
        resources: [sourceDataKey.keyArn],
      }));

      // Daily at 06:00 UTC; RDS automated snapshots typically run around 03:00 UTC
      const exportSchedule = new events.Rule(this, 'RdsExportSchedule', {
        schedule: events.Schedule.cron({ hour: '6', minute: '0' }),
      });
      exportSchedule.addTarget(new targets.LambdaFunction(exportLambda));

      // Lambda to copy each Parquet part from the source bucket into the destination
      // bucket under a layout grouped by table / stack / snapshot date.
      // S3 ARNs have the form `arn:aws:s3:::name`; bucket name is the 6th colon-delimited segment.
      const destBucketName = cdk.Fn.select(5, cdk.Fn.split(':', destBucketArn));

      // Receives both EventBridge delivery failures (target DLQ) and Lambda execution
      // failures after async retries (on-failure destination).
      // SSE-SQS rather than aws/sqs: EventBridge cannot use the AWS-managed SQS KMS key.
      const copyDlq = new sqs.Queue(this, 'RdsExportCopyDlq', {
        retentionPeriod: cdk.Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      });

      const copyLambda = new lambda.NodejsFunction(this, 'RdsExportCopyLambda', {
        entry: path.join(__dirname, '../lambda/rds-export-copy/index.ts'),
        handler: 'handler',
        runtime: lambdaBase.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.minutes(15),
        memorySize: 1024,
        environment: {
          SYNAPSE_STACK: synapseStack,
          SOURCE_BUCKET_NAME: sourceBucket.bucketName,
          SOURCE_PREFIX: replicationPrefix,
          DEST_BUCKET_NAME: destBucketName,
          DEST_PREFIX: replicationPrefix,
          DEST_KMS_KEY_ARN: destDataKeyArn,
        },
        bundling: {
          externalModules: ['@aws-sdk/*'],
        },
        retryAttempts: 2,
        onFailure: new lambdaDestinations.SqsDestination(copyDlq),
      });

      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [sourceBucket.bucketArn],
        conditions: {
          StringLike: { 's3:prefix': [`${replicationPrefix}*`] },
        },
      }));
      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectTagging'],
        resources: [sourceBucket.arnForObjects('*')],
      }));

      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [sourceDataKey.keyArn],
      }));

      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          's3:PutObject',
          's3:PutObjectAcl',
          's3:AbortMultipartUpload',
          's3:GetObject',
          's3:GetObjectAttributes',
        ],
        resources: [`${destBucketArn}/*`],
      }));
      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [destBucketArn],
      }));

      // Caller is the Lambda directly, not the S3 service — no kms:ViaService/ResourceAliases conditions.
      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [destDataKeyArn],
      }));

      copyLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['rds:DescribeExportTasks'],
        resources: ['*'],
      }));

      // RDS emits export-task lifecycle events under "RDS DB Snapshot Event" with EventIDs.
      // RDS-EVENT-0161 = export task completed. Lambda re-verifies status via DescribeExportTasks.
      const copyRule = new events.Rule(this, 'RdsExportCopyEventRule', {
        eventPattern: {
          source: ['aws.rds'],
          detailType: ['RDS DB Snapshot Event'],
          detail: {
            EventID: ['RDS-EVENT-0161'],
          },
        },
      });
      copyRule.addTarget(new targets.LambdaFunction(copyLambda, {
        retryAttempts: 2,
        deadLetterQueue: copyDlq,
      }));

      const notificationTopic = sns.Topic.fromTopicArn(this, 'NotificationTopic',
        cdk.Fn.importValue(`us-east-1-synapse-${synapseStack}-global-resources-NotificationTopic`));
      const notify = new cloudwatchActions.SnsAction(notificationTopic);

      const durationAlarm = new cloudwatch.Alarm(this, 'RdsExportCopyDurationAlarm', {
        metric: copyLambda.metricDuration({ statistic: 'Maximum' }),
        threshold: cdk.Duration.minutes(12).toMilliseconds(),
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: 'RdsExportCopyLambda approaching 15-min ceiling; consider Step Functions fan-out.',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      durationAlarm.addAlarmAction(notify);

      // Fires on the first failed attempt (each async retry counts as an error).
      const errorsAlarm = new cloudwatch.Alarm(this, 'RdsExportCopyErrorsAlarm', {
        metric: copyLambda.metricErrors({ statistic: 'Sum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: 'RdsExportCopyLambda execution failed; check CloudWatch Logs.',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errorsAlarm.addAlarmAction(notify);

      // Fires once retries are exhausted (either stage); messages need inspection/redrive.
      const dlqAlarm = new cloudwatch.Alarm(this, 'RdsExportCopyDlqAlarm', {
        metric: copyDlq.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: 'RdsExportCopyDlq has messages: a copy failed permanently and needs redrive.',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      dlqAlarm.addAlarmAction(notify);

      new cdk.CfnOutput(this, 'RdsExportCopyLambdaRoleArn', {
        value: copyLambda.role!.roleArn,
        description: 'Add this principal to the destination bucket policy and destination KMS key policy.',
      });
      new cdk.CfnOutput(this, 'RdsExportCopyDlqUrl', { value: copyDlq.queueUrl });
    }

    new cdk.CfnOutput(this, 'SourceBucketName', { value: sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'SourceBucketArn', { value: sourceBucket.bucketArn });
    new cdk.CfnOutput(this, 'ReplicationPrefix', { value: replicationPrefix });
  }
}
