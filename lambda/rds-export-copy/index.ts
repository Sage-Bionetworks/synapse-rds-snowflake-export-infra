import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { RDSClient, DescribeExportTasksCommand } from '@aws-sdk/client-rds';

const s3 = new S3Client({});
const rds = new RDSClient({});

const MAX_PARTS = 5000;
const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const MULTIPART_CHUNK = 512 * 1024 * 1024;
const COPY_CONCURRENCY = 10;
const MULTIPART_CONCURRENCY = 5;

interface RdsSnapshotEvent {
  resources?: string[];
  detail?: {
    SourceArn?: string;
    SourceIdentifier?: string;
    EventID?: string;
    Message?: string;
  };
}

export async function handler(event: RdsSnapshotEvent): Promise<void> {
  const sourceBucket = process.env.SOURCE_BUCKET_NAME!;
  const sourcePrefix = trimSlashes(process.env.SOURCE_PREFIX!);
  const destBucket = process.env.DEST_BUCKET_NAME!;
  const destPrefix = trimSlashes(process.env.DEST_PREFIX!);
  const destKmsKeyArn = process.env.DEST_KMS_KEY_ARN!;

  console.log('Event:', JSON.stringify(event));

  const snapshotArn = event.detail?.SourceArn ?? event.resources?.[0];
  if (!snapshotArn) {
    console.warn('No SourceArn in event; nothing to do.');
    return;
  }

  const tasks = await rds.send(new DescribeExportTasksCommand({
    Filters: [{ Name: 'source-arn', Values: [snapshotArn] }],
  }));
  const task = tasks.ExportTasks?.find((t) =>
    t.Status === 'COMPLETE' &&
    t.S3Bucket === sourceBucket &&
    trimSlashes(t.S3Prefix ?? '') === sourcePrefix,
  );
  if (!task) {
    console.log(`No matching COMPLETE export task for ${snapshotArn} in ${sourceBucket}/${sourcePrefix}; ignoring.`);
    return;
  }

  const exportTaskId = task.ExportTaskIdentifier!;
  console.log(`Processing export task: ${exportTaskId}`);

  const idMatch = exportTaskId.match(/^(?<env>[a-z]+)-(?<stackInstance>\d+)-db-(?<date>\d{4}-\d{2}-\d{2})$/);
  if (!idMatch || !idMatch.groups) {
    throw new Error(`ExportTaskIdentifier "${exportTaskId}" does not match <env>-<stackInstance>-db-YYYY-MM-DD.`);
  }
  const { stackInstance, date } = idMatch.groups;

  const sourceRoot = `${sourcePrefix}/${exportTaskId}/`;
  const keys = await listParquetKeys(sourceBucket, sourceRoot);
  console.log(`Found ${keys.length} Parquet part(s) under ${sourceRoot}`);
  if (keys.length === 0) {
    console.warn('Nothing to copy; exiting.');
    return;
  }
  if (keys.length > MAX_PARTS) {
    throw new Error(`Part count ${keys.length} exceeds MAX_PARTS=${MAX_PARTS}; switch to Step Functions fan-out.`);
  }

  const errors: { srcKey: string; error: unknown }[] = [];
  await runWithConcurrency(keys, COPY_CONCURRENCY, async (srcKey) => {
    try {
      await copyOne(srcKey, sourceBucket, destBucket, destPrefix, stackInstance, date, destKmsKeyArn);
    } catch (e) {
      errors.push({ srcKey, error: e });
      console.error(`Copy failed for ${srcKey}:`, e);
    }
  });

  if (errors.length > 0) {
    const summary = errors.slice(0, 5)
      .map((e) => `${e.srcKey}: ${(e.error as Error)?.message ?? e.error}`)
      .join('; ');
    throw new Error(`${errors.length} object(s) failed to copy. First few: ${summary}`);
  }
  console.log(`Copied ${keys.length} part(s) successfully.`);
}

async function listParquetKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of page.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith('.parquet')) keys.push(obj.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function copyOne(
  srcKey: string,
  sourceBucket: string,
  destBucket: string,
  destPrefix: string,
  stackInstance: string,
  date: string,
  destKmsKeyArn: string,
): Promise<void> {
  // RDS export key shape: <prefix>/<exportTaskId>/<dbId>/<schema>.<table>/<n>/<part>.parquet
  const segments = srcKey.split('/');
  const schemaTableSeg = segments.find((s) => /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(s));
  if (!schemaTableSeg) {
    throw new Error(`Cannot derive table from key "${srcKey}"`);
  }
  const tableName = schemaTableSeg.split('.')[1].toUpperCase();
  const basename = segments[segments.length - 1];
  const destKey = `${destPrefix}/${tableName}/${stackInstance}/${date}/${basename}`;

  const srcHead = await s3.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: srcKey }));
  const srcSize = srcHead.ContentLength ?? 0;

  if (await destExistsWithSize(destBucket, destKey, srcSize)) {
    console.log(`Skip (exists, size matches): ${destKey}`);
    return;
  }

  // Keys produced by RDS export are simple ASCII (schema/table identifiers, part-NNNNN.parquet),
  // so no URL-encoding of slashes is needed for CopySource.
  const copySource = `/${sourceBucket}/${srcKey}`;

  if (srcSize <= FIVE_GIB) {
    await s3.send(new CopyObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      CopySource: copySource,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: destKmsKeyArn,
    }));
    console.log(`Copied ${srcKey} -> ${destKey} (${srcSize} bytes)`);
    return;
  }

  await multipartCopy(copySource, srcSize, destBucket, destKey, destKmsKeyArn);
  console.log(`Multipart copied ${srcKey} -> ${destKey} (${srcSize} bytes)`);
}

async function destExistsWithSize(bucket: string, key: string, expectedSize: number): Promise<boolean> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength === expectedSize;
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function multipartCopy(
  copySource: string,
  srcSize: number,
  destBucket: string,
  destKey: string,
  destKmsKeyArn: string,
): Promise<void> {
  const created = await s3.send(new CreateMultipartUploadCommand({
    Bucket: destBucket,
    Key: destKey,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: destKmsKeyArn,
  }));
  const uploadId = created.UploadId!;

  const ranges: { partNumber: number; start: number; end: number }[] = [];
  let partNumber = 1;
  for (let start = 0; start < srcSize; start += MULTIPART_CHUNK) {
    const end = Math.min(start + MULTIPART_CHUNK, srcSize) - 1;
    ranges.push({ partNumber, start, end });
    partNumber += 1;
  }

  try {
    const completedParts: { ETag: string; PartNumber: number }[] = [];
    await runWithConcurrency(ranges, MULTIPART_CONCURRENCY, async (r) => {
      const resp = await s3.send(new UploadPartCopyCommand({
        Bucket: destBucket,
        Key: destKey,
        UploadId: uploadId,
        PartNumber: r.partNumber,
        CopySource: copySource,
        CopySourceRange: `bytes=${r.start}-${r.end}`,
      }));
      const etag = resp.CopyPartResult?.ETag;
      if (!etag) throw new Error(`UploadPartCopy returned no ETag for part ${r.partNumber}`);
      completedParts.push({ ETag: etag, PartNumber: r.partNumber });
    });

    completedParts.sort((a, b) => a.PartNumber - b.PartNumber);
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: destBucket,
      Key: destKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: completedParts },
    }));
  } catch (e) {
    try {
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: destBucket,
        Key: destKey,
        UploadId: uploadId,
      }));
    } catch (abortErr) {
      console.error('Failed to abort multipart upload after error:', abortErr);
    }
    throw e;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(next());
  await Promise.all(workers);
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}
