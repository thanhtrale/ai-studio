/**
 * Kiểm tra service account có thật sự đọc/ghi được Firestore và Storage không.
 *
 *   node --env-file=.env scripts/check-cloud-credentials.mjs
 *
 * Mọi thứ nó tạo ra đều bị xoá ngay sau đó.
 */

import { readFileSync } from 'node:fs';

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const keyPath = process.env['AISTUDIO_FIREBASE_SERVICE_ACCOUNT'];
const bucketName = process.env['AISTUDIO_FIREBASE_STORAGE_BUCKET'];

if (!keyPath || !bucketName) {
  console.error('Thiếu AISTUDIO_FIREBASE_SERVICE_ACCOUNT hoặc AISTUDIO_FIREBASE_STORAGE_BUCKET');
  process.exit(1);
}

const app = initializeApp({
  credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))),
  storageBucket: bucketName,
});

const db = getFirestore(app);
const reference = db.doc('ai-studio/video/workers/_selftest');
await reference.set({ at: Date.now(), note: 'admin sdk reachability check' });
console.log('firestore ghi+đọc:', (await reference.get()).exists ? 'OK' : 'FAIL');
await reference.delete();
console.log('firestore xoá: OK');

const bucket = getStorage(app).bucket();
const [exists] = await bucket.exists();
console.log(`bucket ${bucket.name}:`, exists ? 'OK' : 'FAIL');

const file = bucket.file('ai-studio/logs/_selftest.txt');
await file.save('selftest', { contentType: 'text/plain' });
console.log('storage ghi: OK');
await file.delete();
console.log('storage xoá: OK');

process.exit(0);
