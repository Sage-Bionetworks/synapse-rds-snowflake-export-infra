import { RDSClient, DescribeDBSnapshotsCommand, DescribeExportTasksCommand, StartExportTaskCommand } from '@aws-sdk/client-rds';

const rds = new RDSClient({});

const VERSION_ENDPOINTS: Record<string, string> = {
  prod: 'https://repo-prod.prod.synapse.org/repo/v1/version',
  dev: 'https://repo-prod.dev.sagebase.org/repo/v1/version',
};

interface VersionResponse {
  version: string;
  stackInstance: string;
}

export async function handler(): Promise<void> {
  const synapseStack = process.env.SYNAPSE_STACK!;
  const s3BucketName = process.env.S3_BUCKET_NAME!;
  const s3Prefix = process.env.S3_PREFIX!;
  const rdsExportRoleArn = process.env.RDS_EXPORT_ROLE_ARN!;
  const kmsKeyId = process.env.KMS_KEY_ID!;

  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd

  // 1. Fetch current Synapse version
  const versionUrl = VERSION_ENDPOINTS[synapseStack];
  if (!versionUrl) {
    throw new Error(`No version endpoint configured for synapseStack="${synapseStack}"`);
  }

  console.log(`Fetching version from ${versionUrl}`);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Version endpoint returned ${response.status}: ${await response.text()}`);
  }
  const versionData: VersionResponse = await response.json() as VersionResponse;
  const stackInstance = versionData.stackInstance;
  console.log(`Stack instance: ${stackInstance}`);

  const dbInstanceId = `${synapseStack}-${stackInstance}-db`;

  // 2. Check for existing export for today
  const exportTaskPrefix = `${synapseStack}-${dbInstanceId}`;
  console.log(`Checking for existing export tasks matching prefix "${exportTaskPrefix}" for date ${today}`);

  const existingTasks = await rds.send(new DescribeExportTasksCommand({}));
  const todaysTask = existingTasks.ExportTasks?.find(
    (task) => task.ExportTaskIdentifier?.startsWith(exportTaskPrefix) && task.ExportTaskIdentifier?.endsWith(today)
  );

  if (todaysTask) {
    const status = todaysTask.Status;
    if (status === 'STARTING' || status === 'IN_PROGRESS' || status === 'COMPLETE') {
      console.log(`Export task "${todaysTask.ExportTaskIdentifier}" already exists with status "${status}". Skipping.`);
      return;
    }
  }

  // 3. Find the latest automated snapshot for the DB instance
  const snapshotType = synapseStack === 'dev' ? 'manual' : 'automated';
  console.log(`Looking for ${snapshotType} snapshots for DB instance "${dbInstanceId}"`);
  const snapshots = await rds.send(new DescribeDBSnapshotsCommand({
    DBInstanceIdentifier: dbInstanceId,
    SnapshotType: snapshotType,
  }));

  if (!snapshots.DBSnapshots || snapshots.DBSnapshots.length === 0) {
    console.warn(`No automated snapshots found for DB instance "${dbInstanceId}". Exiting.`);
    return;
  }

  const sorted = snapshots.DBSnapshots
    .filter((s) => s.SnapshotCreateTime)
    .sort((a, b) => b.SnapshotCreateTime!.getTime() - a.SnapshotCreateTime!.getTime());

  const latestSnapshot = sorted[0];
  console.log(`Latest snapshot: ${latestSnapshot.DBSnapshotIdentifier} (created ${latestSnapshot.SnapshotCreateTime?.toISOString()})`);

  // 4. Build export task identifier (alphanumeric + hyphens only, strip "rds:" prefix)
  const snapshotId = latestSnapshot.DBSnapshotIdentifier!.replace(/^rds:/, '');
  const exportTaskId = `${synapseStack}-${snapshotId}-${today}`;

  console.log(`Starting export task "${exportTaskId}"`);
  const exportResult = await rds.send(new StartExportTaskCommand({
    ExportTaskIdentifier: exportTaskId,
    SourceArn: latestSnapshot.DBSnapshotArn!,
    S3BucketName: s3BucketName,
    S3Prefix: `${s3Prefix}/`,
    IamRoleArn: rdsExportRoleArn,
    KmsKeyId: kmsKeyId,
  }));

  console.log(`Export task started: ${exportResult.ExportTaskIdentifier}, status: ${exportResult.Status}`);
}
