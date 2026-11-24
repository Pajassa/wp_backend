import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import "dotenv/config";

const env = (k: string) => (process.env[k] || "").trim();

const bucket = env("AWS_S3_BUCKET");
const region = env("AWS_REGION") || "us-east-1";
const accessKeyId = env("AWS_ACCESS_KEY_ID");
const secretAccessKey = env("AWS_SECRET_ACCESS_KEY");
const cdnDomain = env("CLOUDFRONT_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const cdnPublicUrl = env("CLOUDFRONT_PUBLIC_URL").replace(/\/+$/, "");
const folder = (env("AWS_S3_FOLDER") || "uploads/wp-media").replace(/^\/+|\/+$/g, "");

/** S3 is used when a bucket is set. Credentials come from env keys, or the default AWS chain (IAM role). */
export const s3Enabled = !!bucket && (!accessKeyId || !!secretAccessKey);

const client = s3Enabled
  ? new S3Client({
      region,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    })
  : null;

export function s3Key(filename: string) {
  return `${folder}/${filename}`;
}

/** Public URL for an object: CloudFront when configured, direct S3 URL otherwise. */
export function publicUrl(key: string) {
  if (cdnPublicUrl) return `${cdnPublicUrl}/${key}`;
  if (cdnDomain) return `https://${cdnDomain}/${key}`;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await client!.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

export async function deleteObject(key: string) {
  await client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function s3Status() {
  return { storage: s3Enabled ? "s3" : "local", bucket: s3Enabled ? bucket : null, region, cdn: cdnPublicUrl || cdnDomain || null, folder };
}
