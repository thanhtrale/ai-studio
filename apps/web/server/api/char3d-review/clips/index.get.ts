import { clipLibrary } from '../../../char3d/review';

/** The Mixamo clip library's index. Empty until `cliplib.py` has built it. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  return clipLibrary(config.storageDir);
});
