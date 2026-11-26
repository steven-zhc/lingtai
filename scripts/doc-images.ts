/**
 * `pnpm images:upload | images:download | images:list` (#1469): syncs the images
 * under `doc/` with the R2 bucket. The logic is `apps/cli/src/doc-images.ts`;
 * this is the edge — the environment, the SDK, the one run, the exit code.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Effect } from 'effect'

import { BUCKET, COMMANDS, docRoot, nodeFs, run, type Command, type StoreFactory } from '../apps/cli/src/doc-images.ts'

const store: StoreFactory = (c) => {
  const client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  return {
    list: (token) =>
      client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token })).then((r) => ({
        objects: (r.Contents ?? []).flatMap((o) => (o.Key === undefined ? [] : [{ key: o.Key, etag: o.ETag }])),
        next: r.IsTruncated === true ? r.NextContinuationToken : undefined,
      })),
    put: (key, body, contentType) =>
      client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType })).then(() => undefined),
    get: (key) =>
      client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })).then((r) => r.Body?.transformToByteArray() ?? new Uint8Array()),
  }
}

const command = process.argv[2] as Command
if (!COMMANDS.includes(command)) {
  console.error(`usage: node scripts/doc-images.ts ${COMMANDS.join('|')}`)
  process.exitCode = 2
} else {
  process.exitCode = await Effect.runPromise(
    run(command, { env: process.env, store, fs: nodeFs(docRoot()) }).pipe(
      Effect.match({
        onFailure: (e) => {
          console.error(e.message)
          return 1
        },
        onSuccess: (r) => {
          console.log(r.lines.join('\n'))
          return r.failed > 0 ? 1 : 0
        },
      }),
    ),
  )
}
