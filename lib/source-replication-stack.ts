import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
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
    const replicationRoleName = (this.node.tryGetContext('replicationRoleName') as string) || `${synapseStack.toLowerCase()}-rds-repl-role`;
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

    // Replication role (In SOURCE account, for S3 to assume when replicating objects to destination bucket in another account)
    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      roleName: replicationRoleName,
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
    });

    // Allow S3 to read from source bucket
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetReplicationConfiguration',
        's3:ListBucket',
      ],
      resources: [sourceBucket.bucketArn],
    }));

    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObjectVersion*',
        's3:GetObjectVersionAcl',
        's3:GetObjectVersionTagging',
      ],
      resources: [sourceBucket.arnForObjects('*')],
    }));

    // Allow S3 to write to destination bucket when specified by replication configuration
    if (setupDestinationAccess) {
      replicationRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          's3:ObjectOwnerOverrideToBucketOwner',
          's3:ReplicateObject',
          's3:ReplicateDelete',
          's3:ReplicateTags',
          's3:PutObject',
          's3:PutObjectTagging',
          's3:PutObjectAcl',
        ],
        resources: [`${destBucketArn}/*`],
      }));
    }

    // KMS permissions for replication (S3 needs to decrypt from source and encrypt to destination)
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [sourceDataKey.keyArn],
    }));

    // Role to allow RDS Snapshot Export to S3 in THIS (source) account.
    const rdsExportRole = new iam.Role(this, 'RdsSnapshotExportRole', {
      roleName: 'rds-snapshot-export-to-s3-role',
      assumedBy: new iam.ServicePrincipal('export.rds.amazonaws.com'),
    });

    // Allow RDS export to write objects into the source bucket (under prefix)
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

    // KMS permissions for export encryption
    rdsExportRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kms:Encrypt',
        'kms:GenerateDataKey*',
        'kms:Decrypt',
        'kms:DescribeKey',
      ],
      resources: [sourceDataKey.keyArn],
    }));

    // Allow administration by account root
    sourceDataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'Allow administration by account root',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['kms:*'],
      resources: ['*'],
    }));

    // Allow use of the key by all IAM users/roles in the account
    // Grant use of the key to the RDS export role (required for RDS snapshot export)
    // Reference the role created above to avoid hardcoding the ARN
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
      ],
      resources: ['*'],
    }));
  
    // KMS permissions to use destination key for replication
    // Using alias allows referecing the key before it exists 
    const destDataKeyAlias = 'kms-synapse-snowflake-rds-snapshots-'+synapseStack.toLowerCase();
    replicationRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kms:Encrypt',
        'kms:GenerateDataKey*'
      ],
      resources: ['*'],
      conditions: {
        'ForAnyValue:StringEquals': {
          'kms:ResourceAliases': [ `alias/${destDataKeyAlias}`, ],
        },
        'StringEquals': {
            'kms:ViaService': 's3.us-east-1.amazonaws.com'
        }
      }
    }));
    
    if (setupDestinationAccess) {
      // Apply replication configuration using low-level CfnBucket for full control.
      // NOTE: destination bucket must already exist, and must have versioning enabled + bucket policy allowing this role.
      const cfnSourceBucket = sourceBucket.node.defaultChild as s3.CfnBucket;
      cfnSourceBucket.replicationConfiguration = {
        role: replicationRole.roleArn,
        rules: [
          {
            id: 'replicate-rds-exports',
            status: 'Enabled',
            priority: 1,
            filter: { prefix: replicationPrefix },
            sourceSelectionCriteria: { sseKmsEncryptedObjects: { status: 'Enabled', }, },
            destination: {
              bucket: destBucketArn,
              account: destAccountId,
              accessControlTranslation: { owner: 'Destination' },
              encryptionConfiguration: { replicaKmsKeyId: `${destDataKeyArn}`, },
            },
            deleteMarkerReplication: { status: 'Disabled' },
          },
        ],
      };

      // Lambda to discover latest RDS snapshot and export it to S3 daily
      const exportLambda = new lambda.NodejsFunction(this, 'RdsExportLambda', {
        entry: path.join(__dirname, '../lambda/rds-export/index.ts'),
        handler: 'handler',
        runtime: lambdaBase.Runtime.NODEJS_20_X,
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

      // const exportSchedule = new events.Rule(this, 'RdsExportSchedule', {
      //   schedule: events.Schedule.cron({ hour: '24', minute: '0' }),
      // });
      // exportSchedule.addTarget(new targets.LambdaFunction(exportLambda));

    }

    new cdk.CfnOutput(this, 'SourceBucketName', { value: sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'SourceBucketArn', { value: sourceBucket.bucketArn });
    new cdk.CfnOutput(this, 'ReplicationRoleArn', { value: replicationRole.roleArn });
    new cdk.CfnOutput(this, 'ReplicationPrefix', { value: replicationPrefix });
  }
}