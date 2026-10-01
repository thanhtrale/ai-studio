import { JOBS_PATH, type CloudJobDoc } from '@ai-studio/cloud-contract';

import { cloudAdmin, hasCloudConfig } from '../../utils/cloud/admin';
import { cloudWorker } from '../../utils/cloud/worker';

/** Worker state plus the queue it is working from, for the local control page. */
export default defineEventHandler(async () => {
  const snapshot = cloudWorker().snapshot;
  if (!hasCloudConfig()) return { ...snapshot, configured: false, jobs: [] as CloudJobDoc[] };

  try {
    const { db } = cloudAdmin();
    const query = await db.collection(JOBS_PATH.join('/')).orderBy('createdAt', 'desc').limit(25).get();
    return { ...snapshot, jobs: query.docs.map((entry) => entry.data() as CloudJobDoc) };
  } catch (cause) {
    return {
      ...snapshot,
      jobs: [] as CloudJobDoc[],
      error: snapshot.error ?? (cause instanceof Error ? cause.message : String(cause)),
    };
  }
});
