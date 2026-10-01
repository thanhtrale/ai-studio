import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Bucket } from '@google-cloud/storage';

const APP_NAME = 'ai-studio-cloud';

export interface CloudAdmin {
  db: Firestore;
  bucket: Bucket;
  bucketName: string;
}

export class CloudConfigError extends Error {}

/**
 * The worker authenticates as a service account rather than as a user.
 *
 * That means it bypasses the Firestore and Storage rules entirely, which is the
 * point: the rules exist to constrain browsers, and the worker is the only thing
 * allowed to move a job past `queued`.
 */
export function cloudAdmin(): CloudAdmin {
  const keyPath = process.env['AISTUDIO_FIREBASE_SERVICE_ACCOUNT'];
  const bucketName = process.env['AISTUDIO_FIREBASE_STORAGE_BUCKET'];

  if (!keyPath) {
    throw new CloudConfigError('AISTUDIO_FIREBASE_SERVICE_ACCOUNT chưa được đặt trong .env');
  }
  if (!bucketName) {
    throw new CloudConfigError('AISTUDIO_FIREBASE_STORAGE_BUCKET chưa được đặt trong .env');
  }

  const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);
  if (!existsSync(resolved)) {
    throw new CloudConfigError(`Không tìm thấy service account tại ${resolved}`);
  }

  const existing = getApps().find((entry) => entry.name === APP_NAME);
  const app: App =
    existing ??
    initializeApp(
      {
        credential: cert(JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, string>),
        storageBucket: bucketName,
      },
      APP_NAME,
    );

  return {
    db: getFirestore(app),
    bucket: getStorage(app).bucket(bucketName),
    bucketName,
  };
}

export function hasCloudConfig(): boolean {
  return Boolean(process.env['AISTUDIO_FIREBASE_SERVICE_ACCOUNT'] && process.env['AISTUDIO_FIREBASE_STORAGE_BUCKET']);
}

export function cloudAppName(): string {
  return getApps().some((entry) => entry.name === APP_NAME) ? getApp(APP_NAME).name : APP_NAME;
}
