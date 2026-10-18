import { removeFromGallery } from '../../../char3d/store';

/** Take a run (`?run=&set=`) out of the gallery. The run itself is kept. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  const query = getQuery(event);
  return {
    gallery: await removeFromGallery(config.storageDir, getRouterParam(event, 'id') ?? '', {
      run: query['run'],
      set: query['set'],
    }),
  };
});
