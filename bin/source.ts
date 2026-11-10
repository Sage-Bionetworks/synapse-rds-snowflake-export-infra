#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SourceReplicationStack } from '../lib/source-replication-stack';

const app = new cdk.App();
new SourceReplicationStack(app, 'source-rds-replication', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
