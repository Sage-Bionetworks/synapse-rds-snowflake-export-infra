# synapse-rds-snowflake-export-infra

AWS CDK (TypeScript) app that exports the Synapse RDS database snapshot to S3 as Parquet every day and copies it into a destination account's bucket in a layout suited to Snowflake ingestion.

## How it works

One stack, `SourceReplicationStack` (`lib/source-replication-stack.ts`):

1. **`RdsExportLambda`** runs daily at 06:00 UTC. It reads the current stack instance from the Synapse version endpoint, finds the latest automated snapshot of `<synapseStack>-<stackInstance>-db`, and starts an RDS export task into the source bucket (KMS-encrypted, versioned, retained).
2. **`RdsExportCopyLambda`** runs when RDS reports the export complete (`RDS-EVENT-0161`). It copies each Parquet part to
   `<replicationPrefix>/<TABLE_NAME>/<stackInstance>/<YYYY-MM-DD>/part-*.parquet`
   in the destination bucket, encrypted with the destination KMS key.
3. Failed copies go to an SQS dead-letter queue after 2 retries. CloudWatch alarms on copy errors, DLQ depth, and copy duration notify the Synapse global-resources SNS topic.

The export and copy pipeline is created only when `destBucketArn`, `destAccountId`, and `destDataKeyArn` are all set. Without them, the stack deploys only the source bucket, KMS key, and export role.

## Context parameters

| Parameter | Required | Description |
|---|---|---|
| `synapseStack` | Yes | `dev` or `prod` |
| `destBucketArn` | For pipeline | Destination S3 bucket ARN |
| `destAccountId` | For pipeline | Destination AWS account ID |
| `destDataKeyArn` | For pipeline | Destination KMS key ARN |
| `replicationPrefix` | No | Object prefix, default `rds-snapshot/` |

## Destination account prerequisites

The destination account owner must allow the `RdsExportCopyLambdaRoleArn` stack output as a principal in:

1. **The bucket policy:** `s3:PutObject`, `s3:PutObjectAcl`, `s3:AbortMultipartUpload`, `s3:GetObject`, `s3:GetObjectAttributes` on `<destBucketArn>/<replicationPrefix>*`, and `s3:ListBucket` on the bucket.
2. **The KMS key policy:** `kms:Encrypt`, `kms:GenerateDataKey*`, `kms:DescribeKey`.

Until both are in place, every copy fails with 403 and ends up in the DLQ.

## Development

```bash
npm ci
npm run build                                   # type-check (no output files)
npm test                                        # Jest + CDK assertions
npx cdk synth -c synapseStack=dev \
  -c destBucketArn=arn:aws:s3:::example-dest-bucket \
  -c destAccountId=111111111111 \
  -c destDataKeyArn=arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000
```

## Deployment

GitHub Actions deploys `develop` to dev and `main` to prod. Settings come from GitHub environment variables (`SYNAPSE_STACK`, `DEST_BUCKET_ARN`, `DEST_ACCOUNT_ID`, `DEST_DATA_KEY_ARN`). See [`.github/README.md`](.github/README.md) for the promotion flow.
